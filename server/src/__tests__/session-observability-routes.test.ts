import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRead = vi.hoisted(() => vi.fn());
const mockDecide = vi.hoisted(() => vi.fn());

vi.mock("../services/session-observability.js", () => ({
  sessionObservabilityService: () => ({ read: mockRead }),
}));

vi.mock("../services/authorization.js", () => ({
  authorizationService: () => ({ decide: mockDecide }),
  authorizationDeniedDetails: (decision: { reason: string }) => ({ reason: decision.reason }),
}));

type TestActor = {
  type: "board" | "agent";
  companyIds?: string[];
  companyId?: string;
  userId?: string;
  agentId?: string;
  keyId?: string;
  keyScope?: { kind: "standard" } | { kind: "task_bridge"; parentIssueId: string };
  source: "session" | "agent_key";
  isInstanceAdmin?: boolean;
};

async function createApp(companyIds: string[], actor?: TestActor) {
  vi.resetModules();
  const [{ errorHandler }, { sessionObservabilityRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/session-observability.js") as Promise<typeof import("../routes/session-observability.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "operator",
      companyIds,
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", sessionObservabilityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("session observability routes", () => {
  beforeEach(() => {
    mockRead.mockReset();
    mockDecide.mockReset();
    mockDecide.mockImplementation(async ({ actor }: { actor: TestActor }) => (
      actor.keyScope?.kind === "task_bridge"
        ? { allowed: false, action: "company_scope:read", reason: "deny_scope", explanation: "Task bridge keys cannot use company-wide APIs." }
        : { allowed: true, action: "company_scope:read", reason: "allow_company_member", explanation: "Allowed." }
    ));
  });

  it("returns the company-scoped redacted read model to a board user", async () => {
    mockRead.mockResolvedValue({ nodes: [], messages: [] });
    const response = await request(await createApp(["company-tec"]))
      .get("/api/companies/company-tec/session-observability");

    expect(response.status).toBe(200);
    expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
      action: "company_scope:read",
      resource: { type: "company", companyId: "company-tec" },
    }));
    expect(mockRead).toHaveBeenCalledWith("company-tec");
    expect(response.body).toEqual({ nodes: [], messages: [] });
  });

  it("rejects a same-company task-bridge agent key before reading the graph", async () => {
    const response = await request(await createApp(["company-tec"], {
      type: "agent",
      companyId: "company-tec",
      agentId: "bridge-agent",
      keyId: "bridge-key",
      keyScope: { kind: "task_bridge", parentIssueId: "issue-root" },
      source: "agent_key",
    }))
      .get("/api/companies/company-tec/session-observability");

    expect(response.status).toBe(403);
    expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({ action: "company_scope:read" }));
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("rejects access to another company's observability data", async () => {
    const response = await request(await createApp(["company-tec"]))
      .get("/api/companies/company-mrphone/session-observability");

    expect(response.status).toBe(403);
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
  });
});
