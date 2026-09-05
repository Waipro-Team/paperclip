import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyMemberships } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";

const accept = vi.hoisted(() => vi.fn());
vi.mock("../services/regia-intake.js", () => ({ regiaIntakeService: () => ({ accept }) }));
import { regiaIntakeRoutes } from "../routes/regia-intake.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ABSENT = "/api/companies/" + COMPANY + "/regia/not-a-route";
const INTAKE = "/api/companies/" + COMPANY + "/regia/intake";
const BODY = {
  idempotencyKey: "synthetic:preflight:001", objective: "Synthetic route preflight",
  binding: {
    regiaAgentId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    projectWorkspaceId: "44444444-4444-4444-8444-444444444444",
    environmentId: "55555555-5555-4555-8555-555555555555",
    credentialSecretRef: { type: "secret_ref", secretId: "66666666-6666-4666-8666-666666666666", version: "latest" },
  },
};

function fixture(session = false) {
  let reads = 0;
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: () => {
      reads++;
      return Promise.resolve(table === companyMemberships
        ? [{ companyId: COMPANY, status: "active", membershipRole: "owner" }]
        : []);
    } }) }),
    insert: () => { throw new Error("preflight DB mutation forbidden"); },
    update: () => { throw new Error("preflight DB mutation forbidden"); },
    delete: () => { throw new Error("preflight DB mutation forbidden"); },
  } as any;
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, {
    deploymentMode: "authenticated",
    resolveSession: async () => session ? {
      user: { id: "synthetic-board", name: "Synthetic Board", email: "board@example.invalid" },
      session: { id: "synthetic-session" },
    } as any : null,
  }));
  app.use("/api", boardMutationGuard(), regiaIntakeRoutes(db));
  app.use(errorHandler);
  return { app, reads: () => reads };
}

describe("Intake presence preflight through actual authentication middleware", () => {
  beforeEach(() => {
    accept.mockReset();
    accept.mockResolvedValue({ companyId: COMPANY, created: true, executionAuthorized: false,
      policyConfigured: false, blockingGate: "policy_configuration_required",
      receipt: { kind: "intake", action: "regia.intake.accepted", activityId: "synthetic-only" } });
  });

  it("401 alone proves no route presence: an empty bearer rejects existing and absent paths", async () => {
    const { app, reads } = fixture();
    for (const route of [INTAKE, ABSENT]) {
      const response = await request(app).post(route).set("Authorization", "Bearer").send(BODY);
      expect(response.status).toBe(401);
      expect(response.body.error).toMatch(/Empty bearer token/);
    }
    expect(reads()).toBe(0);
    expect(accept).not.toHaveBeenCalled();
  });

  it("a scoped board session distinguishes accepted intake from missing API without authorizing execution", async () => {
    const { app } = fixture(true);
    const accepted = await request(app).post(INTAKE).set("Origin", "http://localhost:3100").send(BODY);
    expect(accepted.status).toBe(201);
    expect(accepted.body.executionAuthorized).toBe(false);
    expect(accepted.body.blockingGate).toBe("policy_configuration_required");
    expect(accept).toHaveBeenCalledOnce();
    const missing = await request(app).post(ABSENT).set("Origin", "http://localhost:3100").send(BODY);
    expect(missing.status).toBe(404);
    expect(accept).toHaveBeenCalledOnce();
  });

  it("an unauthenticated request or untrusted browser origin never reaches the intake service", async () => {
    const anonymous = fixture();
    expect((await request(anonymous.app).post(INTAKE).send(BODY)).status).toBe(403);
    const board = fixture(true);
    expect((await request(board.app).post(INTAKE).set("Origin", "https://untrusted.invalid").send(BODY)).status).toBe(403);
    expect(accept).not.toHaveBeenCalled();
  });
});
