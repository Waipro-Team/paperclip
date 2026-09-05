import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
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
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("keeps active runs visible beyond 30 days and company-scoped", async () => {
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
    await db.insert(agentRuntimeState).values([
      {
        agentId: activeAgents[0].id,
        companyId,
        adapterType: "process",
        totalCostCents: 321,
      },
      {
        agentId: otherAgentId,
        companyId: otherCompanyId,
        adapterType: "process",
        totalCostCents: 999_999,
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
    expect(result.nodes.find((node) => node.agent.id === activeAgents[0].id)?.cost).toEqual({
      totalCostCents: 321,
    });
    expect(result.nodes.filter((node) => node.cost.totalCostCents === 999_999)).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("PRIVATE OTHER COMPANY AGENT");
    expect(result.privacy).toEqual({
      contentIncluded: false,
      humanIdentityIncluded: false,
      secretsIncluded: false,
    });
  });

  it("maps costs to the exact bounded visible-agent set when more than 500 agents exist", async () => {
    const companyId = randomUUID();
    const targetAgentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const targetCostCents = 654_321;
    const idleAgentIds = Array.from({ length: 500 }, (_, index) => (
      `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`
    ));

    await db.insert(companies).values({
      id: companyId,
      name: "Cost Boundary Company",
      issuePrefix: `CB${randomUUID().slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values([
      {
        id: targetAgentId,
        companyId,
        name: "Visible active boundary agent",
        role: "engineer",
        status: "active",
      },
      ...idleAgentIds.map((id, index) => ({
        id,
        companyId,
        name: `Idle boundary agent ${index + 1}`,
        role: "engineer",
        status: "idle",
      })),
    ]);
    await db.insert(agentRuntimeState).values([
      {
        agentId: targetAgentId,
        companyId,
        adapterType: "process",
        totalCostCents: targetCostCents,
      },
      ...idleAgentIds.map((agentId, index) => ({
        agentId,
        companyId,
        adapterType: "process",
        totalCostCents: index + 1,
      })),
    ]);

    const result = await sessionObservabilityService(db).read(companyId);

    expect(result.nodes).toHaveLength(500);
    expect(result.nodes.find((node) => node.agent.id === targetAgentId)?.cost).toEqual({
      totalCostCents: targetCostCents,
    });
    expect(result.nodes.some((node) => node.agent.id === idleAgentIds[499])).toBe(false);
    for (const node of result.nodes) {
      const expectedCost = node.agent.id === targetAgentId
        ? targetCostCents
        : idleAgentIds.indexOf(node.agent.id) + 1;
      expect(node.cost.totalCostCents).toBe(expectedCost);
    }
  });

  it("returns bounded historical event, handoff, receipt, and non-terminal task states", async () => {
    const companyId = randomUUID();
    const authorAgentId = randomUUID();
    const todoAgentId = randomUUID();
    const blockedAgentId = randomUUID();
    const reviewAgentId = randomUUID();
    const todoIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const reviewIssueId = randomUUID();
    const commentId = randomUUID();
    const runId = randomUUID();
    const historicalAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Historical Company",
      issuePrefix: `HI${randomUUID().slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values([
      { id: authorAgentId, companyId, name: "Author", role: "engineer", status: "idle" },
      { id: todoAgentId, companyId, name: "Todo", role: "engineer", status: "idle" },
      { id: blockedAgentId, companyId, name: "Blocked", role: "engineer", status: "idle" },
      { id: reviewAgentId, companyId, name: "Review", role: "engineer", status: "idle" },
    ]);
    await db.insert(issues).values([
      {
        id: todoIssueId,
        companyId,
        title: "Todo task",
        identifier: `HIS-${randomUUID().slice(0, 6)}`,
        status: "todo",
        assigneeAgentId: todoAgentId,
        createdAt: historicalAt,
        updatedAt: historicalAt,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked task",
        identifier: `HIS-${randomUUID().slice(0, 6)}`,
        status: "blocked",
        assigneeAgentId: blockedAgentId,
        createdAt: historicalAt,
        updatedAt: historicalAt,
      },
      {
        id: reviewIssueId,
        companyId,
        title: "Review task",
        identifier: `HIS-${randomUUID().slice(0, 6)}`,
        status: "in_review",
        assigneeAgentId: reviewAgentId,
        createdAt: historicalAt,
        updatedAt: historicalAt,
      },
    ]);
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: todoIssueId,
      authorAgentId,
      body: "PRIVATE HISTORICAL CONTENT",
      createdAt: historicalAt,
      updatedAt: historicalAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: todoAgentId,
      status: "succeeded",
      contextSnapshot: { issueId: todoIssueId, commentId },
      startedAt: historicalAt,
      finishedAt: historicalAt,
      createdAt: historicalAt,
      updatedAt: historicalAt,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId: todoAgentId,
      seq: 1,
      eventType: "turn.completed",
      message: "PRIVATE HISTORICAL EVENT CONTENT",
      createdAt: historicalAt,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: blockedAgentId,
      agentId: blockedAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: blockedIssueId,
      createdAt: historicalAt,
    });

    const result = await sessionObservabilityService(db).read(companyId);

    expect(result.nodes.find((node) => node.agent.id === todoAgentId)).toMatchObject({
      phase: "queued",
      issue: { id: todoIssueId, status: "todo" },
      lastEvent: { source: "heartbeat_event", action: "turn.completed" },
      handoff: {
        kind: "comment",
        from: { id: authorAgentId },
        receiptId: commentId,
        receiptState: "acknowledged",
        runId,
      },
      lastReceipt: {
        id: commentId,
        from: { id: authorAgentId },
        to: { id: todoAgentId },
        state: "acknowledged",
        runId,
      },
    });
    expect(result.nodes.find((node) => node.agent.id === blockedAgentId)).toMatchObject({
      status: "blocked",
      phase: "blocked",
      issue: { id: blockedIssueId, status: "blocked" },
      lastEvent: { source: "activity", action: "issue.updated" },
    });
    expect(result.nodes.find((node) => node.agent.id === reviewAgentId)).toMatchObject({
      phase: "review",
      issue: { id: reviewIssueId, status: "in_review" },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE HISTORICAL");
  });
});
