import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
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

const INTAKE_ACTION = "regia.intake.accepted" as const;

type RegiaIntakeActor = { actorType: "user"; actorId: string };

function requestFingerprint(input: RegiaIntakeRequest) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function normalizedIdentity(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase("it-IT").replace(/[^a-z0-9]+/g, " ").trim() ?? "";
}

function isRegiaIdentity(agent: { name: string; role: string; title: string | null }) {
  return normalizedIdentity(agent.role) === "ceo" || [agent.name, agent.title].map(normalizedIdentity).includes("regia");
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

export function regiaIntakeService(db: Db) {
  return {
    accept: async (
      companyId: string,
      input: RegiaIntakeRequest,
      actor: RegiaIntakeActor,
    ): Promise<RegiaIntakeResponse> => db.transaction(async (tx) => {
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
          receipt: { activityId: receipt.id, action: INTAKE_ACTION },
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
      }).from(agents).where(eq(agents.companyId, companyId));
      const eligible = companyAgents.filter((agent) =>
        isRegiaIdentity(agent) && getAgentWorkEligibility({ agent, agents: companyAgents }).invokable
      );
      if (eligible.length === 0) throw unprocessable("Company requires exactly one invokable Regia/CEO agent");
      if (eligible.length > 1) throw conflict("Company has multiple invokable Regia/CEO agents; assignment is ambiguous");
      const regia = eligible[0]!;

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
      const credential = await tx.select({ id: companySecrets.id }).from(companySecrets).where(and(
        eq(companySecrets.id, input.binding.credentialSecretRef.secretId),
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.status, "active"),
        isNull(companySecrets.deletedAt),
      )).then((rows) => rows[0] ?? null);
      if (!project || !workspace || !environment || environment.status !== "active" || !credential) {
        throw unprocessable("Regia intake binding is missing or outside the company cell");
      }
      if (projectEnvironmentId(project.executionWorkspacePolicy) !== input.binding.environmentId ||
        regia.defaultEnvironmentId !== input.binding.environmentId) {
        throw unprocessable("Regia intake environment binding is ambiguous or not pinned to project and agent");
      }

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
        status: "todo",
        priority: "high",
        reviewPolicy: "not_creator",
        assigneeAgentId: regia.id,
        createdByUserId: actor.actorId,
        responsibleUserId: actor.actorId,
        originKind: "regia_intake",
        originId: input.idempotencyKey,
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
          requestFingerprint: fingerprint,
          binding: {
            companyId,
            projectId: project.id,
            projectWorkspaceId: workspace.id,
            environmentId: environment.id,
            credentialSecretId: credential.id,
            credentialVersion: input.binding.credentialSecretRef.version,
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
        receipt: { activityId: receipt!.id, action: INTAKE_ACTION },
      };
    }),
  };
}
