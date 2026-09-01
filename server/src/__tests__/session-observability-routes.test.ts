import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRead = vi.hoisted(() => vi.fn());

vi.mock("../services/session-observability.js", () => ({
  sessionObservabilityService: () => ({ read: mockRead }),
}));

async function createApp(companyIds: string[]) {
  vi.resetModules();
  const [{ errorHandler }, { sessionObservabilityRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/session-observability.js") as Promise<typeof import("../routes/session-observability.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
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
  beforeEach(() => mockRead.mockReset());

  it("returns the company-scoped redacted read model", async () => {
    mockRead.mockResolvedValue({ nodes: [], messages: [] });
    const response = await request(await createApp(["company-tec"]))
      .get("/api/companies/company-tec/session-observability");

    expect(response.status).toBe(200);
    expect(mockRead).toHaveBeenCalledWith("company-tec");
    expect(response.body).toEqual({ nodes: [], messages: [] });
  });

  it("rejects access to another company's observability data", async () => {
    const response = await request(await createApp(["company-tec"]))
      .get("/api/companies/company-mrphone/session-observability");

    expect(response.status).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
  });
});
