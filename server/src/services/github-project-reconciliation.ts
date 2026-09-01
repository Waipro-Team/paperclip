import { createHash } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  agents,
  companies,
  externalObjects,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import { z } from "zod";
import { conflict, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

export const GITHUB_PROJECT_V2_SOURCE_ID = "PVT_kwDOEuI4-s4BhpND";
export const GITHUB_PROJECT_V2_SOURCE_NUMBER = 1;
export const GITHUB_PROJECT_V2_TARGET_PROJECT = "REGIA360";
export const GITHUB_PROJECT_V2_ORIGIN_KIND = "github_project_v2";

const ALLOWED_REPOSITORIES = [
  "Repair360/core360",
  "Repair360/ops-restart-chiusura-20260827",
  "Repair360/portal360",
  "Repair360/portal360-staging",
] as const;

const githubProjectItemSchema = z.object({
  projectItemId: z.string().trim().regex(/^[A-Za-z0-9_=-]{8,160}$/),
  contentType: z.enum(["Issue", "PullRequest"]),
  repository: z.enum(ALLOWED_REPOSITORIES),
  number: z.number().int().positive().max(2_147_483_647),
  title: z.string().trim().min(1).max(500),
  status: z.enum(["Todo", "In Progress", "Done"]),
  canonicalUrl: z.string().trim().min(1).max(500),
  assigneeAgentId: z.string().uuid().optional(),
}).strict();

const statusCountsSchema = z.object({
  todo: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
}).strict();

const importRequestSchema = z.object({
  mode: z.enum(["dry_run", "canary", "apply"]),
  sourceProjectId: z.literal(GITHUB_PROJECT_V2_SOURCE_ID),
  expectedItemCount: z.number().int().positive().max(500),
  expectedItemIdDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedStatusCounts: statusCountsSchema,
  items: z.array(githubProjectItemSchema).min(1).max(500),
}).strict();

const rollbackRequestSchema = z.object({
  mode: z.literal("rollback"),
  sourceProjectId: z.literal(GITHUB_PROJECT_V2_SOURCE_ID),
  confirmOriginKind: z.literal(GITHUB_PROJECT_V2_ORIGIN_KIND),
}).strict();

export const githubProjectReconciliationRequestSchema = z.discriminatedUnion("mode", [
  importRequestSchema,
  rollbackRequestSchema,
]);

export type GithubProjectReconciliationRequest = z.infer<typeof githubProjectReconciliationRequestSchema>;
export type GithubProjectImportRequest = z.infer<typeof importRequestSchema>;
type GithubProjectItem = z.infer<typeof githubProjectItemSchema>;

export type GithubProjectReconciliationActor = {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
};

type StatusCounts = z.infer<typeof statusCountsSchema>;

export type GithubProjectReconciliationResult = {
  mode: GithubProjectReconciliationRequest["mode"];
  persisted: boolean;
  sourceProjectId: string;
  targetProjectName: string;
  targetProjectId: string | null;
  sourceItemCount: number;
  sourceItemIdDigest: string;
  statusCounts: StatusCounts;
  created: number;
  updated: number;
  unchanged: number;
  rolledBack: number;
  importedIssueCount: number;
  externalObjectCount: number;
  manualIssueCount: number;
  lossless: boolean;
};

class CanaryRollback extends Error {
  constructor(readonly result: GithubProjectReconciliationResult) {
    super("GitHub Project V2 canary rollback");
  }
}

function normalizeTitle(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function assertSafeTitle(title: string) {
  if (/[\u0000-\u001f\u007f<>]/.test(title)) {
    throw unprocessable("GitHub project item title contains disallowed control or markup characters");
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(title)) {
    throw unprocessable("GitHub project item title must not contain email addresses");
  }
  if (/\b(?:api[_ -]?key|secret|password|token)\s*[:=]\s*\S+/i.test(title)) {
    throw unprocessable("GitHub project item title resembles a credential");
  }
}

function sanitizedCanonicalUrl(item: GithubProjectItem) {
  let parsed: URL;
  try {
    parsed = new URL(item.canonicalUrl);
  } catch {
    throw unprocessable("GitHub project item canonicalUrl is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password) {
    throw unprocessable("GitHub project item canonicalUrl must be an HTTPS github.com URL");
  }
  if (parsed.search || parsed.hash) {
    throw unprocessable("GitHub project item canonicalUrl must not contain query parameters or fragments");
  }
  const expectedKind = item.contentType === "PullRequest" ? "pull" : "issues";
  const expectedPath = `/${item.repository}/${expectedKind}/${item.number}`;
  if (parsed.pathname.replace(/\/$/, "") !== expectedPath) {
    throw unprocessable("GitHub project item canonicalUrl does not match repository, type and number");
  }
  return `https://github.com${expectedPath}`;
}

function itemIdDigest(ids: readonly string[]) {
  return createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
}

function canonicalItemFingerprint(item: GithubProjectItem) {
  return createHash("sha256").update(JSON.stringify({
    projectItemId: item.projectItemId,
    contentType: item.contentType,
    repository: item.repository,
    number: item.number,
    title: normalizeTitle(item.title),
    status: item.status,
    canonicalUrl: sanitizedCanonicalUrl(item),
    assigneeAgentId: item.assigneeAgentId ?? null,
  })).digest("hex");
}

function canonicalIdentityHash(projectItemId: string) {
  return createHash("sha256")
    .update(`github\0project_v2_item\0${projectItemId}`)
    .digest("hex");
}

function mapStatus(status: GithubProjectItem["status"]) {
  if (status === "Done") return "done" as const;
  if (status === "In Progress") return "in_progress" as const;
  return "todo" as const;
}

function countStatuses(items: readonly GithubProjectItem[]): StatusCounts {
  return items.reduce<StatusCounts>((counts, item) => {
    if (item.status === "Done") counts.done += 1;
    else if (item.status === "In Progress") counts.inProgress += 1;
    else counts.todo += 1;
    return counts;
  }, { todo: 0, inProgress: 0, done: 0 });
}

function equalStatusCounts(left: StatusCounts, right: StatusCounts) {
  return left.todo === right.todo && left.inProgress === right.inProgress && left.done === right.done;
}

function validateManifest(request: GithubProjectImportRequest) {
  if (request.items.length !== request.expectedItemCount) {
    throw unprocessable("GitHub project manifest item count does not match the declared count");
  }
  const ids = request.items.map((item) => item.projectItemId);
  if (new Set(ids).size !== ids.length) {
    throw unprocessable("GitHub project manifest contains duplicate project item IDs");
  }
  const digest = itemIdDigest(ids);
  if (digest !== request.expectedItemIdDigest) {
    throw unprocessable("GitHub project manifest item digest does not match the declared digest");
  }
  const statusCounts = countStatuses(request.items);
  if (!equalStatusCounts(statusCounts, request.expectedStatusCounts)) {
    throw unprocessable("GitHub project manifest status counts do not match the declared counts");
  }
  for (const item of request.items) {
    assertSafeTitle(normalizeTitle(item.title));
    sanitizedCanonicalUrl(item);
    if (item.status === "In Progress" && !item.assigneeAgentId) {
      throw unprocessable(
        "In Progress GitHub project items require an explicit COR agent mapping; no fallback owner is assigned",
        { projectItemId: item.projectItemId },
      );
    }
  }
  return { digest, statusCounts };
}

async function assertCorScope(db: Db, companyId: string) {
  const company = await db
    .select({ id: companies.id, issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!company || company.issuePrefix !== "COR") {
    throw unprocessable("GitHub Project #1 reconciliation is pinned to the COR company");
  }
}

async function assertMappedAgents(db: Db, companyId: string, items: readonly GithubProjectItem[]) {
  const mappedIds = [...new Set(items.flatMap((item) => item.assigneeAgentId ? [item.assigneeAgentId] : []))];
  if (mappedIds.length === 0) return;
  const rows = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, mappedIds), ne(agents.status, "terminated")));
  const available = new Set(rows.map((row) => row.id));
  const missing = mappedIds.filter((id) => !available.has(id));
  if (missing.length > 0) {
    throw unprocessable("GitHub assignee mapping references unavailable or cross-company agents", {
      missingAgentIds: missing,
    });
  }
}

async function countManualIssues(db: Db, companyId: string) {
  return db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "manual")))
    .then((rows) => rows[0]?.count ?? 0);
}

