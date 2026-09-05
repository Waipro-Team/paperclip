import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  externalObjects,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  GITHUB_PROJECT_V2_ORIGIN_KIND,
  GITHUB_PROJECT_V2_SOURCE_ID,
  githubProjectItemIdDigest,
  githubProjectReconciliationRequestSchema,
  githubProjectReconciliationService,
  type GithubProjectManifestPin,
  type GithubProjectImportRequest,
} from "../services/github-project-reconciliation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres GitHub Project reconciliation tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

const syntheticItems = [
  {
    projectItemId: "PVTI_SYNTHETIC_001",
    contentType: "Issue" as const,
    repository: "Repair360/core360" as const,
    number: 101,
    title: "Synthetic todo item",
    status: "Todo" as const,
    canonicalUrl: "https://github.com/Repair360/core360/issues/101",
  },
  {
    projectItemId: "PVTI_SYNTHETIC_002",
    contentType: "Issue" as const,
    repository: "Repair360/portal360" as const,
    number: 202,
    title: "Synthetic active item",
    status: "In Progress" as const,
    canonicalUrl: "https://github.com/Repair360/portal360/issues/202",
    assigneeAgentId: AGENT_ID,
  },
  {
    projectItemId: "PVTI_SYNTHETIC_003",
    contentType: "PullRequest" as const,
    repository: "Repair360/portal360-staging" as const,
    number: 303,
    title: "Synthetic completed item",
    status: "Done" as const,
    canonicalUrl: "https://github.com/Repair360/portal360-staging/pull/303",
  },
];

const syntheticManifestPin: GithubProjectManifestPin = {
  itemCount: syntheticItems.length,
  itemIdDigest: githubProjectItemIdDigest(syntheticItems.map((item) => item.projectItemId)),
  statusCounts: { todo: 1, inProgress: 1, done: 1 },
};

function requestFor(mode: GithubProjectImportRequest["mode"]): GithubProjectImportRequest {
  return {
    mode,
    sourceProjectId: GITHUB_PROJECT_V2_SOURCE_ID,
    expectedItemCount: syntheticItems.length,
    expectedItemIdDigest: githubProjectItemIdDigest(syntheticItems.map((item) => item.projectItemId)),
    expectedStatusCounts: { todo: 1, inProgress: 1, done: 1 },
    items: syntheticItems,
  };
}

const actor = {
  actorType: "user" as const,
  actorId: "synthetic-board-user",
};

