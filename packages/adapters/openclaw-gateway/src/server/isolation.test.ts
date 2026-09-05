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

  it("prefers the effective runtime policy over a safer source view", () => {
    expect(
      validateOpenClawIsolationSnapshot(
        {
          runtimeConfig: {
            agents: {
              defaults: { sandbox: { mode: "off" } },
              list: [{ id: "tenant-a" }],
            },
          },
          sourceConfig: {
            agents: {
              defaults: { sandbox: { mode: "all" } },
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

describe("CLI process isolation", () => {
  function snapshot(defaultModel: unknown, agentModel?: unknown, extraDefaults: Record<string, unknown> = {}) {
    return { agents: {
      defaults: { model: defaultModel, sandbox: { mode: "all", scope: "agent" }, ...extraDefaults },
      list: [{ id: "tenant-a", ...(agentModel !== undefined ? { model: agentModel } : {}) }],
    } };
  }
  const embedded = "anthropic/claude-sonnet-5";
  const rejection = { ok: false, code: "openclaw_gateway_cli_process_isolation_unverified" };

  it.each(["claude-cli/claude-sonnet-5", "google-gemini-cli/gemini-pro", " CLAUDE-CLI/sonnet "])(
    "rejects builtin CLI primary %s despite sandbox.mode=all", (model) => {
      expect(validateOpenClawIsolationSnapshot(snapshot(model), "tenant-a")).toMatchObject(rejection);
    },
  );

  it("rejects per-agent primary and explicitly selected fallback", () => {
    expect(validateOpenClawIsolationSnapshot(snapshot(embedded, "claude-cli/sonnet"), "tenant-a"))
      .toMatchObject(rejection);
    expect(validateOpenClawIsolationSnapshot(
      snapshot(embedded, { primary: embedded, fallbacks: ["google-gemini-cli/pro"] }), "tenant-a",
    )).toMatchObject(rejection);
  });

  it("rejects inherited CLI fallback when agent has no model override", () => {
    expect(validateOpenClawIsolationSnapshot(
      snapshot({ primary: embedded, fallbacks: ["claude-cli/sonnet"] }), "tenant-a",
    )).toMatchObject(rejection);
  });

  it("inherits primary with a fallback-only agent override", () => {
    expect(validateOpenClawIsolationSnapshot(
      snapshot("claude-cli/sonnet", { fallbacks: [] }), "tenant-a",
    )).toMatchObject(rejection);
    expect(validateOpenClawIsolationSnapshot(
      snapshot(embedded, { fallbacks: ["claude-cli/sonnet"] }), "tenant-a",
    )).toMatchObject(rejection);
  });

  it.each([embedded, { primary: embedded }, { primary: embedded, fallbacks: [] }])(
    "does not inherit overridden default fallbacks for %j", (model) => {
      expect(validateOpenClawIsolationSnapshot(
        snapshot({ primary: "claude-cli/sonnet", fallbacks: ["claude-cli/haiku"] }, model), "tenant-a",
      )).toEqual({ ok: true });
    },
  );

  it("rejects declared custom CLI providers without reading command or credentials", () => {
    const config = snapshot(
      { primary: embedded, fallbacks: [" CUSTOM-CLI/model "] }, undefined,
      { cliBackends: { "custom-cli": { command: "SYNTHETIC_DO_NOT_ECHO" } } },
    );
    const result = validateOpenClawIsolationSnapshot(config, "tenant-a");
    expect(result).toMatchObject(rejection);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_DO_NOT_ECHO");
  });

  it("rejects CLI model aliases and auth-profile suffixes", () => {
    expect(validateOpenClawIsolationSnapshot(snapshot("worker@profile", undefined, {
      models: { "claude-cli/sonnet": { alias: "worker" } },
    }), "tenant-a")).toMatchObject(rejection);
    expect(validateOpenClawIsolationSnapshot(snapshot(embedded, {
      primary: embedded, fallbacks: ["cli-reviewer"],
    }, {
      models: { "custom-cli/model": { alias: "cli-reviewer" } },
      cliBackends: { "CUSTOM-CLI": {} },
    }), "tenant-a")).toMatchObject(rejection);
  });

  it("accepts embedded routes without rejecting an unrelated configured CLI", () => {
    expect(validateOpenClawIsolationSnapshot(snapshot(
      { primary: embedded, fallbacks: ["google/gemini-pro"] }, undefined,
      { cliBackends: { "custom-cli": {} } },
    ), "tenant-a")).toEqual({ ok: true });
  });

  it("prefers a CLI runtime model over a safer source configuration", () => {
    expect(validateOpenClawIsolationSnapshot({
      runtimeConfig: snapshot("claude-cli/sonnet"),
      sourceConfig: snapshot(embedded),
    }, "tenant-a")).toMatchObject(rejection);
  });
});
