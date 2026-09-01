type JsonRecord = Record<string, unknown>;

export type OpenClawIsolationFailure = {
  ok: false;
  code:
    | "openclaw_gateway_isolation_unverified"
    | "openclaw_gateway_agent_not_found"
    | "openclaw_gateway_main_agent_forbidden"
    | "openclaw_gateway_sandbox_not_enforced"
    | "openclaw_gateway_sandbox_scope_shared";
  message: string;
};

export type OpenClawIsolationValidation =
  | { ok: true }
  | OpenClawIsolationFailure;

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function configRoot(snapshot: unknown): JsonRecord | null {
  const outer = asRecord(snapshot);
  if (!outer) return null;
  for (const key of ["sourceConfig", "resolved", "config"] as const) {
    const candidate = asRecord(outer[key]);
    if (candidate) return candidate;
  }
  return outer;
}

/**
 * Fail-closed validation of the redacted configuration returned by OpenClaw
 * `config.get`. The snapshot is inspected in memory only and must never be
 * included in logs or adapter results because it may contain configuration
 * material unrelated to the selected agent.
 */
export function validateOpenClawIsolationSnapshot(
  snapshot: unknown,
  configuredAgentId: string,
): OpenClawIsolationValidation {
  if (configuredAgentId.trim().toLowerCase() === "main") {
    return {
      ok: false,
      code: "openclaw_gateway_main_agent_forbidden",
      message: "The OpenClaw main/default agent cannot be used by the Paperclip gateway adapter.",
    };
  }

  const root = configRoot(snapshot);
  const agents = asRecord(root?.agents);
  const configuredAgents = Array.isArray(agents?.list) ? agents.list : null;
  if (!configuredAgents) {
    return {
      ok: false,
      code: "openclaw_gateway_isolation_unverified",
      message: "OpenClaw did not return a verifiable agents.list configuration snapshot.",
    };
  }

  const selected = configuredAgents
    .map(asRecord)
    .find((entry) => nonEmpty(entry?.id) === configuredAgentId);
  if (!selected) {
    return {
      ok: false,
      code: "openclaw_gateway_agent_not_found",
      message: `Configured OpenClaw agent ${configuredAgentId} is not present in the gateway configuration.`,
    };
  }

  if (selected.default === true) {
    return {
      ok: false,
      code: "openclaw_gateway_main_agent_forbidden",
      message: "The OpenClaw main/default agent cannot be used by the Paperclip gateway adapter.",
    };
  }

  const defaults = asRecord(agents?.defaults);
  const selectedSandbox = asRecord(selected.sandbox);
  const defaultSandbox = asRecord(defaults?.sandbox);
  const sandboxMode = (
    nonEmpty(selectedSandbox?.mode) ?? nonEmpty(defaultSandbox?.mode) ?? "off"
  ).toLowerCase();
  if (sandboxMode !== "all") {
    return {
      ok: false,
      code: "openclaw_gateway_sandbox_not_enforced",
      message: `OpenClaw agent ${configuredAgentId} must have effective sandbox.mode=all.`,
    };
  }

  const sandboxScope = (
    nonEmpty(selectedSandbox?.scope) ?? nonEmpty(defaultSandbox?.scope) ?? "session"
  ).toLowerCase();
  if (sandboxScope === "shared") {
    return {
      ok: false,
      code: "openclaw_gateway_sandbox_scope_shared",
      message: `OpenClaw agent ${configuredAgentId} cannot use shared sandbox scope.`,
    };
  }

  return { ok: true };
}