async function readRegiaProject(db: Db, companyId: string) {
  const rows = await db
    .select({ id: projects.id, archivedAt: projects.archivedAt })
    .from(projects)
    .where(and(
      eq(projects.companyId, companyId),
      sql`lower(btrim(${projects.name})) = lower(${GITHUB_PROJECT_V2_TARGET_PROJECT})`,
    ));
  const active = rows.filter((row) => row.archivedAt === null);
  if (active.length > 1) {
    throw conflict("Multiple active REGIA360 projects exist; reconciliation refuses an ambiguous target");
  }
  return active[0] ?? null;
}

async function readImportedState(db: Db, companyId: string, itemIds: readonly string[]) {
  const importedIssues = itemIds.length === 0 ? [] : await db
    .select()
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, GITHUB_PROJECT_V2_ORIGIN_KIND),
      inArray(issues.originId, [...itemIds]),
    ));
  const objects = itemIds.length === 0 ? [] : await db
    .select()
    .from(externalObjects)
    .where(and(
      eq(externalObjects.companyId, companyId),
      eq(externalObjects.providerKey, "github"),
      eq(externalObjects.objectType, "project_v2_item"),
      inArray(externalObjects.externalId, [...itemIds]),
    ));
  return { importedIssues, objects };
}

function isIssueProjectionEqual(
  existing: typeof issues.$inferSelect,
  item: GithubProjectItem,
  projectId: string | null,
) {
  return existing.title === normalizeTitle(item.title)
    && existing.status === mapStatus(item.status)
    && existing.projectId === projectId
    && existing.assigneeAgentId === (item.assigneeAgentId ?? null)
    && existing.assigneeUserId === null
    && existing.originFingerprint === canonicalItemFingerprint(item);
}

