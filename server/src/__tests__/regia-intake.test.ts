import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  builtInManagedResources,
  companies,
  companySecrets,
  companySecretBindings,
  companySecretVersions,
  createDb,
  environments,
  environmentLeases,
  goals,
  issueCreateIdempotencyKeys,
  issues,
  projectGoals,
  projectWorkspaces,
  projects,
  userSecretDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertRegiaIntakeExecutionBinding, regiaIntakeService } from "../services/regia-intake.js";

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
    await db.delete(environmentLeases);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(projectGoals);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
    await db.delete(builtInManagedResources);
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
    await db.insert(companySecretVersions).values({
      secretId: SECRET_ID,
      version: 1,
      material: { encrypted: "test-only" },
      valueSha256: "a".repeat(64),
      fingerprintSha256: "b".repeat(64),
      status: "current",
    });
    await db.insert(companySecretBindings).values({
      companyId: COMPANY_A,
      secretId: SECRET_ID,
      targetType: "environment",
      targetId: ENVIRONMENT_ID,
      configPath: "credentials.regia",
      versionSelector: "latest",
      required: true,
    });
    await db.insert(builtInManagedResources).values({
      companyId: COMPANY_A,
      bundleKey: "regia-test",
      resourceKind: "environment",
      resourceKey: "regia-sandbox",
      resourceId: ENVIRONMENT_ID,
      stockVersion: "1",
      stockHash: "test",
      defaultsJson: {},
    });
  }

  const request = {
    idempotencyKey: "board:objective:001",
    objective: "Porta Team/Regia al completamento verificabile",
    binding: {
      regiaAgentId: REGIA_ID,
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
      policyConfigured: false,
      blockingGate: "policy_configuration_required",
    });
    expect(second).toEqual({ ...first, created: false });
    const [rootTask] = await db.select().from(issues).where(eq(issues.id, first.rootTaskId));
    expect(rootTask).toMatchObject({
      companyId: COMPANY_A,
      projectId: PROJECT_ID,
      projectWorkspaceId: WORKSPACE_ID,
      assigneeAgentId: REGIA_ID,
      reviewPolicy: "not_creator",
      status: "blocked",
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

  it("fails closed for cross-company or non-executive explicit Regia identities", async () => {
    await seed();
    const service = regiaIntakeService(db);
    await expect(service.accept(COMPANY_B, request, { actorType: "user", actorId: "cristian" }))
      .rejects.toThrow("explicit Regia/Fleet Director");

    await db.insert(agents).values({
      companyId: COMPANY_A,
      name: "Regia",
      role: "general",
      status: "active",
      defaultEnvironmentId: ENVIRONMENT_ID,
    });
    const nonExecutive = await db.insert(agents).values({
      companyId: COMPANY_A,
      name: "Generic worker",
      role: "engineer",
      status: "active",
      defaultEnvironmentId: ENVIRONMENT_ID,
    }).returning({ id: agents.id }).then((rows) => rows[0]!);
    await expect(service.accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:objective:002",
      binding: { ...request.binding, regiaAgentId: nonExecutive.id },
    }, {
      actorType: "user",
      actorId: "cristian",
    })).rejects.toThrow("explicit Regia/Fleet Director");
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("accepts an explicit root Fleet Director deterministically when another executive exists", async () => {
    await seed();
    await db.update(agents).set({
      name: "Fleet Director",
      role: "executive",
      title: "Director PMO & Control Room",
      metadata: { catalogRoleKey: "fleet_director" },
    }).where(eq(agents.id, REGIA_ID));
    await db.insert(agents).values({
      companyId: COMPANY_A,
      name: "Another executive",
      role: "executive",
      status: "active",
      defaultEnvironmentId: ENVIRONMENT_ID,
    });
    const result = await regiaIntakeService(db).accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:fleet-director:001",
    }, { actorType: "user", actorId: "cristian" });
    expect(result.regiaAgentId).toBe(REGIA_ID);
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

  it("rejects nonexistent secret versions and PII/credential-bearing context before persistence", async () => {
    await seed();
    const service = regiaIntakeService(db);
    await db.update(companySecretBindings).set({ versionSelector: "999999" })
      .where(and(
        eq(companySecretBindings.secretId, SECRET_ID),
        eq(companySecretBindings.targetId, ENVIRONMENT_ID),
      ));
    await expect(service.accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:objective:004",
      binding: {
        ...request.binding,
        credentialSecretRef: { ...request.binding.credentialSecretRef, version: 999_999 },
      },
    }, { actorType: "user", actorId: "cristian" })).rejects.toThrow("Secret version not found");

    const unsafeValues = [
      "cristian@example.com",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
      "sk-proj-1234567890abcdefghijklmnop",
      "abcdefghijklmnopqrstuvwxyz0123456789_RAW",
      "+39 333 123 4567",
    ];
    for (const [index, unsafe] of unsafeValues.entries()) {
      await expect(service.accept(COMPANY_A, {
        ...request,
        idempotencyKey: `board:unsafe:${index}`,
        objective: unsafe,
      }, { actorType: "user", actorId: "cristian" })).rejects.toThrow("must not contain PII or credential");
    }
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("requires a same-company secret binding to the selected environment", async () => {
    await seed();
    const service = regiaIntakeService(db);
    await db.delete(companySecretBindings);
    await expect(service.accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:binding:missing",
    }, { actorType: "user", actorId: "cristian" })).rejects.toThrow("not bound to the selected environment");

    await db.insert(companySecretBindings).values({
      companyId: COMPANY_A,
      secretId: SECRET_ID,
      targetType: "environment",
      targetId: "99999999-9999-4999-8999-999999999999",
      configPath: "credentials.regia",
      versionSelector: "latest",
      required: true,
    });
    await expect(service.accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:binding:wrong-environment",
    }, { actorType: "user", actorId: "cristian" })).rejects.toThrow("not bound to the selected environment");
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("uses native secret validation for company scope, active version and exact config path", async () => {
    await seed();
    const service = regiaIntakeService(db);

    await db.update(companySecretVersions).set({ status: "disabled" })
      .where(eq(companySecretVersions.secretId, SECRET_ID));
    await expect(service.accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:secret:disabled",
    }, { actorType: "user", actorId: "cristian" })).rejects.toThrow("Secret version is not active");

    await db.update(companySecretVersions).set({ status: "current" })
      .where(eq(companySecretVersions.secretId, SECRET_ID));
    const definitionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await db.insert(userSecretDefinitions).values({
      id: definitionId,
      companyId: COMPANY_A,
      key: "REGIA_USER_CREDENTIAL",
      name: "Regia user credential",
    });
    await db.update(companySecrets).set({
      scope: "user",
      ownerUserId: "cristian",
      userSecretDefinitionId: definitionId,
    }).where(eq(companySecrets.id, SECRET_ID));
    await expect(service.accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:secret:user-scope",
    }, { actorType: "user", actorId: "cristian" })).rejects.toThrow("company-scoped");

    await db.update(companySecrets).set({
      scope: "company",
      ownerUserId: null,
      userSecretDefinitionId: null,
    }).where(eq(companySecrets.id, SECRET_ID));
    await db.insert(companySecretBindings).values({
      companyId: COMPANY_A,
      secretId: SECRET_ID,
      targetType: "environment",
      targetId: ENVIRONMENT_ID,
      configPath: "credentials.regia.duplicate",
      versionSelector: "latest",
      required: true,
    });
    await expect(service.accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:secret:ambiguous-config-path",
    }, { actorType: "user", actorId: "cristian" })).rejects.toThrow("exactly once");
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("guards Regia execution against omitted, unbound and cross-company environment claims with no effects", async () => {
    await seed();
    const intake = await regiaIntakeService(db).accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:execution-binding:001",
    }, { actorType: "user", actorId: "cristian" });
    const common = {
      companyId: COMPANY_A,
      issueId: intake.rootTaskId,
      selectedEnvironmentId: ENVIRONMENT_ID,
    };
    await expect(assertRegiaIntakeExecutionBinding(db, common))
      .rejects.toThrow("explicit company-binding enforcement");
    await expect(assertRegiaIntakeExecutionBinding(db, { ...common, assertCompanyBinding: true }))
      .resolves.toBeUndefined();

    await db.update(companySecretBindings).set({ configPath: "credentials.regia.changed" })
      .where(and(
        eq(companySecretBindings.secretId, SECRET_ID),
        eq(companySecretBindings.targetId, ENVIRONMENT_ID),
      ));
    await expect(assertRegiaIntakeExecutionBinding(db, { ...common, assertCompanyBinding: true }))
      .rejects.toThrow("exactly once");
    await db.update(companySecretBindings).set({ configPath: "credentials.regia" })
      .where(and(
        eq(companySecretBindings.secretId, SECRET_ID),
        eq(companySecretBindings.targetId, ENVIRONMENT_ID),
      ));

    await db.delete(builtInManagedResources);
    await expect(assertRegiaIntakeExecutionBinding(db, { ...common, assertCompanyBinding: true }))
      .rejects.toThrow("unbound, ambiguous, or cross-company");
    await db.insert(builtInManagedResources).values({
      companyId: COMPANY_B,
      bundleKey: "foreign-regia-test",
      resourceKind: "environment",
      resourceKey: "foreign-regia-sandbox",
      resourceId: ENVIRONMENT_ID,
      stockVersion: "1",
      stockHash: "foreign-test",
      defaultsJson: {},
    });
    await expect(assertRegiaIntakeExecutionBinding(db, { ...common, assertCompanyBinding: true }))
      .rejects.toThrow("unbound, ambiguous, or cross-company");
    expect(await db.select().from(environmentLeases)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });
});
