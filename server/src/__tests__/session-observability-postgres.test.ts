import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { sessionObservabilityService } from "../services/session-observability.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping session observability Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("session observability query (postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-session-observability-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("keeps active runs visible after the 30-day historical cutoff and company-scoped", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Visible Company", issuePrefix: `VO${randomUUID().slice(0, 5).toUpperCase()}` },
      { id: otherCompanyId, name: "Other Company", issuePrefix: `OO${randomUUID().slice(0, 5).toUpperCase()}` },
    ]);

    const activeAgents = [
      { id: randomUUID(), status: "running", expectedPhase: "executing" },
      { id: randomUUID(), status: "queued", expectedPhase: "queued" },
      { id: randomUUID(), status: "scheduled_retry", expectedPhase: "queued" },
    ] as const;
    const otherAgentId = randomUUID();
    await db.insert(agents).values([
      ...activeAgents.map((agent) => ({
        id: agent.id,
        companyId,
        name: `Visible ${agent.status}`,
        role: "engineer",
        status: "idle",
      })),
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "PRIVATE OTHER COMPANY AGENT",
        role: "engineer",
        status: "idle",
      },
    ]);

    const oldActiveAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000);
    const recentTerminalAt = new Date(Date.now() - 60 * 60 * 1_000);
    await db.insert(heartbeatRuns).values([
      ...activeAgents.flatMap((agent) => ([
        {
          companyId,
          agentId: agent.id,
          status: agent.status,
          startedAt: oldActiveAt,
          createdAt: oldActiveAt,
          updatedAt: oldActiveAt,
        },
        {
          companyId,
          agentId: agent.id,
          status: "succeeded",
          startedAt: recentTerminalAt,
          finishedAt: recentTerminalAt,
          createdAt: recentTerminalAt,
          updatedAt: recentTerminalAt,
        },
      ])),
      {
        companyId: otherCompanyId,
        agentId: otherAgentId,
        status: "running",
        startedAt: oldActiveAt,
        createdAt: oldActiveAt,
        updatedAt: oldActiveAt,
      },
    ]);

    const result = await sessionObservabilityService(db).read(companyId);

    expect(result.nodes).toHaveLength(activeAgents.length);
    for (const agent of activeAgents) {
      expect(result.nodes.find((node) => node.agent.id === agent.id)).toMatchObject({
        status: "running",
        phase: agent.expectedPhase,
      });
    }
    expect(JSON.stringify(result)).not.toContain("PRIVATE OTHER COMPANY AGENT");
    expect(result.privacy).toEqual({
      contentIncluded: false,
      humanIdentityIncluded: false,
      secretsIncluded: false,
    });
  });
});