function isExternalProjectionEqual(
  existing: typeof externalObjects.$inferSelect | undefined,
  item: GithubProjectItem,
  issueId: string,
) {
  const data = existing?.data as Record<string, unknown> | undefined;
  return Boolean(existing)
    && existing!.remoteVersion === canonicalItemFingerprint(item)
    && existing!.sanitizedCanonicalUrl === sanitizedCanonicalUrl(item)
    && existing!.displayTitle === normalizeTitle(item.title)
    && existing!.statusKey === mapStatus(item.status)
    && data?.issueId === issueId;
}

function baseResult(input: {
  mode: GithubProjectReconciliationResult["mode"];
  persisted: boolean;
  projectId: string | null;
  request: GithubProjectImportRequest;
  created: number;
  updated: number;
  unchanged: number;
  importedIssueCount: number;
  externalObjectCount: number;
  manualIssueCount: number;
}): GithubProjectReconciliationResult {
  const statusCounts = countStatuses(input.request.items);
  const digest = itemIdDigest(input.request.items.map((item) => item.projectItemId));
  const lossless = input.importedIssueCount === input.request.expectedItemCount
    && input.externalObjectCount === input.request.expectedItemCount
    && digest === input.request.expectedItemIdDigest
    && equalStatusCounts(statusCounts, input.request.expectedStatusCounts);
  return {
    mode: input.mode,
    persisted: input.persisted,
    sourceProjectId: input.request.sourceProjectId,
    targetProjectName: GITHUB_PROJECT_V2_TARGET_PROJECT,
    targetProjectId: input.projectId,
    sourceItemCount: input.request.items.length,
    sourceItemIdDigest: digest,
    statusCounts,
    created: input.created,
    updated: input.updated,
    unchanged: input.unchanged,
    rolledBack: 0,
    importedIssueCount: input.importedIssueCount,
    externalObjectCount: input.externalObjectCount,
    manualIssueCount: input.manualIssueCount,
    lossless,
  };
}