describeEmbeddedPostgres("githubProjectReconciliationService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-project-reconciliation-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(externalObjects);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    await db.insert(companies).values({
      id: COMPANY_ID,
      name: "Core360",
      issuePrefix: "COR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "Synthetic explicit owner",
      role: "engineer",
      status: "idle",
    });
    await db.insert(issues).values(
      Array.from({ length: 8 }, (_, index) => ({
        companyId: COMPANY_ID,
        title: `Manual issue ${index + 1}`,
        status: "todo",
        originKind: "manual",
      })),
    );
  }

  function syntheticService() {
    return githubProjectReconciliationService(db, { manifestPin: syntheticManifestPin });
  }

  it("rejects a self-declared manifest that is not the pinned real Project #1 snapshot", async () => {
    await seedCompany();
    await expect(githubProjectReconciliationService(db).reconcile(COMPANY_ID, requestFor("dry_run"), actor))
      .rejects.toThrow("does not match the pinned Project #1 snapshot");
    expect(await db.select().from(projects)).toHaveLength(0);
    expect(await db.select().from(externalObjects)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(8);
  });

  it("dry-runs, canaries with rollback, imports losslessly, and leaves the second run unchanged", async () => {
    await seedCompany();
    const service = syntheticService();

    const preview = await service.reconcile(COMPANY_ID, requestFor("dry_run"), actor);
    expect(preview).toMatchObject({
      persisted: false,
      created: 3,
      updated: 0,
      unchanged: 0,
      manualIssueCount: 8,
    });
    expect(await db.select().from(projects)).toHaveLength(0);

    const canary = await service.reconcile(COMPANY_ID, requestFor("canary"), actor);
    expect(canary).toMatchObject({ persisted: false, lossless: true, created: 3 });
    expect(await db.select().from(projects)).toHaveLength(0);
    expect(await db.select().from(externalObjects)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(8);

    const first = await service.reconcile(COMPANY_ID, requestFor("apply"), actor);
    expect(first).toMatchObject({
      persisted: true,
      lossless: true,
      created: 3,
      updated: 0,
      unchanged: 0,
      importedIssueCount: 3,
      externalObjectCount: 3,
      manualIssueCount: 8,
      statusCounts: { todo: 1, inProgress: 1, done: 1 },
    });

    const importedBefore = await db
      .select({ id: issues.id, originId: issues.originId, updatedAt: issues.updatedAt })
      .from(issues)
      .where(and(eq(issues.companyId, COMPANY_ID), eq(issues.originKind, GITHUB_PROJECT_V2_ORIGIN_KIND)));
    const objectsBefore = await db
      .select({ id: externalObjects.id, updatedAt: externalObjects.updatedAt })
      .from(externalObjects);

    const second = await service.reconcile(COMPANY_ID, requestFor("apply"), actor);
    expect(second).toMatchObject({
      persisted: true,
      lossless: true,
      created: 0,
      updated: 0,
      unchanged: 3,
      manualIssueCount: 8,
    });
    expect(await db
      .select({ id: issues.id, originId: issues.originId, updatedAt: issues.updatedAt })
      .from(issues)
      .where(and(eq(issues.companyId, COMPANY_ID), eq(issues.originKind, GITHUB_PROJECT_V2_ORIGIN_KIND))))
      .toEqual(importedBefore);
    expect(await db.select({ id: externalObjects.id, updatedAt: externalObjects.updatedAt }).from(externalObjects))
      .toEqual(objectsBefore);
  });

  it("fails closed instead of inventing an owner for an In Progress item", async () => {
    await seedCompany();
    const request = requestFor("apply");
    request.items = request.items.map((item) => {
      if (item.status !== "In Progress") return item;
      const { assigneeAgentId: _removed, ...withoutOwner } = item;
      return withoutOwner;
    });
    await expect(syntheticService().reconcile(COMPANY_ID, request, actor))
      .rejects.toThrow("require an explicit COR agent mapping");
    expect(await db.select().from(projects)).toHaveLength(0);
    expect(await db.select().from(externalObjects)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(8);
  });

  it("rejects raw bodies and selectively rolls back only GitHub-origin issues", async () => {
    await seedCompany();
    expect(() => githubProjectReconciliationRequestSchema.parse({
      ...requestFor("apply"),
      items: [{ ...syntheticItems[0], body: "raw body must never cross the boundary" }],
      expectedItemCount: 1,
      expectedItemIdDigest: githubProjectItemIdDigest([syntheticItems[0].projectItemId]),
      expectedStatusCounts: { todo: 1, inProgress: 0, done: 0 },
    })).toThrow();

    const service = syntheticService();
    await service.reconcile(COMPANY_ID, requestFor("apply"), actor);
    await db.insert(issues).values({
      companyId: COMPANY_ID,
      title: "Orphaned GitHub Project V2 issue",
      status: "todo",
      originKind: GITHUB_PROJECT_V2_ORIGIN_KIND,
      originId: "PVTI_ORPHANED_WITHOUT_EXTERNAL_OBJECT",
    });
    const rolledBack = await service.reconcile(COMPANY_ID, {
      mode: "rollback",
      sourceProjectId: GITHUB_PROJECT_V2_SOURCE_ID,
      confirmOriginKind: GITHUB_PROJECT_V2_ORIGIN_KIND,
    }, actor);
    expect(rolledBack).toMatchObject({ rolledBack: 4, manualIssueCount: 8, lossless: false });
    expect(await db.select().from(externalObjects)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(8);
    expect((await db.select().from(issues)).every((issue) => issue.originKind === "manual")).toBe(true);
  });

  it("fails the lossless proof when orphaned imported state exists outside the pinned manifest", async () => {
    await seedCompany();
    await db.insert(issues).values({
      companyId: COMPANY_ID,
      title: "Pre-existing orphaned GitHub Project V2 issue",
      status: "todo",
      originKind: GITHUB_PROJECT_V2_ORIGIN_KIND,
      originId: "PVTI_PREEXISTING_ORPHAN",
    });

    await expect(syntheticService().reconcile(COMPANY_ID, requestFor("apply"), actor))
      .rejects.toThrow("Lossless GitHub reconciliation proof failed");
    expect(await db.select().from(projects)).toHaveLength(0);
    expect(await db.select().from(externalObjects)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(9);
  });

  it("enforces the persistent company plus GitHub item origin uniqueness constraint", async () => {
    await seedCompany();
    await db.insert(issues).values({
      companyId: COMPANY_ID,
      title: "First imported identity",
      status: "todo",
      originKind: GITHUB_PROJECT_V2_ORIGIN_KIND,
      originId: "PVTI_UNIQUE_ORIGIN_001",
    });
    await expect(db.insert(issues).values({
      companyId: COMPANY_ID,
      title: "Duplicate imported identity",
      status: "todo",
      originKind: GITHUB_PROJECT_V2_ORIGIN_KIND,
      originId: "PVTI_UNIQUE_ORIGIN_001",
    })).rejects.toThrow();
  });
});
