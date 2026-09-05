type JsonRecord = Record<string, unknown>;

export type OpenClawIsolationFailure = {
  ok: false;
  code:
    | "openclaw_gateway_isolation_unverified"
    | "openclaw_gateway_agent_not_found"
    | "openclaw_gateway_main_agent_forbidden"
    | "openclaw_gateway_sandbox_not_enforced"
    | "openclaw_gateway_sandbox_scope_shared"
    | "openclaw_gateway_cli_process_isolation_unverified";
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
  // Prefer the effective runtime view. Source/resolved snapshots are useful
  // fallbacks for older gateways, but must not mask a weaker runtime policy.
  for (const key of ["runtimeConfig", "config", "sourceConfig", "resolved"] as const) {
    const candidate = asRecord(outer[key]);
    if (candidate) return candidate;
  }
  return outer;
}

function modelPrimary(value: unknown): string | null {
  return nonEmpty(value) ?? nonEmpty(asRecord(value)?.primary);
}

function modelFallbacks(value: unknown): string[] | undefined {
  const object = asRecord(value);
  if (object && Object.hasOwn(object, "fallbacks")) {
    return Array.isArray(object.fallbacks)
      ? object.fallbacks.map(nonEmpty).filter((ref): ref is string => ref !== null)
      : undefined;
  }
  // OpenClaw's explicit primary (including string shorthand) clears inherited
  // fallbacks unless the selected model object explicitly supplies them.
  return modelPrimary(value) ? [] : undefined;
}

function hasConfiguredCliRoute(defaults: JsonRecord | null, selected: JsonRecord): boolean {
  // Built-in CLI backends registered by the installed Anthropic/Google plugins.
  // Custom backends need not use a "-cli" name and override provider routing.
  const cliProviders = new Set([
    "claude-cli",
    "google-gemini-cli",
    ...Object.keys(asRecord(defaults?.cliBackends) ?? {}).map((id) => id.trim().toLowerCase()),
  ]);
  const primary = modelPrimary(selected.model) ?? modelPrimary(defaults?.model);
  const fallbacks = modelFallbacks(selected.model) ?? modelFallbacks(defaults?.model) ?? [];
  const catalog = asRecord(defaults?.models) ?? {};
  return [primary, ...fallbacks].some((raw) => {
    if (!raw) return false;
    // Alias/auth-profile syntax can otherwise conceal the actual CLI provider.
    const reference = raw.trim();
    const withoutProfile = reference.split("@", 1)[0].trim();
    const candidates = [reference, withoutProfile];
    for (const [key, value] of Object.entries(catalog)) {
      const alias = nonEmpty(asRecord(value)?.alias)?.toLowerCase();
      if (alias && [reference, withoutProfile].some((ref) => ref.toLowerCase() === alias)) {
        candidates.push(key);
      }
    }
    return candidates.some((ref) => {
      const slash = ref.indexOf("/");
      return slash > 0 && cliProviders.has(ref.slice(0, slash).trim().toLowerCase());
    });
  });
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

  if (hasConfiguredCliRoute(defaults, selected)) {
    return {
      ok: false,
      code: "openclaw_gateway_cli_process_isolation_unverified",
      message:
        "OpenClaw CLI backends require verified process isolation; sandbox.mode=all does not isolate native CLI tools. Use an embedded backend until that execution boundary is verifiable.",
    };
  }

  return { ok: true };
}