export function githubProjectReconciliationService(db: Db) {
  async function preview(companyId: string, request: GithubProjectImportRequest) {
    validateManifest(request);
    await assertCorScope(db, companyId);
    await assertMappedAgents(db, companyId, request.items);
    const project = await readRegiaProject(db, companyId);
    const ids = request.items.map((item) => item.projectItemId);
    const state = await readImportedState(db, companyId, ids);
    const byOrigin = new Map(state.importedIssues.map((issue) => [issue.originId!, issue]));
    const externalById = new Map(state.objects.map((object) => [object.externalId, object]));
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const item of request.items) {
      const existing = byOrigin.get(item.projectItemId);
      if (!existing) created += 1;
      else if (
        project
        && isIssueProjectionEqual(existing, item, project.id)
        && isExternalProjectionEqual(externalById.get(item.projectItemId), item, existing.id)
      ) unchanged += 1;
      else updated += 1;
    }
    return baseResult({
      mode: "dry_run",
      persisted: false,
      projectId: project?.id ?? null,
      request,
      created,
      updated,
      unchanged,
      importedIssueCount: state.importedIssues.length,
      externalObjectCount: state.objects.length,
      manualIssueCount: await countManualIssues(db, companyId),
    });
  }

  async function applyWithin(
    dbx: Db,
    companyId: string,
    request: GithubProjectImportRequest,
    audit: GithubProjectReconciliationActor,
  ) {
    validateManifest(request);
    await assertCorScope(dbx, companyId);
    await assertMappedAgents(dbx, companyId, request.items);
    let project = await readRegiaProject(dbx, companyId);
    if (!project) {
      project = await dbx.insert(projects).values({
        companyId,
        name: GITHUB_PROJECT_V2_TARGET_PROJECT,
        description: "GitHub Project #1 mirror; issue bodies are intentionally not imported.",
        status: "in_progress",
      }).returning({ id: projects.id, archivedAt: projects.archivedAt }).then((rows) => rows[0]!);
    }

    const itemIds = request.items.map((item) => item.projectItemId);
    const before = await readImportedState(dbx, companyId, itemIds);
    const byOrigin = new Map(before.importedIssues.map((issue) => [issue.originId!, issue]));
    const externalById = new Map(before.objects.map((object) => [object.externalId, object]));
    const issueSvc = issueService(dbx);
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const item of request.items) {
      const title = normalizeTitle(item.title);
      const status = mapStatus(item.status);
      const fingerprint = canonicalItemFingerprint(item);
      const existing = byOrigin.get(item.projectItemId);
      let issueId: string;
      let issueWasCreated = false;
      let issueChanged = false;
      if (!existing) {
        const createdIssue = await issueSvc.create(companyId, {
          title,
          status,
          projectId: project.id,
          assigneeAgentId: item.assigneeAgentId ?? undefined,
          originKind: GITHUB_PROJECT_V2_ORIGIN_KIND,
          originId: item.projectItemId,
          originFingerprint: fingerprint,
          createdByUserId: audit.actorType === "user" ? audit.actorId : undefined,
          allowDuplicate: true,
        });
        issueId = createdIssue.id;
        issueWasCreated = true;
      } else {
        issueId = existing.id;
        if (!isIssueProjectionEqual(existing, item, project.id)) {
          const now = new Date();
          await dbx.update(issues).set({
            title,
            status,
            statusVersion: existing.status === status
              ? existing.statusVersion
              : sql`${issues.statusVersion} + 1`,
            projectId: project.id,
            assigneeAgentId: item.assigneeAgentId ?? null,
            assigneeUserId: null,
            originFingerprint: fingerprint,
            startedAt: status === "in_progress" ? (existing.startedAt ?? now) : null,
            completedAt: status === "done" ? (existing.completedAt ?? now) : null,
            cancelledAt: null,
            updatedAt: now,
          }).where(and(eq(issues.companyId, companyId), eq(issues.id, existing.id)));
          issueChanged = true;
        }
      }

      const url = sanitizedCanonicalUrl(item);
      const isTerminal = status === "done";
      const existingObject = externalById.get(item.projectItemId);
      const externalObjectChanged = !isExternalProjectionEqual(existingObject, item, issueId);
      if (externalObjectChanged) {
        await dbx.insert(externalObjects).values({
        companyId,
        providerKey: "github",
        objectType: "project_v2_item",
        externalId: item.projectItemId,
        sanitizedCanonicalUrl: url,
        canonicalIdentityHash: canonicalIdentityHash(item.projectItemId),
        displayKey: `${item.repository}#${item.number}`,
        displayTitle: title,
        statusKey: status,
        statusLabel: item.status,
        statusCategory: isTerminal ? "closed" : (status === "in_progress" ? "running" : "open"),
        statusTone: isTerminal ? "success" : "info",
        liveness: "fresh",
        isTerminal,
        data: {
          sourceProjectId: request.sourceProjectId,
          sourceProjectNumber: GITHUB_PROJECT_V2_SOURCE_NUMBER,
          repository: item.repository,
          number: item.number,
          contentType: item.contentType,
          issueId,
        },
        remoteVersion: fingerprint,
        lastResolvedAt: new Date(),
        lastChangedAt: new Date(),
        updatedAt: new Date(),
        }).onConflictDoUpdate({
        target: [
          externalObjects.companyId,
          externalObjects.providerKey,
          externalObjects.objectType,
          externalObjects.externalId,
        ],
        set: {
          sanitizedCanonicalUrl: url,
          canonicalIdentityHash: canonicalIdentityHash(item.projectItemId),
          displayKey: `${item.repository}#${item.number}`,
          displayTitle: title,
          statusKey: status,
          statusLabel: item.status,
          statusCategory: isTerminal ? "closed" : (status === "in_progress" ? "running" : "open"),
          statusTone: isTerminal ? "success" : "info",
          liveness: "fresh",
          isTerminal,
          data: {
            sourceProjectId: request.sourceProjectId,
            sourceProjectNumber: GITHUB_PROJECT_V2_SOURCE_NUMBER,
            repository: item.repository,
            number: item.number,
            contentType: item.contentType,
            issueId,
          },
          remoteVersion: fingerprint,
          lastResolvedAt: new Date(),
          lastChangedAt: new Date(),
          updatedAt: new Date(),
        },
        });
      }
      if (issueWasCreated) created += 1;
      else if (issueChanged || externalObjectChanged) updated += 1;
      else unchanged += 1;
    }

    const after = await readImportedState(dbx, companyId, itemIds);
    const issueDigest = itemIdDigest(after.importedIssues.map((issue) => issue.originId!));
    const objectDigest = itemIdDigest(after.objects.map((object) => object.externalId));
    const persistedStatusCounts = after.importedIssues.reduce<StatusCounts>((counts, issue) => {
      if (issue.status === "done") counts.done += 1;
      else if (issue.status === "in_progress") counts.inProgress += 1;
      else if (issue.status === "todo") counts.todo += 1;
      return counts;
    }, { todo: 0, inProgress: 0, done: 0 });
    if (
      after.importedIssues.length !== request.expectedItemCount
      || after.objects.length !== request.expectedItemCount
      || issueDigest !== request.expectedItemIdDigest
      || objectDigest !== request.expectedItemIdDigest
      || !equalStatusCounts(persistedStatusCounts, request.expectedStatusCounts)
    ) {
      throw conflict("Lossless GitHub reconciliation proof failed; transaction rolled back", {
        issueCount: after.importedIssues.length,
        externalObjectCount: after.objects.length,
        issueDigest,
        externalObjectDigest: objectDigest,
        persistedStatusCounts,
      });
    }

    return baseResult({
      mode: request.mode,
      persisted: request.mode === "apply",
      projectId: project.id,
      request,
      created,
      updated,
      unchanged,
      importedIssueCount: after.importedIssues.length,
      externalObjectCount: after.objects.length,
      manualIssueCount: await countManualIssues(dbx, companyId),
    });
  }

  async function applyOrCanary(
    companyId: string,
    request: GithubProjectImportRequest,
    audit: GithubProjectReconciliationActor,
  ) {
    const publications: ActivityPublication[] = [];
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:github-project-v2:${companyId}:${request.sourceProjectId}`}, 0))`);
        const dbx = tx as unknown as Db;
        const applied = await applyWithin(dbx, companyId, request, audit);
        await logActivity(dbx, {
          companyId,
          actorType: audit.actorType,
          actorId: audit.actorId,
          agentId: audit.agentId,
          runId: audit.runId,
          agentApiKeyId: audit.agentApiKeyId,
          action: "github_project_v2.reconciled",
          entityType: "project",
          entityId: applied.targetProjectId!,
          details: {
            sourceProjectId: request.sourceProjectId,
            sourceItemCount: applied.sourceItemCount,
            sourceItemIdDigest: applied.sourceItemIdDigest,
            created: applied.created,
            updated: applied.updated,
            unchanged: applied.unchanged,
          },
        }, publications);
        if (request.mode === "canary") throw new CanaryRollback(applied);
        return applied;
      });
      for (const publication of publications) publishActivity(publication);
      return result;
    } catch (error) {
      if (error instanceof CanaryRollback) {
        return { ...error.result, mode: "canary" as const, persisted: false };
      }
      throw error;
    }
  }

  async function rollback(
    companyId: string,
    request: Extract<GithubProjectReconciliationRequest, { mode: "rollback" }>,
    audit: GithubProjectReconciliationActor,
  ): Promise<GithubProjectReconciliationResult> {
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:github-project-v2:${companyId}:${request.sourceProjectId}`}, 0))`);
      const dbx = tx as unknown as Db;
      await assertCorScope(dbx, companyId);
      const sourceObjects = await dbx
        .select({ externalId: externalObjects.externalId })
        .from(externalObjects)
        .where(and(
          eq(externalObjects.companyId, companyId),
          eq(externalObjects.providerKey, "github"),
          eq(externalObjects.objectType, "project_v2_item"),
          sql`${externalObjects.data} ->> 'sourceProjectId' = ${request.sourceProjectId}`,
        ));
      const itemIds = sourceObjects.map((row) => row.externalId);
      let rolledBack = 0;
      if (itemIds.length > 0) {
        const deletedIssues = await dbx.delete(issues).where(and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, GITHUB_PROJECT_V2_ORIGIN_KIND),
          inArray(issues.originId, itemIds),
        )).returning({ id: issues.id });
        rolledBack = deletedIssues.length;
        await dbx.delete(externalObjects).where(and(
          eq(externalObjects.companyId, companyId),
          eq(externalObjects.providerKey, "github"),
          eq(externalObjects.objectType, "project_v2_item"),
          inArray(externalObjects.externalId, itemIds),
        ));
      }
      await logActivity(dbx, {
        companyId,
        actorType: audit.actorType,
        actorId: audit.actorId,
        agentId: audit.agentId,
        runId: audit.runId,
        agentApiKeyId: audit.agentApiKeyId,
        action: "github_project_v2.rollback",
        entityType: "company",
        entityId: companyId,
        details: { sourceProjectId: request.sourceProjectId, rolledBack },
      }, publications);
      return {
        mode: "rollback" as const,
        persisted: true,
        sourceProjectId: request.sourceProjectId,
        targetProjectName: GITHUB_PROJECT_V2_TARGET_PROJECT,
        targetProjectId: (await readRegiaProject(dbx, companyId))?.id ?? null,
        sourceItemCount: itemIds.length,
        sourceItemIdDigest: itemIdDigest(itemIds),
        statusCounts: { todo: 0, inProgress: 0, done: 0 },
        created: 0,
        updated: 0,
        unchanged: 0,
        rolledBack,
        importedIssueCount: 0,
        externalObjectCount: 0,
        manualIssueCount: await countManualIssues(dbx, companyId),
        lossless: true,
      };
    });
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  async function reconcile(
    companyId: string,
    rawRequest: GithubProjectReconciliationRequest,
    audit: GithubProjectReconciliationActor,
  ) {
    const request = githubProjectReconciliationRequestSchema.parse(rawRequest);
    if (request.mode === "rollback") return rollback(companyId, request, audit);
    if (request.mode === "dry_run") return preview(companyId, request);
    return applyOrCanary(companyId, request, audit);
  }

  return { reconcile };
}

export const githubProjectItemIdDigest = itemIdDigest;
