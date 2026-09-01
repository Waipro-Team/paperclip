import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companySecrets,
  createDb,
  environments,
  goals,
  issueCreateIdempotencyKeys,
  issues,
  projectGoals,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { regiaIntakeService } from "../services/regia-intake.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const ENVIRONMENT_ID = "33333333-3333-4333-8333-333333333333";
const REGIA_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
const SECRET_ID = "77777777-7777-4777-8777-777777777777";

describePg("regiaIntakeService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-regia-intake-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(projectGoals);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(environments);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    await db.insert(companies).values([
      { id: COMPANY_A, name: "Company A", issuePrefix: "A" },
      { id: COMPANY_B, name: "Company B", issuePrefix: "B" },
    ]);
    await db.insert(environments).values({
      id: ENVIRONMENT_ID,
      name: "Regia intake isolated environment",
      driver: "sandbox",
      status: "active",
    });
    await db.insert(agents).values({
      id: REGIA_ID,
      companyId: COMPANY_A,
      name: "Regia",
      role: "ceo",
      status: "idle",
      defaultEnvironmentId: ENVIRONMENT_ID,
    });
    await db.insert(projects).values({
      id: PROJECT_ID,
      companyId: COMPANY_A,
      name: "Portal360",
      status: "in_progress",
      leadAgentId: REGIA_ID,
      executionWorkspacePolicy: { environmentId: ENVIRONMENT_ID },
    });
    await db.insert(projectWorkspaces).values({
      id: WORKSPACE_ID,
      companyId: COMPANY_A,
      projectId: PROJECT_ID,
      name: "canonical",
      sourceType: "git_repo",
      isPrimary: true,
    });
    await db.insert(companySecrets).values({
      id: SECRET_ID,
      companyId: COMPANY_A,
      key: "REGIA_CREDENTIAL",
      name: "Regia credential",
      status: "active",
    });
  }

  const request = {
    idempotencyKey: "board:objective:001",
    objective: "Porta Team/Regia al completamento verificabile",
    binding: {
      projectId: PROJECT_ID,
      projectWorkspaceId: WORKSPACE_ID,
      environmentId: ENVIRONMENT_ID,
      credentialSecretRef: { type: "secret_ref" as const, secretId: SECRET_ID, version: "latest" as const },
    },
    constraints: ["Nessun deploy live"],
    budgetEnvelope: { currency: "EUR", maxAmountCents: 10_000, period: "one_time" as const },
    kpis: [{ name: "receipt", target: "presente" }],
    gates: [{ name: "deploy", requiresBoardApproval: true }],
  };

  it("creates one company-scoped root task, receipt and no wake, then reuses all ids", async () => {
    await seed();
    const service = regiaIntakeService(db);
    const first = await service.accept(COMPANY_A, request, { actorType: "user", actorId: "cristian" });
    const second = await service.accept(COMPANY_A, request, { actorType: "user", actorId: "cristian" });

    expect(first).toMatchObject({
      companyId: COMPANY_A,
      projectId: PROJECT_ID,
      regiaAgentId: REGIA_ID,
      reviewPolicy: "not_creator",
      created: true,
      executionAuthorized: false,
    });
    expect(second).toEqual({ ...first, created: false });
    const [rootTask] = await db.select().from(issues).where(eq(issues.id, first.rootTaskId));
    expect(rootTask).toMatchObject({
      companyId: COMPANY_A,
      projectId: PROJECT_ID,
      projectWorkspaceId: WORKSPACE_ID,
      assigneeAgentId: REGIA_ID,
      reviewPolicy: "not_creator",
      status: "todo",
    });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, COMPANY_A),
      eq(activityLog.action, "regia.intake.accepted"),
    ))).toHaveLength(1);
    expect(await db.select().from(projectGoals).where(and(
      eq(projectGoals.companyId, COMPANY_A),
      eq(projectGoals.projectId, PROJECT_ID),
      eq(projectGoals.goalId, first.goalId),
    ))).toHaveLength(1);
    const changedRequest = { ...request, objective: "Un altro obiettivo con la stessa chiave" };
    await expect(service.accept(COMPANY_A, changedRequest, { actorType: "user", actorId: "cristian" }))
      .rejects.toThrow("different Regia intake request");
  });

  it("fails closed for cross-company binding and ambiguous Regia identities", async () => {
    await seed();
    const service = regiaIntakeService(db);
    await expect(service.accept(COMPANY_B, request, { actorType: "user", actorId: "cristian" }))
      .rejects.toThrow("exactly one invokable Regia/CEO");

    await db.insert(agents).values({
      companyId: COMPANY_A,
      name: "Regia",
      role: "general",
      status: "active",
      defaultEnvironmentId: ENVIRONMENT_ID,
    });
    await expect(service.accept(COMPANY_A, { ...request, idempotencyKey: "board:objective:002" }, {
      actorType: "user",
      actorId: "cristian",
    })).rejects.toThrow("assignment is ambiguous");
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("rejects a missing or mismatched machine binding before creating work", async () => {
    await seed();
    await expect(regiaIntakeService(db).accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:objective:003",
      binding: { ...request.binding, projectWorkspaceId: "88888888-8888-4888-8888-888888888888" },
    }, { actorType: "user", actorId: "cristian" })).rejects.toThrow("binding is missing");
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });
});
