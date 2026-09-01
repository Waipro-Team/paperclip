import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  builtInManagedResources,
  companies,
  companySecretBindings,
  companySecrets,
  environments,
  goals,
  issueCreateIdempotencyKeys,
  issues,
  projectWorkspaces,
  projectGoals,
  projects,
} from "@paperclipai/db";
import {
  getAgentWorkEligibility,
  type RegiaIntakeRequest,
  type RegiaIntakeResponse,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { createFeedbackRedactionState, sanitizeFeedbackText } from "./feedback-redaction.js";
import { secretService } from "./secrets.js";

const INTAKE_ACTION = "regia.intake.accepted" as const;

type RegiaIntakeActor = { actorType: "user"; actorId: string };

function requestFingerprint(input: RegiaIntakeRequest) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function normalizedIdentity(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase("it-IT").replace(/[^a-z0-9]+/g, " ").trim() ?? "";
}

function isRegiaCatalogIdentity(agent: {
  name: string;
  role: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
}) {
  const catalogRole = normalizedIdentity(
    typeof agent.metadata?.catalogRoleKey === "string" ? agent.metadata.catalogRoleKey : null,
  );
  const identities = [agent.name, agent.title].map(normalizedIdentity);
  return normalizedIdentity(agent.role) === "ceo" || normalizedIdentity(agent.role) === "executive" ||
    catalogRole === "fleet director" || catalogRole === "director pmo control room" ||
    identities.includes("regia") || identities.includes("fleet director") ||
    identities.includes("director pmo control room");
}

function assertNonSensitiveIntake(input: RegiaIntakeRequest) {
  const values = [
    input.objective,
    ...input.constraints,
    input.budgetEnvelope?.notes,
    ...input.kpis.flatMap((kpi) => [kpi.name, kpi.target, kpi.unit]),
    ...input.gates.flatMap((gate) => [gate.name, gate.condition]),
  ].filter((value): value is string => typeof value === "string");
  for (const [index, value] of values.entries()) {
    const state = createFeedbackRedactionState();
    const sanitized = sanitizeFeedbackText(value, state, `regiaIntake.${index}`, value.length + 1);
    const containsOpaqueToken = /(?:^|\s)[A-Za-z0-9_-]{32,}(?:$|\s)/.test(value);
    if (sanitized !== value || containsOpaqueToken) {
      throw unprocessable("Regia intake context must not contain PII or credential material");
    }
  }
}

function projectEnvironmentId(policy: unknown) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const value = (policy as Record<string, unknown>).environmentId;
  return typeof value === "string" ? value : null;
}

function intakeDescription(input: RegiaIntakeRequest) {
  return [
    "# Obiettivo Regia",
    "",
    input.objective,
    "",
    "## Contesto operativo (non sensibile)",
    "```json",
    JSON.stringify({
      constraints: input.constraints,
      budgetEnvelope: input.budgetEnvelope ?? null,
      kpis: input.kpis,
      gates: input.gates,
      reviewPolicy: "not_creator",
      decompositionOwner: "assigned_regia_agent",
    }, null, 2),
    "```",
  ].join("\n");
}

