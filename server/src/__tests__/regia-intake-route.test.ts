import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { accept, preflight } = vi.hoisted(() => ({ accept: vi.fn(), preflight: vi.fn() }));
vi.mock("../services/regia-intake.js", () => ({
  regiaIntakeService: () => ({ accept, preflight }),
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
    preflight.mockReset();
    preflight.mockImplementation(async (_companyId, body) => body.binding);
    accept.mockResolvedValue({
      companyId: COMPANY_ID,
      created: true,
      executionAuthorized: false,
      policyConfigured: false,
      blockingGate: "policy_configuration_required",
      approvalId: "77777777-7777-4777-8777-777777777777",
      approvalStatus: "pending",
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
    expect(response.body).toEqual(expect.objectContaining({
      approvalId: "77777777-7777-4777-8777-777777777777",
      approvalStatus: "pending",
      executionAuthorized: false,
      policyConfigured: false,
      blockingGate: "policy_configuration_required",
    }));
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

describe("Regia intake read-only preflight HTTP contract", () => {
  const endpoint = `/api/companies/${COMPANY_ID}/regia/intake/preflight`;
  const board = {
    type: "board", source: "board_key", userId: "scoped-operator",
    companyIds: [COMPANY_ID], isInstanceAdmin: false,
    memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "member" }],
  };
  beforeEach(() => {
    accept.mockReset();
    preflight.mockReset();
    preflight.mockImplementation(async (_companyId, body) => body.binding);
  });

  it("returns the actual principal and complete normalized binding without accepting work", async () => {
    const body = structuredClone({ binding: validBody.binding });
    delete (body.binding.credentialSecretRef as { version?: string }).version;
    const result = await request(await makeApp(board)).post(endpoint).send(body);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      schemaVersion: 1, capability: "regia_intake_preflight_v1",
      companyId: COMPANY_ID, binding: validBody.binding,
      actor: { userId: board.userId, source: "board_key", companyIds: [COMPANY_ID], isInstanceAdmin: false },
      executionAuthorized: false, intakeAvailable: true,
    });
    expect(preflight).toHaveBeenCalledWith(COMPANY_ID, { binding: validBody.binding });
    expect(accept).not.toHaveBeenCalled();
  });

  it("exposes broader/session privileges truthfully so a receiver can reject them", async () => {
    const companyIds = [COMPANY_ID, "77777777-7777-4777-8777-777777777777"];
    const result = await request(await makeApp({
      ...board, source: "session", companyIds, isInstanceAdmin: true,
    })).post(endpoint).send({ binding: validBody.binding });
    expect(result.status).toBe(200);
    expect(result.body.actor).toEqual({
      userId: board.userId, source: "session", companyIds, isInstanceAdmin: true,
    });
    expect(result.body.executionAuthorized).toBe(false);
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    ["agent", { type: "agent", companyId: COMPANY_ID, agentId: "agent", source: "agent_key" }],
    ["anonymous", { type: "none" }],
    ["foreign tenant", { ...board, companyIds: [] }],
    ["viewer", { ...board, memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "viewer" }] }],
    ["inactive member", { ...board, memberships: [{ companyId: COMPANY_ID, status: "inactive", membershipRole: "member" }] }],
    ["missing user", { ...board, userId: undefined }],
    ["empty user", { ...board, userId: " " }],
    ["fallback board", { ...board, userId: "board" }],
    ["missing source", { ...board, source: undefined }],
  ])("rejects %s before either preflight or intake service", async (_name, actor) => {
    const app = await makeApp(actor);
    expect((await request(app).post(endpoint).send({ binding: validBody.binding })).status).toBe(403);
    expect((await request(app).post(`/api/companies/${COMPANY_ID}/regia/intake`).send(validBody)).status).toBe(403);
    expect(preflight).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    { binding: validBody.binding, actor: board },
    { binding: validBody.binding, executionAuthorized: true },
    { binding: { ...validBody.binding, companyId: COMPANY_ID } },
    { binding: { ...validBody.binding, regiaAgentId: "not-uuid" } },
    { binding: { ...validBody.binding, credentialSecretRef: { ...validBody.binding.credentialSecretRef, value: "not-allowed" } } },
    { binding: { ...validBody.binding, credentialSecretRef: { ...validBody.binding.credentialSecretRef, version: 0 } } },
    {},
  ])("rejects an invalid or authority-bearing body %#", async (body) => {
    const result = await request(await makeApp(board)).post(endpoint).send(body);
    expect(result.status).toBe(400);
    expect(preflight).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
});
