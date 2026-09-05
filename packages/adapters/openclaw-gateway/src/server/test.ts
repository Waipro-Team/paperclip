import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  validateOpenClawExecutionIsolation,
  type OpenClawIsolationFailure,
} from "./isolation.js";

type GatewayProbeResult =
  | { status: "ok" }
  | { status: "challenge_only" }
  | { status: "failed" }
  | { status: "isolation_failed"; failure: OpenClawIsolationFailure };

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function headerMapGetIgnoreCase(headers: Record<string, string>, key: string): string | null {
  const match = Object.entries(headers).find(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase());
  return match ? match[1] : null;
}

function tokenFromAuthHeader(rawHeader: string | null): string | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^bearer\s+(.+)$/i);
  return match ? nonEmpty(match[1]) : trimmed;
}

function resolveAuthToken(config: Record<string, unknown>, headers: Record<string, string>): string | null {
  const explicit = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  if (explicit) return explicit;

  const tokenHeader = headerMapGetIgnoreCase(headers, "x-openclaw-token");
  if (nonEmpty(tokenHeader)) return nonEmpty(tokenHeader);

  const authHeader =
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    headerMapGetIgnoreCase(headers, "authorization");
  return tokenFromAuthHeader(authHeader);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), "utf8"))),
    ).toString("utf8");
  }
  return String(data ?? "");
}

