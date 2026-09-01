import { describe, expect, it } from "vitest";
import { validateOpenClawIsolationSnapshot } from "./isolation.js";

describe("validateOpenClawIsolationSnapshot", () => {
  it("accepts only the selected, sandboxed non-default agent", () => {
    expect(
      validateOpenClawIsolationSnapshot(
        {
          sourceConfig: {
            agents: {
              defaults: { sandbox: { mode: "all", scope: "session" } },
              list: [{ id: "tenant-a" }],
            },
          },
        },
        "tenant-a",
      ),
    ).toEqual({ ok: true });
  });

  it("fails closed when the configured tenant agent is absent", () => {
    expect(
      validateOpenClawIsolationSnapshot(
        {
          sourceConfig: {
            agents: {
              defaults: { sandbox: { mode: "all" } },
              list: [{ id: "tenant-b" }],
            },
          },
        },
        "tenant-a",
      ),
    ).toMatchObject({ ok: false, code: "openclaw_gateway_agent_not_found" });
  });

  it("fails closed when sandbox.mode is off", () => {
    expect(
      validateOpenClawIsolationSnapshot(
        {
          resolved: {
            agents: {
              defaults: { sandbox: { mode: "off" } },
              list: [{ id: "tenant-a" }],
            },
          },
        },
        "tenant-a",
      ),
    ).toMatchObject({ ok: false, code: "openclaw_gateway_sandbox_not_enforced" });
  });

  it("rejects main, default agents, and shared sandbox scope", () => {
    expect(validateOpenClawIsolationSnapshot({}, "main")).toMatchObject({
      ok: false,
      code: "openclaw_gateway_main_agent_forbidden",
    });
    expect(
      validateOpenClawIsolationSnapshot(
        { agents: { list: [{ id: "tenant-a", default: true, sandbox: { mode: "all" } }] } },
        "tenant-a",
      ),
    ).toMatchObject({ ok: false, code: "openclaw_gateway_main_agent_forbidden" });
    expect(
      validateOpenClawIsolationSnapshot(
        { agents: { list: [{ id: "tenant-a", sandbox: { mode: "all", scope: "shared" } }] } },
        "tenant-a",
      ),
    ).toMatchObject({ ok: false, code: "openclaw_gateway_sandbox_scope_shared" });
  });
});
