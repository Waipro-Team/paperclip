import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import { issues, principalPermissionGrants } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("board import inventory contract", () => {
  const ctx = useEmbeddedPostgres("paperclip-import-inventory-", { resetEach: resetCompanyIssueFixtures });

  it("includes hidden, terminal and harness rows with full descriptions and isolated pagination", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Import inventory");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other tenant");
    const marker = "<!-- portal360-import:synthetic -->\n" + "routing metadata ".repeat(250);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await ctx.db.insert(issues).values([
      { id: ids[0], companyId: company.companyId, title: "Visible", status: "backlog", createdAt: new Date("2026-01-01") },
      { id: ids[1], companyId: company.companyId, title: "Hidden done", status: "done", hiddenAt: new Date(), description: marker, createdAt: new Date("2026-01-02") },
      { id: ids[2], companyId: company.companyId, title: "Harness", status: "cancelled", harnessKind: "synthetic", createdAt: new Date("2026-01-03") },
      { id: randomUUID(), companyId: other.companyId, title: "Other tenant", status: "done" },
    ]);
    const app = routeApp(ctx.db, company.actor, issueRoutes);
    const path = "/api/companies/" + company.companyId + "/issues";
    const first = await request(app).get(path).query({ view: "import", limit: 2, offset: 0 }).expect(200);
    expect(first.body).toMatchObject({ schema: "paperclip.issue-import-inventory.v1", companyId: company.companyId,
      visibility: "all", totalCount: 3, limit: 2, offset: 0, nextOffset: 2 });
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body.items.map((row: { id: string }) => row.id)).toEqual(ids.slice(0, 2));
    expect(first.body.items[1].description).toBe(marker);
    const last = await request(app).get(path).query({ view: "import", limit: 2, offset: 2 }).expect(200);
    expect(last.body).toMatchObject({ totalCount: 3, offset: 2, nextOffset: null, items: [{ id: ids[2], status: "cancelled" }] });
    const ordinary = await request(app).get(path).expect(200);
    expect(ordinary.body.map((row: { id: string }) => row.id)).toEqual([ids[0]]);
    const readback = await request(app).get("/api/issues/" + ids[1]).expect(200);
    expect(readback.body.description).toBe(marker);
  });

  it("rejects agent credentials even for their own company", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Agent denial");
    const actor = { type: "agent", agentId: randomUUID(), companyId: company.companyId, source: "agent_key" } as unknown as BoardActor;
    await request(routeApp(ctx.db, actor, issueRoutes)).get("/api/companies/" + company.companyId + "/issues")
      .query({ view: "import" }).expect(403);
  });

  it("rejects board access to a different company", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Board");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    const response = await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get("/api/companies/" + other.companyId + "/issues").query({ view: "import" }).expect(403);
    expect(response.body.items).toBeUndefined();
  });

  it("requires full company-scope read rather than a partial board membership", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Limited board");
    await ctx.db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, company.companyId));
    const actor = { ...company.actor, userId: "ungranted-user", memberships: [] };
    await request(routeApp(ctx.db, actor, issueRoutes)).get("/api/companies/" + company.companyId + "/issues")
      .query({ view: "import" }).expect(403);
  });

  it.each([{ status: "done" }, { assigneeAgentId: "null" }, { q: "marker" }, { includeRoutineExecutions: "false" }])(
    "refuses filters that would invalidate completeness: %j", async (filter) => {
      const company = await seedCompanyWithBoardAccess(ctx.db, "No filtering");
      await request(routeApp(ctx.db, company.actor, issueRoutes)).get("/api/companies/" + company.companyId + "/issues")
        .query({ view: "import", ...filter }).expect(400);
    },
  );

  it.each([{ limit: "0" }, { offset: "-1" }])("rejects invalid pagination: %j", async (pagination) => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Pagination");
    await request(routeApp(ctx.db, company.actor, issueRoutes)).get("/api/companies/" + company.companyId + "/issues")
      .query({ view: "import", ...pagination }).expect(400);
  });

  it("returns a typed empty inventory", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Empty inventory");
    const response = await request(routeApp(ctx.db, company.actor, issueRoutes)).get("/api/companies/" + company.companyId + "/issues")
      .query({ view: "import" }).expect(200);
    expect(response.body).toMatchObject({ schema: "paperclip.issue-import-inventory.v1", visibility: "all",
      companyId: company.companyId, totalCount: 0, nextOffset: null, items: [] });
  });
});
