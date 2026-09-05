import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  approvals,
  builtInManagedResources,
  companies,
  companySecrets,
  companySecretBindings,
  companySecretVersions,
  createDb,
  environments,
  environmentLeases,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  issueCreateIdempotencyKeys,
  issueApprovals,
  issues,
  projectGoals,
  projectWorkspaces,
  projects,
  userSecretDefinitions,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertRegiaIntakeExecutionBinding, regiaIntakeService } from "../services/regia-intake.js";
import { heartbeatService } from "../services/heartbeat.js";
import { approvalService } from "../services/approvals.js";

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
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issueApprovals);
    await db.delete(approvals);
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
      metadata: { catalogRoleKey: "director_pmo_control_room" },
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

  async function approveRegiaExecution(issueId: string) {
    const [approval] = await db.select({ id: approvals.id })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(and(
        eq(issueApprovals.companyId, COMPANY_A),
        eq(issueApprovals.issueId, issueId),
        eq(approvals.type, "regia_execution_policy"),
      ));
    expect(approval).toBeDefined();
    const result = await approvalService(db).approve(approval!.id, "cristian", "Approved for execution");
    expect(result).toMatchObject({ applied: true, approval: { status: "approved" } });
    return approval!.id;
  }


  // Snapshot domain state (never credential material); auth last-used timestamps
  // belong to middleware and are deliberately outside the preflight service.
  async function domainSnapshot() {
    const tables = [activityLog, agentWakeupRequests, approvals, environmentLeases, goals,
      heartbeatRuns, issueCreateIdempotencyKeys, issueApprovals, issues, projectGoals, secretAccessEvents];
    return {
      tables: await Promise.all(tables.map((table) => db.select().from(table))),
      companies: await db.select({ id: companies.id, counter: companies.issueCounter }).from(companies),
      projects: await db.select({ id: projects.id, goalId: projects.goalId, updatedAt: projects.updatedAt }).from(projects),
      secrets: await db.select({
        id: companySecrets.id, lastResolvedAt: companySecrets.lastResolvedAt, updatedAt: companySecrets.updatedAt,
      }).from(companySecrets),
    };
  }

  it("preflights with actual PostgreSQL READ ONLY and metadata-only column permissions", async () => {
    await seed();
    const before = await domainSnapshot();
    // A fresh fixture role cannot select material, provider metadata, or any
    // domain write. Successful real queries therefore prove column projections.
    await db.execute(sql`create role intake_preflight_metadata nologin`);
    await db.execute(sql`grant usage on schema public to intake_preflight_metadata`);
    await db.execute(sql`grant select on agents, projects, project_workspaces, environments,
      company_secret_bindings to intake_preflight_metadata`);
    await db.execute(sql`grant select(id, company_id, scope, status, deleted_at, latest_version)
      on company_secrets to intake_preflight_metadata`);
    await db.execute(sql`grant select(secret_id, version, status, revoked_at)
      on company_secret_versions to intake_preflight_metadata`);
    const transact = db.transaction.bind(db);
    const settings: unknown[] = [];
    const spy = vi.spyOn(db, "transaction").mockImplementation((callback, options) =>
      transact(async (tx) => {
        await tx.execute(sql`set local role intake_preflight_metadata`);
        const [state] = await tx.execute(sql`select current_setting('transaction_isolation') as isolation,
          current_setting('transaction_read_only') as read_only`);
        settings.push(state);
        return callback(tx);
      }, options));
    try {
      const result = await regiaIntakeService(db).preflight(COMPANY_A, { binding: request.binding });
      expect(result).toEqual(request.binding);
      expect(settings).toEqual([{ isolation: "repeatable read", read_only: "on" }]);
      expect(await domainSnapshot()).toEqual(before);
      // The grant really denies selecting the encrypted material, independently
      // of the preflight's query shape.
      await expect(transact(async (tx) => {
        await tx.execute(sql`set local role intake_preflight_metadata`);
        await tx.execute(sql`select material from company_secret_versions`);
      })).rejects.toThrow();
    } finally {
      spy.mockRestore();
      await db.execute(sql`drop owned by intake_preflight_metadata`);
      await db.execute(sql`drop role intake_preflight_metadata`);
    }
  });

  it("keeps a repeatable snapshot and revalidates a later accept instead of trusting preflight", async () => {
    await seed();
    const transact = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementation((callback, options) =>
      transact(async (tx) => {
        // Start the real snapshot, then change current state on a different connection.
        await tx.select({ id: projects.id }).from(projects);
        await db.update(projects).set({ executionWorkspacePolicy: {} }).where(eq(projects.id, PROJECT_ID));
        return callback(tx);
      }, options));
    await expect(regiaIntakeService(db).preflight(COMPANY_A, { binding: request.binding }))
      .resolves.toEqual(request.binding);
    spy.mockRestore();
    const before = await domainSnapshot();
    await expect(regiaIntakeService(db).accept(COMPANY_A, request, { actorType: "user", actorId: "cristian" }))
      .rejects.toThrow("not pinned");
    expect(await domainSnapshot()).toEqual(before);
    await expect(regiaIntakeService(db).preflight(COMPANY_A, { binding: request.binding }))
      .rejects.toThrow("not pinned");
  });

  it("preflight approval grants no execution and subsequent intake still creates a blocked task", async () => {
    await seed();
    const service = regiaIntakeService(db);
    const before = await domainSnapshot();
    await service.preflight(COMPANY_A, { binding: request.binding });
    expect(await domainSnapshot()).toEqual(before);
    const result = await service.accept(COMPANY_A, request, { actorType: "user", actorId: "cristian" });
    expect(result).toMatchObject({ executionAuthorized: false, policyConfigured: false, approvalStatus: "pending" });
    await expect(assertRegiaIntakeExecutionBinding(db, {
      companyId: COMPANY_A, issueId: result.rootTaskId,
      selectedEnvironmentId: ENVIRONMENT_ID, assertCompanyBinding: true,
    })).rejects.toThrow("policy is not configured");
    expect(await db.select().from(agentWakeupRequests)).toEqual([]);
    expect(await db.select().from(environmentLeases)).toEqual([]);
  });

  it.each([
    "foreign company", "project tenant", "workspace tenant", "workspace project", "non-root agent",
    "catalog mismatch", "paused agent", "environment inactive", "project environment", "agent environment",
    "secret tenant", "secret inactive", "secret deleted", "secret binding", "missing version",
    "disabled version", "revoked version", "static lease gate",
  ])("preflight rejects %s without domain mutations", async (scenario) => {
    await seed();
    switch (scenario) {
      case "project tenant": await db.update(projects).set({ companyId: COMPANY_B }); break;
      case "workspace tenant": await db.update(projectWorkspaces).set({ companyId: COMPANY_B }); break;
      case "workspace project": {
        const [other] = await db.insert(projects).values({ companyId: COMPANY_A, name: "Other" }).returning();
        await db.update(projectWorkspaces).set({ projectId: other!.id }); break;
      }
      case "non-root agent": {
        const [other] = await db.insert(agents).values({ companyId: COMPANY_A, name: "Parent", role: "ceo" }).returning();
        await db.update(agents).set({ reportsTo: other!.id }).where(eq(agents.id, REGIA_ID)); break;
      }
      case "catalog mismatch": await db.update(agents).set({ metadata: { catalogRoleKey: "engineer" } }); break;
      case "paused agent": await db.update(agents).set({ status: "paused" }); break;
      case "environment inactive": await db.update(environments).set({ status: "disabled" }); break;
      case "project environment": await db.update(projects).set({ executionWorkspacePolicy: {} }); break;
      case "agent environment": await db.update(agents).set({ defaultEnvironmentId: null }); break;
      case "secret tenant": await db.update(companySecrets).set({ companyId: COMPANY_B }); break;
      case "secret inactive": await db.update(companySecrets).set({ status: "disabled" }); break;
      case "secret deleted": await db.update(companySecrets).set({ deletedAt: new Date() }); break;
      case "secret binding": await db.delete(companySecretBindings); break;
      case "missing version": await db.update(companySecrets).set({ latestVersion: 2 }); break;
      case "disabled version": await db.update(companySecretVersions).set({ status: "disabled" }); break;
      case "revoked version": await db.update(companySecretVersions).set({ revokedAt: new Date() }); break;
      case "static lease gate":
        await db.update(companySecretBindings).set({ projectionClass: "class_3_static_lease" }); break;
    }
    const before = await domainSnapshot();
    await expect(regiaIntakeService(db).preflight(scenario === "foreign company" ? COMPANY_B : COMPANY_A,
      { binding: request.binding })).rejects.toMatchObject({ status: 422 });
    expect(await domainSnapshot()).toEqual(before);
  });

  it("keeps an explicit secret version selector and denies a selector without an exact binding", async () => {
    await seed();
    const binding = { ...request.binding, credentialSecretRef: { ...request.binding.credentialSecretRef, version: 1 } };
    await expect(regiaIntakeService(db).preflight(COMPANY_A, { binding })).rejects.toThrow("exactly once");
    await db.update(companySecretBindings).set({ versionSelector: "1" });
    const before = await domainSnapshot();
    await expect(regiaIntakeService(db).preflight(COMPANY_A, { binding })).resolves.toEqual(binding);
    expect(await domainSnapshot()).toEqual(before);
  });

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
      approvalStatus: "pending",
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
    expect(await db.select().from(approvals).where(and(
      eq(approvals.companyId, COMPANY_A),
      eq(approvals.type, "regia_execution_policy"),
    ))).toHaveLength(1);
    expect(await db.select().from(issueApprovals).where(and(
      eq(issueApprovals.companyId, COMPANY_A),
      eq(issueApprovals.issueId, first.rootTaskId),
      eq(issueApprovals.approvalId, first.approvalId),
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
      .rejects.toThrow("canonical catalog identity");

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
    })).rejects.toThrow("canonical catalog identity");
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("rejects legacy names, generic PMO role classes and catalog key mismatches", async () => {
    await seed();
    const service = regiaIntakeService(db);
    const invalidMetadata: Array<Record<string, unknown> | null> = [
      null,
      { roleClass: "pmo" },
      { roleClass: "pmo", catalogRoleKey: "pmo" },
      { roleClass: "pmo", catalogRoleKey: "director pmo control room" },
      { roleClass: "pmo", catalogRoleKey: "director_pmo_control_room_legacy" },
    ];

    for (const [index, metadata] of invalidMetadata.entries()) {
      await db.update(agents).set({
        name: "Regia",
        role: "executive",
        title: "Director PMO & Control Room",
        metadata,
      }).where(eq(agents.id, REGIA_ID));
      await expect(service.accept(COMPANY_A, {
        ...request,
        idempotencyKey: `board:legacy-pmo:${index}`,
      }, { actorType: "user", actorId: "cristian" }))
        .rejects.toThrow("canonical catalog identity");
    }

    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
    expect(await db.select().from(approvals)).toHaveLength(0);
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
      .rejects.toThrow("policy is not configured and approved");
    await approveRegiaExecution(intake.rootTaskId);
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

  it("approves through the native service and unlocks only the matching intake receipt", async () => {
    await seed();
    const service = regiaIntakeService(db);
    const first = await service.accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:approval:first",
    }, { actorType: "user", actorId: "cristian" });
    const second = await service.accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:approval:second",
      objective: "Second distinct Regia objective",
    }, { actorType: "user", actorId: "cristian" });

    await approveRegiaExecution(first.rootTaskId);
    await expect(assertRegiaIntakeExecutionBinding(db, {
      companyId: COMPANY_A,
      issueId: first.rootTaskId,
      selectedEnvironmentId: ENVIRONMENT_ID,
      assertCompanyBinding: true,
    })).resolves.toBeUndefined();
    await expect(assertRegiaIntakeExecutionBinding(db, {
      companyId: COMPANY_A,
      issueId: second.rootTaskId,
      selectedEnvironmentId: ENVIRONMENT_ID,
      assertCompanyBinding: true,
    })).rejects.toThrow("policy is not configured and approved");

    const refreshed = await service.accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:approval:first",
    }, { actorType: "user", actorId: "cristian" });
    expect(refreshed).toMatchObject({
      created: false,
      approvalId: first.approvalId,
      approvalStatus: "approved",
      policyConfigured: true,
      executionAuthorized: true,
      blockingGate: null,
    });
  });

  it("keeps stale receipt digests pending and fail-closed", async () => {
    await seed();
    const intake = await regiaIntakeService(db).accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:approval:stale",
    }, { actorType: "user", actorId: "cristian" });
    const [receipt] = await db.select().from(activityLog).where(eq(activityLog.id, intake.receipt.activityId));
    await db.update(activityLog).set({
      details: { ...receipt!.details, bindingDigest: "0".repeat(64) },
    }).where(eq(activityLog.id, receipt!.id));

    await expect(approvalService(db).approve(intake.approvalId, "cristian"))
      .rejects.toThrow("no longer matches");
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, intake.approvalId));
    expect(approval!.status).toBe("pending");
    await expect(assertRegiaIntakeExecutionBinding(db, {
      companyId: COMPANY_A,
      issueId: intake.rootTaskId,
      selectedEnvironmentId: ENVIRONMENT_ID,
      assertCompanyBinding: true,
    })).rejects.toThrow("binding is missing or mismatched");
  });

  it("keeps reject, revision and cancel decisions fail-closed", async () => {
    await seed();
    const service = regiaIntakeService(db);
    const outcomes = [
      { key: "reject", decide: (id: string) => approvalService(db).reject(id, "cristian") },
      { key: "revision", decide: (id: string) => approvalService(db).requestRevision(id, "cristian") },
      { key: "cancel", decide: (id: string) => approvalService(db).cancel(id, "cancelled by board") },
    ];
    for (const outcome of outcomes) {
      const intake = await service.accept(COMPANY_A, {
        ...request,
        idempotencyKey: `board:approval:${outcome.key}`,
        objective: `Regia ${outcome.key} decision remains blocked`,
      }, { actorType: "user", actorId: "cristian" });
      await outcome.decide(intake.approvalId);
      await expect(assertRegiaIntakeExecutionBinding(db, {
        companyId: COMPANY_A,
        issueId: intake.rootTaskId,
        selectedEnvironmentId: ENVIRONMENT_ID,
        assertCompanyBinding: true,
      })).rejects.toThrow("policy is not configured and approved");
    }
    expect(await db.select().from(environmentLeases)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("blocks a valid-binding heartbeat while policy remains false with no recovery execution", async () => {
    await seed();
    const intake = await regiaIntakeService(db).accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:heartbeat-preflight:001",
    }, { actorType: "user", actorId: "cristian" });
    const acquireRunLease = vi.fn();
    const executeProvider = vi.fn();
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {},
      environmentRuntime: {
        acquireRunLease,
        execute: executeProvider,
        releaseRunLeases: vi.fn().mockResolvedValue([]),
      } as never,
    });
    const initialRun = await heartbeat.invoke(REGIA_ID, "on_demand", {
      issueId: intake.rootTaskId,
      taskId: intake.rootTaskId,
    }, "manual", { actorType: "user", actorId: "cristian" });
    expect(initialRun).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const [task] = await db.select({
      status: issues.status,
      executionRunId: issues.executionRunId,
    }).from(issues).where(eq(issues.id, intake.rootTaskId));
    const runs = await db.select().from(heartbeatRuns);
    const wakes = await db.select().from(agentWakeupRequests);
    expect(task).toEqual({ status: "blocked", executionRunId: null });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: initialRun!.id,
      status: "failed",
      retryOfRunId: null,
      errorCode: "regia_policy_gate_blocked",
    });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ runId: initialRun!.id, status: "failed" });
    expect(await db.select().from(environmentLeases)).toHaveLength(0);
    expect(acquireRunLease).not.toHaveBeenCalled();
    expect(executeProvider).not.toHaveBeenCalled();
  });

  it("restores blocked and suppresses recovery on a late selected-environment mismatch", async () => {
    await seed();
    const intake = await regiaIntakeService(db).accept(COMPANY_A, {
      ...request,
      idempotencyKey: "board:heartbeat-late-binding:001",
    }, { actorType: "user", actorId: "cristian" });
    await approveRegiaExecution(intake.rootTaskId);

    const otherEnvironmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await db.insert(environments).values({
      id: otherEnvironmentId,
      name: "Late mismatched environment",
      driver: "sandbox",
      status: "active",
    });
    await db.insert(builtInManagedResources).values({
      companyId: COMPANY_A,
      bundleKey: "regia-late-test",
      resourceKind: "environment",
      resourceKey: "late-sandbox",
      resourceId: otherEnvironmentId,
      stockVersion: "1",
      stockHash: "late-test",
      defaultsJson: {},
    });
    const acquireRunLease = vi.fn();
    const executeProvider = vi.fn();
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {},
      environmentRuntime: {
        acquireRunLease,
        execute: executeProvider,
        releaseRunLeases: vi.fn().mockResolvedValue([]),
      } as never,
      afterRegiaIntakePreflight: async () => {
        await db.update(agents).set({ defaultEnvironmentId: otherEnvironmentId })
          .where(eq(agents.id, REGIA_ID));
        await db.update(projects).set({ executionWorkspacePolicy: { environmentId: otherEnvironmentId } })
          .where(eq(projects.id, PROJECT_ID));
      },
    });
    const initialRun = await heartbeat.invoke(REGIA_ID, "on_demand", {
      issueId: intake.rootTaskId,
      taskId: intake.rootTaskId,
    }, "manual", { actorType: "user", actorId: "cristian" });
    expect(initialRun).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const [task] = await db.select({
      status: issues.status,
      executionRunId: issues.executionRunId,
      checkoutRunId: issues.checkoutRunId,
    }).from(issues).where(eq(issues.id, intake.rootTaskId));
    const runs = await db.select().from(heartbeatRuns);
    const wakes = await db.select().from(agentWakeupRequests);
    expect(task).toEqual({ status: "blocked", executionRunId: null, checkoutRunId: null });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: initialRun!.id,
      status: "failed",
      retryOfRunId: null,
      errorCode: "regia_execution_binding_invalid",
    });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ runId: initialRun!.id, status: "failed" });
    expect(await db.select().from(environmentLeases)).toHaveLength(0);
    expect(acquireRunLease).not.toHaveBeenCalled();
    expect(executeProvider).not.toHaveBeenCalled();
  });
});