async function probeGateway(input: {
  url: string;
  headers: Record<string, string>;
  authToken: string | null;
  role: string;
  scopes: string[];
  timeoutMs: number;
  agentId: string;
}): Promise<GatewayProbeResult> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(input.url, { headers: input.headers, maxPayload: 2 * 1024 * 1024 });
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve({ status: "failed" });
    }, input.timeoutMs);

    let completed = false;
    let connectRequestId: string | null = null;
    let configRequestId: string | null = null;

    const finish = (result: GatewayProbeResult) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(raw));
      } catch {
        return;
      }
      const event = asRecord(parsed);
      if (event?.type === "event" && event.event === "connect.challenge") {
        const nonce = nonEmpty(asRecord(event.payload)?.nonce);
        if (!nonce) {
          finish({ status: "failed" });
          return;
        }

        connectRequestId = randomUUID();
        ws.send(
          JSON.stringify({
            type: "req",
            id: connectRequestId,
            method: "connect",
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              client: {
                id: "gateway-client",
                version: "paperclip-probe",
                platform: process.platform,
                mode: "probe",
              },
              role: input.role,
              scopes: input.scopes,
              ...(input.authToken
                ? {
                    auth: {
                      token: input.authToken,
                    },
                  }
                : {}),
            },
          }),
        );
        return;
      }

      if (event?.type === "res") {
        if (event.id === connectRequestId) {
          if (event.ok !== true) {
            finish({ status: "challenge_only" });
            return;
          }
          configRequestId = randomUUID();
          ws.send(
            JSON.stringify({
              type: "req",
              id: configRequestId,
              method: "config.get",
              params: {},
            }),
          );
          return;
        }

        if (event.id === configRequestId) {
          if (event.ok !== true) {
            finish({
              status: "isolation_failed",
              failure: {
                ok: false,
                code: "openclaw_gateway_isolation_unverified",
                message: "OpenClaw rejected the configuration isolation probe.",
              },
            });
            return;
          }
          const validation = validateOpenClawExecutionIsolation(event.payload, input.agentId, {
            agentId: input.agentId,
            sessionKey: `agent:${input.agentId}:paperclip:probe`,
          });
          finish(
            validation.ok
              ? { status: "ok" }
              : { status: "isolation_failed", failure: validation },
          );
        }
      }
    });

    ws.on("error", () => {
      finish({ status: "failed" });
    });

    ws.on("close", () => {
      if (!completed) finish({ status: "failed" });
    });
  });
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  if (ctx.executionTarget?.kind === "remote") {
    checks.push({
      code: "openclaw_gateway_execution_target_unsupported",
      level: "error",
      message:
        "OpenClaw gateway cannot honor a remote Paperclip execution target; the probe was not run from the requested target.",
      hint: "Use a local execution target until this adapter has target-aware WebSocket transport.",
    });
  }

  const configuredAgentId = nonEmpty(config.agentId);
  if (!configuredAgentId) {
    checks.push({
      code: "openclaw_gateway_agent_id_missing",
      level: "error",
      message: "OpenClaw gateway adapter requires an explicit agentId.",
      hint: "Set adapterConfig.agentId to a dedicated, non-default OpenClaw agent.",
    });
  } else if (configuredAgentId.toLowerCase() === "main") {
    checks.push({
      code: "openclaw_gateway_main_agent_forbidden",
      level: "error",
      message: "The OpenClaw main/default agent cannot be used by the Paperclip gateway adapter.",
      hint: "Create and configure a dedicated tenant agent with sandbox.mode=all.",
    });
  }

  const templateAgentId = nonEmpty(parseObject(config.payloadTemplate).agentId);
  if (configuredAgentId && templateAgentId && templateAgentId !== configuredAgentId) {
    checks.push({
      code: "openclaw_gateway_agent_id_mismatch",
      level: "error",
      message: "payloadTemplate.agentId must match the configured OpenClaw agentId.",
      hint: "Remove payloadTemplate.agentId or make it identical to adapterConfig.agentId.",
    });
  }

  const urlValue = asString(config.url, "").trim();

  if (!urlValue) {
    checks.push({
      code: "openclaw_gateway_url_missing",
      level: "error",
      message: "OpenClaw gateway adapter requires a WebSocket URL.",
      hint: "Set adapterConfig.url to ws://host:port (or wss://).",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let url: URL | null = null;
  try {
    url = new URL(urlValue);
  } catch {
    checks.push({
      code: "openclaw_gateway_url_invalid",
      level: "error",
      message: `Invalid URL: ${urlValue}`,
    });
  }

  if (url && url.protocol !== "ws:" && url.protocol !== "wss:") {
    checks.push({
      code: "openclaw_gateway_url_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${url.protocol}`,
      hint: "Use ws:// or wss://.",
    });
  }

  if (url) {
    checks.push({
      code: "openclaw_gateway_url_valid",
      level: "info",
      message: `Configured gateway URL: ${url.toString()}`,
    });

    if (url.protocol === "ws:" && !isLoopbackHost(url.hostname)) {
      checks.push({
        code: "openclaw_gateway_plaintext_remote_ws",
        level: "warn",
        message: "Gateway URL uses plaintext ws:// on a non-loopback host.",
        hint: "Prefer wss:// for remote gateways.",
      });
    }
  }

  const headers = toStringRecord(config.headers);
  const authToken = resolveAuthToken(config, headers);
  const password = nonEmpty(config.password);
  const role = nonEmpty(config.role) ?? "operator";
  const scopes = toStringArray(config.scopes);

  if (authToken || password) {
    checks.push({
      code: "openclaw_gateway_auth_present",
      level: "info",
      message: "Gateway credentials are configured.",
    });
  } else {
    checks.push({
      code: "openclaw_gateway_auth_missing",
      level: "warn",
      message: "No gateway credentials detected in adapter config.",
      hint: "Set authToken/password or headers.x-openclaw-token for authenticated gateways.",
    });
  }

  if (
    url &&
    configuredAgentId &&
    !checks.some((check) => check.level === "error") &&
    (url.protocol === "ws:" || url.protocol === "wss:")
  ) {
    try {
      const probeResult = await probeGateway({
        url: url.toString(),
        headers,
        authToken,
        role,
        scopes: scopes.length > 0 ? scopes : ["operator.admin"],
        timeoutMs: 3_000,
        agentId: configuredAgentId,
      });

      if (probeResult.status === "ok") {
        checks.push({
          code: "openclaw_gateway_probe_ok",
          level: "info",
          message: `Gateway connect and isolation probe succeeded for agent ${configuredAgentId}.`,
        });
      } else if (probeResult.status === "challenge_only") {
        checks.push({
          code: "openclaw_gateway_probe_challenge_only",
          level: "warn",
          message: "Gateway challenge was received, but connect probe was rejected.",
          hint: "Check gateway credentials, scopes, role, and device-auth requirements.",
        });
      } else if (probeResult.status === "isolation_failed") {
        checks.push({
          code: probeResult.failure.code,
          level: "error",
          message: probeResult.failure.message,
          hint: "A dedicated sandbox configuration is necessary but does not prove the execution boundary. Integrate a trusted tenant execution boundary before activation.",
        });
      } else {
        checks.push({
          code: "openclaw_gateway_probe_failed",
          level: "warn",
          message: "Gateway probe failed.",
          hint: "Verify network reachability and gateway URL from the Paperclip server host.",
        });
      }
    } catch (err) {
      checks.push({
        code: "openclaw_gateway_probe_error",
        level: "warn",
        message: err instanceof Error ? err.message : "Gateway probe failed",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