function taskTitle(objective: string) {
  const firstLine = objective.split(/\r?\n/, 1)[0]?.trim() || "Obiettivo Regia";
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117)}...`;
}

async function assertEnvironmentCredentialRef(db: Db, input: {
  companyId: string;
  environmentId: string;
  secretId: string;
  version: number | "latest";
  expectedConfigPath?: string | null;
}) {
  const secret = await db.select({ id: companySecrets.id }).from(companySecrets).where(and(
    eq(companySecrets.id, input.secretId),
    eq(companySecrets.companyId, input.companyId),
    eq(companySecrets.scope, "company"),
    eq(companySecrets.status, "active"),
    isNull(companySecrets.deletedAt),
  )).then((rows) => rows[0] ?? null);
  if (!secret) {
    throw unprocessable("Regia intake credential must be an active company-scoped secret_ref");
  }
  const bindings = await db.select({ configPath: companySecretBindings.configPath })
    .from(companySecretBindings)
    .where(and(
      eq(companySecretBindings.companyId, input.companyId),
      eq(companySecretBindings.secretId, input.secretId),
      eq(companySecretBindings.targetType, "environment"),
      eq(companySecretBindings.targetId, input.environmentId),
      eq(companySecretBindings.versionSelector, String(input.version)),
      eq(companySecretBindings.required, true),
    ));
  if (bindings.length !== 1 || !bindings[0]?.configPath ||
    (input.expectedConfigPath && bindings[0].configPath !== input.expectedConfigPath)) {
    throw unprocessable("Regia intake credential secret_ref is not bound to the selected environment exactly once");
  }
  const configPath = bindings[0].configPath;
  const resolvedVersion = await secretService(db).resolveSecretVersion(
    input.companyId,
    input.secretId,
    input.version,
    {
      consumerType: "environment",
      consumerId: input.environmentId,
      configPath,
    },
  );
  return { configPath, resolvedVersion };
}

export async function assertRegiaIntakeExecutionBinding(db: Db, input: {
  companyId: string;
  issueId: string;
  selectedEnvironmentId: string;
  assertCompanyBinding?: boolean;
}) {
  if (input.assertCompanyBinding !== true) {
    throw unprocessable("Regia intake execution requires explicit company-binding enforcement");
  }
  const issue = await db.select({
    projectId: issues.projectId,
    projectWorkspaceId: issues.projectWorkspaceId,
    assigneeAgentId: issues.assigneeAgentId,
    originKind: issues.originKind,
    reviewPolicy: issues.reviewPolicy,
  }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue || issue.originKind !== "regia_intake" || issue.reviewPolicy !== "not_creator" ||
    !issue.projectId || !issue.projectWorkspaceId || !issue.assigneeAgentId) {
    throw unprocessable("Regia intake execution task has no valid native company cell");
  }
  const receipt = await db.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, input.companyId),
    eq(activityLog.action, INTAKE_ACTION),
    eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, input.issueId),
  )).orderBy(asc(activityLog.createdAt)).then((rows) => rows[0] ?? null);
  const binding = receipt?.details?.binding as Record<string, unknown> | undefined;
  const credentialSecretId = typeof binding?.credentialSecretId === "string" ? binding.credentialSecretId : null;
  const credentialVersion = binding?.credentialVersion;
  const credentialConfigPath = typeof binding?.credentialConfigPath === "string"
    ? binding.credentialConfigPath
    : null;
  if (!receipt || binding?.companyId !== input.companyId || binding?.projectId !== issue.projectId ||
    binding?.projectWorkspaceId !== issue.projectWorkspaceId || binding?.environmentId !== input.selectedEnvironmentId ||
    !credentialSecretId || !credentialConfigPath ||
    (credentialVersion !== "latest" &&
      (typeof credentialVersion !== "number" || !Number.isInteger(credentialVersion) || credentialVersion < 1))) {
    throw unprocessable("Regia intake execution receipt binding is missing or mismatched");
  }

  const [project, workspace, environment, assignee, environmentBindings] = await Promise.all([
    db.select({ executionWorkspacePolicy: projects.executionWorkspacePolicy }).from(projects).where(and(
      eq(projects.id, issue.projectId), eq(projects.companyId, input.companyId), isNull(projects.archivedAt),
    )).then((rows) => rows[0] ?? null),
    db.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(and(
      eq(projectWorkspaces.id, issue.projectWorkspaceId),
      eq(projectWorkspaces.companyId, input.companyId),
      eq(projectWorkspaces.projectId, issue.projectId),
    )).then((rows) => rows[0] ?? null),
    db.select({ id: environments.id, driver: environments.driver, status: environments.status }).from(environments)
      .where(eq(environments.id, input.selectedEnvironmentId)).then((rows) => rows[0] ?? null),
    db.select({ defaultEnvironmentId: agents.defaultEnvironmentId }).from(agents).where(and(
      eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, input.companyId),
    )).then((rows) => rows[0] ?? null),
    db.select({ companyId: builtInManagedResources.companyId }).from(builtInManagedResources).where(and(
      eq(builtInManagedResources.resourceKind, "environment"),
      eq(builtInManagedResources.resourceId, input.selectedEnvironmentId),
    )),
  ]);
  const boundCompanies = [...new Set(environmentBindings.map((row) => row.companyId))];
  if (!project || !workspace || !environment || environment.status !== "active" || environment.driver !== "sandbox" ||
    !assignee || projectEnvironmentId(project.executionWorkspacePolicy) !== environment.id ||
    assignee.defaultEnvironmentId !== environment.id || boundCompanies.length !== 1 ||
    boundCompanies[0] !== input.companyId) {
    throw unprocessable("Regia intake execution binding is unbound, ambiguous, or cross-company");
  }
  await assertEnvironmentCredentialRef(db, {
    companyId: input.companyId,
    environmentId: input.selectedEnvironmentId,
    secretId: credentialSecretId,
    version: credentialVersion,
    expectedConfigPath: credentialConfigPath,
  });
}

export function regiaIntakeService(db: Db) {
  return {
    accept: async (
      companyId: string,
      input: RegiaIntakeRequest,
      actor: RegiaIntakeActor,
    ): Promise<RegiaIntakeResponse> => db.transaction(async (tx) => {
      assertNonSensitiveIntake(input);
      const guardKey = `regia-intake:${companyId}:${input.idempotencyKey}`;
      const fingerprint = requestFingerprint(input);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${guardKey}, 0))`);

      const existing = await tx
        .select({
          issueId: issues.id,
          projectId: issues.projectId,
          projectWorkspaceId: issues.projectWorkspaceId,
          goalId: issues.goalId,
          regiaAgentId: issues.assigneeAgentId,
          reviewPolicy: issues.reviewPolicy,
        })
        .from(issueCreateIdempotencyKeys)
        .innerJoin(issues, eq(issueCreateIdempotencyKeys.issueId, issues.id))
        .where(and(
          eq(issueCreateIdempotencyKeys.companyId, companyId),
          eq(issueCreateIdempotencyKeys.idempotencyKey, input.idempotencyKey),
          eq(issues.companyId, companyId),
        ))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        if (
          !existing.goalId || !existing.projectId || !existing.regiaAgentId ||
          existing.reviewPolicy !== "not_creator" ||
          existing.projectId !== input.binding.projectId ||
          existing.projectWorkspaceId !== input.binding.projectWorkspaceId
        ) {
          throw conflict("Existing Regia intake cannot be reused with this binding");
        }
        const receipt = await tx.select({ id: activityLog.id, details: activityLog.details })
          .from(activityLog)
          .where(and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, INTAKE_ACTION),
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, existing.issueId),
          )).orderBy(asc(activityLog.createdAt)).then((rows) => rows[0] ?? null);
        const recordedBinding = receipt?.details?.binding as Record<string, unknown> | undefined;
        if (!receipt || receipt.details?.requestFingerprint !== fingerprint ||
          recordedBinding?.environmentId !== input.binding.environmentId ||
          recordedBinding?.credentialSecretId !== input.binding.credentialSecretRef.secretId) {
          throw conflict("Idempotency key was already used with a different Regia intake request");
        }
        return {
          companyId,
          goalId: existing.goalId,
          projectId: existing.projectId,
          rootTaskId: existing.issueId,
          regiaAgentId: existing.regiaAgentId,
          reviewPolicy: "not_creator",
          created: false,
          executionAuthorized: false,
          policyConfigured: false,
          blockingGate: "policy_configuration_required",
          receipt: { kind: "intake", activityId: receipt.id, action: INTAKE_ACTION },
        };
      }

      const companyAgents = await tx.select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        status: agents.status,
        reportsTo: agents.reportsTo,
        defaultEnvironmentId: agents.defaultEnvironmentId,
        metadata: agents.metadata,
      }).from(agents).where(eq(agents.companyId, companyId));
      const regia = companyAgents.find((agent) => agent.id === input.binding.regiaAgentId) ?? null;
      if (!regia || regia.reportsTo !== null || !isRegiaCatalogIdentity(regia) ||
        !getAgentWorkEligibility({ agent: regia, agents: companyAgents }).invokable) {
        throw unprocessable("The explicit Regia/Fleet Director is not an invokable company executive");
      }

      const project = await tx.select().from(projects).where(and(
        eq(projects.id, input.binding.projectId),
        eq(projects.companyId, companyId),
        isNull(projects.archivedAt),
      )).then((rows) => rows[0] ?? null);
      const workspace = await tx.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(and(
        eq(projectWorkspaces.id, input.binding.projectWorkspaceId),
        eq(projectWorkspaces.companyId, companyId),
        eq(projectWorkspaces.projectId, input.binding.projectId),
      )).then((rows) => rows[0] ?? null);
      const environment = await tx.select({ id: environments.id, status: environments.status }).from(environments)
        .where(eq(environments.id, input.binding.environmentId)).then((rows) => rows[0] ?? null);
      if (!project || !workspace || !environment || environment.status !== "active") {
        throw unprocessable("Regia intake binding is missing or outside the company cell");
      }
      if (projectEnvironmentId(project.executionWorkspacePolicy) !== input.binding.environmentId ||
        regia.defaultEnvironmentId !== input.binding.environmentId) {
        throw unprocessable("Regia intake environment binding is ambiguous or not pinned to project and agent");
      }
      const requestedVersion = input.binding.credentialSecretRef.version;
      const credential = await assertEnvironmentCredentialRef(tx as unknown as Db, {
        companyId,
        environmentId: environment.id,
        secretId: input.binding.credentialSecretRef.secretId,
        version: requestedVersion,
      });

      let goal = project.goalId
        ? await tx.select().from(goals).where(and(eq(goals.id, project.goalId), eq(goals.companyId, companyId)))
          .then((rows) => rows[0] ?? null)
        : null;
      if (!goal) {
        goal = await tx.select().from(goals).where(and(
          eq(goals.companyId, companyId),
          eq(goals.level, "company"),
          eq(goals.status, "active"),
          isNull(goals.parentId),
        )).orderBy(asc(goals.createdAt), asc(goals.id)).then((rows) => rows[0] ?? null);
      }
      if (!goal) {
        [goal] = await tx.insert(goals).values({
          companyId,
          title: "Regia — obiettivi aziendali",
          description: "Goal company-scoped gestito dalla Regia tramite task e heartbeat Paperclip.",
          level: "company",
          status: "active",
          ownerAgentId: regia.id,
        }).returning();
      }
      await tx.update(projects).set({ goalId: goal!.id, updatedAt: new Date() })
        .where(and(eq(projects.id, project.id), eq(projects.companyId, companyId)));
      await tx.insert(projectGoals).values({ companyId, projectId: project.id, goalId: goal!.id })
        .onConflictDoNothing();

      const [maxRow] = await tx.select({ maxNum: sql<number>`coalesce(max(${issues.issueNumber}), 0)` })
        .from(issues).where(eq(issues.companyId, companyId));
      const [company] = await tx.update(companies).set({
        issueCounter: sql`greatest(${companies.issueCounter}, ${maxRow?.maxNum ?? 0}) + 1`,
      }).where(eq(companies.id, companyId)).returning({
        issueCounter: companies.issueCounter,
        issuePrefix: companies.issuePrefix,
      });
      if (!company) throw unprocessable("Company not found");

      const [rootTask] = await tx.insert(issues).values({
        companyId,
        projectId: project.id,
        projectWorkspaceId: workspace.id,
        goalId: goal!.id,
        title: taskTitle(input.objective),
        description: intakeDescription(input),
        status: "blocked",
        priority: "high",
        reviewPolicy: "not_creator",
        assigneeAgentId: regia.id,
        createdByUserId: actor.actorId,
        responsibleUserId: actor.actorId,
        originKind: "regia_intake",
        originId: input.idempotencyKey,
        blockedTransitionAt: new Date(),
        unblockDescriptor: {
          owner: "board",
          action: "Configure and approve native budget/gate policies before execution",
        },
        issueNumber: company.issueCounter,
        identifier: `${company.issuePrefix}-${company.issueCounter}`,
      }).returning();
      await tx.insert(issueCreateIdempotencyKeys).values({
        companyId,
        idempotencyKey: input.idempotencyKey,
        issueId: rootTask!.id,
      });
      const [receipt] = await tx.insert(activityLog).values({
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        responsibleUserId: actor.actorId,
        agentId: regia.id,
        action: INTAKE_ACTION,
        entityType: "issue",
        entityId: rootTask!.id,
        details: {
          goalId: goal!.id,
          projectId: project.id,
          rootTaskId: rootTask!.id,
          regiaAgentId: regia.id,
          reviewPolicy: "not_creator",
          autoWake: false,
          policyConfigured: false,
          blockingGate: "policy_configuration_required",
          requestFingerprint: fingerprint,
          binding: {
            companyId,
            projectId: project.id,
            projectWorkspaceId: workspace.id,
            environmentId: environment.id,
            credentialSecretId: input.binding.credentialSecretRef.secretId,
            credentialVersion: input.binding.credentialSecretRef.version,
            credentialConfigPath: credential.configPath,
          },
        },
      }).returning({ id: activityLog.id });

      return {
        companyId,
        goalId: goal!.id,
        projectId: project.id,
        rootTaskId: rootTask!.id,
        regiaAgentId: regia.id,
        reviewPolicy: "not_creator",
        created: true,
        executionAuthorized: false,
        policyConfigured: false,
        blockingGate: "policy_configuration_required",
        receipt: { kind: "intake", activityId: receipt!.id, action: INTAKE_ACTION },
      };
    }),
  };
}
