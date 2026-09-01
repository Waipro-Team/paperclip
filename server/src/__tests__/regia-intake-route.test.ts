import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const accept = vi.hoisted(() => vi.fn());
vi.mock("../services/regia-intake.js", () => ({
  regiaIntakeService: () => ({ accept }),
}));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const validBody = {
  idempotencyKey: "board:route:001",
  objective: "Complete Team Regia",
  binding: {
    regiaAgentId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    projectWorkspaceId: "44444444-4444-4444-8444-444444444444",
    environmentId: "55555555-5555-4555-8555-555555555555",
    credentialSecretRef: {
      type: "secret_ref",
      secretId: "66666666-6666-4666-8666-666666666666",
      version: "latest",
    },
  },
};

async function makeApp(actor: Record<string, unknown>) {
  const { errorHandler } = await import("../middleware/index.js");
  const { regiaIntakeRoutes } = await import("../routes/regia-intake.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", regiaIntakeRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("Regia intake route authorization and body contract", () => {
  beforeEach(() => {
    accept.mockReset();
    accept.mockResolvedValue({
      companyId: COMPANY_ID,
      created: true,
      executionAuthorized: false,
      policyConfigured: false,
      blockingGate: "policy_configuration_required",
      receipt: { kind: "intake", activityId: "receipt", action: "regia.intake.accepted" },
    });
  });

  it("accepts a scoped board member and passes only the validated body", async () => {
    const app = await makeApp({
      type: "board",
      source: "session",
      userId: "cristian",
      sessionId: "session-1",
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "owner" }],
      isInstanceAdmin: false,
    });
    const response = await request(app).post(`/api/companies/${COMPANY_ID}/regia/intake`).send(validBody);
    expect(response.status).toBe(201);
    expect(accept).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ ...validBody, constraints: [], kpis: [], gates: [] }),
      { actorType: "user", actorId: "cristian" },
    );
  });

  it("rejects a non-board actor and a board member outside the company", async () => {
    const agentApp = await makeApp({
      type: "agent",
      source: "agent_key",
      agentId: "agent-1",
      companyId: COMPANY_ID,
    });
    expect((await request(agentApp).post(`/api/companies/${COMPANY_ID}/regia/intake`).send(validBody)).status).toBe(403);

    const foreignBoardApp = await makeApp({
      type: "board",
      source: "session",
      userId: "cristian",
      sessionId: "session-2",
      companyIds: ["77777777-7777-4777-8777-777777777777"],
      memberships: [{
        companyId: "77777777-7777-4777-8777-777777777777",
        status: "active",
        membershipRole: "owner",
      }],
      isInstanceAdmin: false,
    });
    expect((await request(foreignBoardApp).post(`/api/companies/${COMPANY_ID}/regia/intake`).send(validBody)).status)
      .toBe(403);
    expect(accept).not.toHaveBeenCalled();
  });

  it("rejects malformed or unknown body fields before the service", async () => {
    const app = await makeApp({
      type: "board",
      source: "session",
      userId: "cristian",
      sessionId: "session-3",
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "owner" }],
      isInstanceAdmin: false,
    });
    const response = await request(app).post(`/api/companies/${COMPANY_ID}/regia/intake`).send({
      ...validBody,
      unexpected: "must fail",
    });
    expect(response.status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });
});
