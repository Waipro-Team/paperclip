#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RECEIPT_SCHEMA_VERSION = 1;
const DEFAULT_API_BASE = "http://127.0.0.1:3100";
const DEFAULT_AUTH_STORE = "/var/lib/portal360/paperclip/cli/auth.json";
const DEFAULT_OPENCLAW_CONFIG = "/home/claw360/.openclaw/openclaw.json";
const DEFAULT_EXPECTED_COMMIT = "542cfbba0d78440f153ae1e11285170825ed4a8d";
const REDACTED_SENTINEL = "***REDACTED***";
const SECRET_FIELDS = new Set(["authToken", "token", "password", "devicePrivateKeyPem"]);
const LEGACY_AUTH_HEADERS = new Set(["authorization", "x-openclaw-token", "x-openclaw-auth"]);
const SENSITIVE_ENV_KEY_RE = /(api[-_]?(?:key|token)|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

function usage() {
  return `Usage:
  node scripts/smoke/openclaw-secret-ref-canary.mjs preflight \\
    --company-id <uuid> --canary-agent-id <uuid> --fleet-agent-ids <uuid,...> \\
    --receipt <absolute-path>

  node scripts/smoke/openclaw-secret-ref-canary.mjs apply [same options]
  node scripts/smoke/openclaw-secret-ref-canary.mjs verify --receipt <absolute-path>
  node scripts/smoke/openclaw-secret-ref-canary.mjs rollback --receipt <absolute-path>

Options:
  --api-base <url>             Default: ${DEFAULT_API_BASE}
  --auth-store <path>          Default: ${DEFAULT_AUTH_STORE}
  --openclaw-config <path>     Default: ${DEFAULT_OPENCLAW_CONFIG}
  --expected-commit <sha>      Default: ${DEFAULT_EXPECTED_COMMIT}
  --allow-commit-drift         Explicit emergency override for verify/rollback

The script never prints or stores the OpenClaw gateway token or Paperclip board token.
Apply runs a canary adapter probe first, rolls back automatically on failure, then
binds and probes the remaining exact agent ids. Rollback restores adapter configs
but intentionally retains the newly created, encrypted secret for recoverability.`;
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!mode || mode === "--help" || mode === "-h") return { help: true };
  if (!["preflight", "apply", "verify", "rollback"].includes(mode)) {
    throw new Error(`Unsupported mode: ${mode}`);
  }
  const values = { mode, allowCommitDrift: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--allow-commit-drift") {
      values.allowCommitDrift = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
    index += 1;
  }
  values.apiBase = normalizeApiBase(values.apiBase ?? DEFAULT_API_BASE);
  values.authStore = values.authStore ?? DEFAULT_AUTH_STORE;
  values.openclawConfig = values.openclawConfig ?? DEFAULT_OPENCLAW_CONFIG;
  values.expectedCommit = values.expectedCommit ?? DEFAULT_EXPECTED_COMMIT;
  if (values.allowCommitDrift && mode !== "verify" && mode !== "rollback") {
    throw new Error("--allow-commit-drift is only permitted for verify or rollback");
  }
  if (!values.receipt || !path.isAbsolute(values.receipt)) {
    throw new Error("--receipt must be an absolute path");
  }
  if (mode === "preflight" || mode === "apply") {
    if (!values.companyId || !values.canaryAgentId || !values.fleetAgentIds) {
      throw new Error("--company-id, --canary-agent-id, and --fleet-agent-ids are required");
    }
    values.fleetAgentIds = values.fleetAgentIds.split(",").map((value) => value.trim()).filter(Boolean);
    if (new Set(values.fleetAgentIds).size !== values.fleetAgentIds.length) {
      throw new Error("--fleet-agent-ids contains duplicates");
    }
    if (!values.fleetAgentIds.includes(values.canaryAgentId)) {
      throw new Error("--canary-agent-id must be included in --fleet-agent-ids");
    }
  }
  return values;
}

function normalizeApiBase(value) {
  return String(value).trim().replace(/\/+$/, "");
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretRef(value) {
  return isPlainRecord(value)
    && value.type === "secret_ref"
    && typeof value.secretId === "string"
    && value.secretId.length > 0;
}

export function assertReceiptSafeAdapterConfig(config, label = "adapterConfig") {
  if (!isPlainRecord(config)) throw new Error(`${label} must be an object`);
  const visit = (value, keyPath) => {
    if (value === REDACTED_SENTINEL) {
      throw new Error(`${keyPath} is redacted and cannot be used for rollback`);
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${keyPath}[${index}]`));
      return;
    }
    if (!isPlainRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = `${keyPath}.${key}`;
      if (keyPath === label && SECRET_FIELDS.has(key) && nested !== undefined && !isSecretRef(nested)) {
        throw new Error(`${nextPath} must be a secret_ref before it can enter a receipt`);
      }
      if (keyPath === `${label}.headers` && LEGACY_AUTH_HEADERS.has(key.toLowerCase())) {
        throw new Error(`${nextPath} is a legacy auth header and cannot enter a receipt`);
      }
      if (keyPath === `${label}.env` && SENSITIVE_ENV_KEY_RE.test(key)) {
        if (!isSecretRef(nested) && !(isPlainRecord(nested) && nested.type === "user_secret_ref")) {
          throw new Error(`${nextPath} must use a secret reference`);
        }
      }
      visit(nested, nextPath);
    }
  };
  visit(config, label);
}

function publicAgentSnapshot(agent) {
  const adapterConfig = structuredClone(agent.adapterConfig ?? {});
  assertReceiptSafeAdapterConfig(adapterConfig);
  return {
    id: agent.id,
    name: agent.name,
    companyId: agent.companyId,
    status: agent.status,
    adapterType: agent.adapterType,
    previousAdapterConfig: adapterConfig,
    applied: false,
    mutationState: "untouched",
    smoke: null,
  };
}

function appendEvent(receipt, event, details = {}) {
  receipt.updatedAt = new Date().toISOString();
  receipt.events.push({ at: receipt.updatedAt, event, ...details });
}

async function writeReceipt(filePath, receipt) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}`;
  const safe = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(temp, safe, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, filePath);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function loadSourceToken(filePath) {
  const config = await readJson(filePath);
  const token = config?.gateway?.auth?.token;
  if (config?.gateway?.auth?.mode !== "token" || typeof token !== "string" || token.trim().length < 16) {
    throw new Error("OpenClaw gateway token mode is not configured with a usable token");
  }
  return token;
}

async function loadBoardToken(filePath, apiBase) {
  const store = await readJson(filePath);
  const credential = store?.credentials?.[normalizeApiBase(apiBase)];
  if (!credential || typeof credential.token !== "string" || credential.token.trim().length === 0) {
    throw new Error(`No Paperclip board credential exists for ${apiBase}`);
  }
  return credential.token;
}

function sanitizedErrorCode(body) {
  if (!isPlainRecord(body)) return null;
  if (typeof body.code === "string") return body.code;
  if (isPlainRecord(body.details) && typeof body.details.code === "string") return body.details.code;
  return null;
}

function makeApi(apiBase, boardToken, fetchImpl = fetch) {
  return async (method, apiPath, body) => {
    const response = await fetchImpl(`${apiBase}/api${apiPath}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${boardToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Paperclip ${method} ${apiPath} failed: HTTP ${response.status}${sanitizedErrorCode(payload) ? ` code=${sanitizedErrorCode(payload)}` : ""}`);
    }
    return payload;
  };
}

async function checkHealth(api, expectedCommit, allowCommitDrift) {
  const health = await api("GET", "/health");
  if (health?.status !== "ok") throw new Error("Paperclip health is not ok");
  if (!allowCommitDrift && health.commit !== expectedCommit) {
    throw new Error(`Paperclip commit mismatch: expected ${expectedCommit}, observed ${health.commit ?? "missing"}`);
  }
  return {
    status: health.status,
    commit: health.commit ?? null,
    deploymentMode: health.deploymentMode ?? null,
    deploymentExposure: health.deploymentExposure ?? null,
  };
}

async function checkLocalEncryptedProvider(api, companyId) {
  const result = await api("GET", `/companies/${companyId}/secret-providers/health`);
  const providers = Array.isArray(result?.providers) ? result.providers : [];
  const local = providers.find((provider) => provider?.provider === "local_encrypted");
  if (local?.status !== "ok") {
    throw new Error("Paperclip local_encrypted secret provider is not healthy");
  }
  return { provider: "local_encrypted", status: "ok" };
}

async function loadAndValidateTargets(api, companyId, canaryAgentId, fleetAgentIds) {
  const company = await api("GET", `/companies/${companyId}`);
  if (company?.id !== companyId) throw new Error("Company identity mismatch");
  const orderedIds = [canaryAgentId, ...fleetAgentIds.filter((id) => id !== canaryAgentId)];
  const targets = [];
  for (const id of orderedIds) {
    const agent = await api("GET", `/agents/${id}`);
    if (agent?.id !== id || agent?.companyId !== companyId) {
      throw new Error(`Agent ${id} failed the company boundary check`);
    }
    if (agent.adapterType !== "openclaw_gateway") {
      throw new Error(`Agent ${id} is not an openclaw_gateway agent`);
    }
    const snapshot = publicAgentSnapshot(agent);
    if (snapshot.previousAdapterConfig.authToken !== undefined) {
      throw new Error(`Agent ${id} already has authToken; refusing an ambiguous migration`);
    }
    if (snapshot.previousAdapterConfig.token !== undefined) {
      throw new Error(`Agent ${id} already has legacy token; refusing an ambiguous migration`);
    }
    targets.push(snapshot);
  }
  return { companyName: company.name ?? null, targets };
}

function smokeSummary(result) {
  return {
    status: result?.status ?? "missing",
    testedAt: result?.testedAt ?? null,
    checks: Array.isArray(result?.checks)
      ? result.checks.map((check) => ({ code: check?.code ?? null, level: check?.level ?? null }))
      : [],
  };
}

async function runAdapterSmoke(api, companyId, config) {
  const result = await api("POST", `/companies/${companyId}/adapters/openclaw_gateway/test-environment`, {
    adapterConfig: config,
  });
  const summary = smokeSummary(result);
  if (summary.status !== "pass") {
    throw Object.assign(new Error(`OpenClaw adapter smoke returned ${summary.status}`), { smoke: summary });
  }
  return summary;
}

async function restoreAppliedTargets(api, receipt) {
  const errors = [];
  for (const target of [...receipt.targets].reverse()) {
    const mayHaveMutated = target.applied
      || ["binding_pending", "bound", "rollback_failed"].includes(target.mutationState);
    if (!mayHaveMutated) continue;
    try {
      const restored = await api("PATCH", `/agents/${target.id}`, {
        replaceAdapterConfig: true,
        adapterConfig: target.previousAdapterConfig,
      });
      assertReceiptSafeAdapterConfig(restored?.adapterConfig ?? {});
      target.applied = false;
      target.mutationState = "rolled_back";
      appendEvent(receipt, "agent_rolled_back", { agentId: target.id });
    } catch (error) {
      target.mutationState = "rollback_failed";
      errors.push({ agentId: target.id, error: error instanceof Error ? error.message : "unknown rollback error" });
    }
  }
  receipt.retainedSecretId = receipt.createdSecretId ?? null;
  receipt.createdSecretId = receipt.createdSecretId ?? null;
  return errors;
}

async function preflight(options, dependencies = {}) {
  const boardToken = await (dependencies.loadBoardToken ?? loadBoardToken)(options.authStore, options.apiBase);
  const sourceToken = await (dependencies.loadSourceToken ?? loadSourceToken)(options.openclawConfig);
  const api = dependencies.api ?? makeApi(options.apiBase, boardToken, dependencies.fetchImpl);
  const health = await checkHealth(api, options.expectedCommit, options.allowCommitDrift);
  const secretProviderHealth = await checkLocalEncryptedProvider(api, options.companyId);
  const { companyName, targets } = await loadAndValidateTargets(
    api,
    options.companyId,
    options.canaryAgentId,
    options.fleetAgentIds,
  );
  const now = new Date().toISOString();
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    status: "preflight_pass",
    createdAt: now,
    updatedAt: now,
    apiBase: options.apiBase,
    expectedCommit: options.expectedCommit,
    observedHealth: health,
    secretProviderHealth,
    companyId: options.companyId,
    companyName,
    canaryAgentId: options.canaryAgentId,
    fleetAgentIds: options.fleetAgentIds,
    sourceConfigPath: options.openclawConfig,
    sourceCredentialPresent: true,
    plannedSecretKey: null,
    createdSecretId: null,
    retainedSecretId: null,
    targets,
    events: [{ at: now, event: "preflight_pass" }],
  };
  await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
  return { api, sourceToken, receipt };
}

async function apply(options, dependencies = {}) {
  const state = await preflight(options, dependencies);
  const { api, sourceToken, receipt } = state;
  receipt.status = "applying";
  appendEvent(receipt, "apply_started");
  await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);

  try {
    receipt.plannedSecretKey = `openclaw-gateway-${Date.now()}`;
    appendEvent(receipt, "encrypted_secret_creation_started");
    await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
    const created = await api("POST", `/companies/${receipt.companyId}/secrets`, {
      name: `OpenClaw gateway token ${new Date().toISOString()}`,
      key: receipt.plannedSecretKey,
      provider: "local_encrypted",
      value: sourceToken,
      description: "Paperclip OpenClaw gateway fleet binding; source value is never persisted in agent config.",
    });
    if (!created?.id) throw new Error("Secret creation returned no id");
    receipt.createdSecretId = created.id;
    appendEvent(receipt, "encrypted_secret_created");
    await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);

    for (const target of receipt.targets) {
      target.mutationState = "binding_pending";
      appendEvent(receipt, target.id === receipt.canaryAgentId ? "canary_binding_started" : "fleet_binding_started", { agentId: target.id });
      await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
      const patched = await api("PATCH", `/agents/${target.id}`, {
        adapterConfig: {
          authToken: {
            type: "secret_ref",
            secretId: receipt.createdSecretId,
            version: "latest",
          },
        },
      });
      const persistedConfig = patched?.adapterConfig ?? {};
      assertReceiptSafeAdapterConfig(persistedConfig);
      if (!isSecretRef(persistedConfig.authToken) || persistedConfig.authToken.secretId !== receipt.createdSecretId) {
        throw new Error(`Agent ${target.id} did not persist the expected authToken secret_ref`);
      }
      target.applied = true;
      target.mutationState = "bound";
      appendEvent(receipt, "agent_secret_ref_bound", { agentId: target.id });
      await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
      try {
        target.smoke = await runAdapterSmoke(api, receipt.companyId, persistedConfig);
      } catch (error) {
        target.smoke = error?.smoke ?? { status: "fail", testedAt: null, checks: [] };
        throw error;
      }
      appendEvent(receipt, "agent_adapter_smoke_pass", { agentId: target.id });
      await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
    }

    receipt.status = "pass";
    appendEvent(receipt, "fleet_binding_pass");
    await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
    return receipt;
  } catch (error) {
    appendEvent(receipt, "apply_failed", { error: error instanceof Error ? error.message : "unknown apply error" });
    const rollbackErrors = await restoreAppliedTargets(api, receipt);
    receipt.status = rollbackErrors.length === 0 ? "rolled_back" : "rollback_failed";
    if (rollbackErrors.length > 0) receipt.rollbackErrors = rollbackErrors;
    appendEvent(receipt, receipt.status);
    await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
    throw new Error(`${error instanceof Error ? error.message : "Apply failed"}; automatic rollback=${receipt.status}`);
  }
}

async function loadReceiptOptions(options, readReceipt = readJson) {
  const receipt = await readReceipt(options.receipt);
  if (receipt?.schemaVersion !== RECEIPT_SCHEMA_VERSION) throw new Error("Unsupported receipt schema");
  options.apiBase = normalizeApiBase(receipt.apiBase ?? options.apiBase);
  options.expectedCommit = receipt.expectedCommit ?? options.expectedCommit;
  options.companyId = receipt.companyId;
  options.canaryAgentId = receipt.canaryAgentId;
  options.fleetAgentIds = receipt.fleetAgentIds;
  return receipt;
}

async function verify(options, dependencies = {}) {
  const receipt = await loadReceiptOptions(options, dependencies.readReceipt);
  const boardToken = await (dependencies.loadBoardToken ?? loadBoardToken)(options.authStore, options.apiBase);
  const api = dependencies.api ?? makeApi(options.apiBase, boardToken, dependencies.fetchImpl);
  receipt.observedHealth = await checkHealth(api, options.expectedCommit, options.allowCommitDrift);
  if (!receipt.createdSecretId) throw new Error("Receipt has no created secret id");
  const usage = await api("GET", `/secrets/${receipt.createdSecretId}/usage`);
  const bindings = Array.isArray(usage?.bindings) ? usage.bindings : [];
  for (const target of receipt.targets) {
    const agent = await api("GET", `/agents/${target.id}`);
    if (agent?.companyId !== receipt.companyId) throw new Error(`Agent ${target.id} crossed the receipt company boundary`);
    const config = agent?.adapterConfig ?? {};
    assertReceiptSafeAdapterConfig(config);
    if (!isSecretRef(config.authToken) || config.authToken.secretId !== receipt.createdSecretId) {
      throw new Error(`Agent ${target.id} does not have the receipt secret_ref`);
    }
    const matching = bindings.filter((binding) =>
      binding?.targetType === "agent"
      && binding?.targetId === target.id
      && binding?.configPath === "authToken"
    );
    if (matching.length !== 1) throw new Error(`Agent ${target.id} has ${matching.length} authToken binding rows`);
    if (target.id === receipt.canaryAgentId) {
      target.verifySmoke = await runAdapterSmoke(api, receipt.companyId, config);
    }
  }
  receipt.status = "verified";
  appendEvent(receipt, "verification_pass");
  await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
  return receipt;
}

async function rollback(options, dependencies = {}) {
  const receipt = await loadReceiptOptions(options, dependencies.readReceipt);
  const boardToken = await (dependencies.loadBoardToken ?? loadBoardToken)(options.authStore, options.apiBase);
  const api = dependencies.api ?? makeApi(options.apiBase, boardToken, dependencies.fetchImpl);
  receipt.observedHealth = await checkHealth(api, options.expectedCommit, options.allowCommitDrift);
  const errors = await restoreAppliedTargets(api, receipt);
  receipt.status = errors.length === 0 ? "rolled_back" : "rollback_failed";
  if (errors.length > 0) receipt.rollbackErrors = errors;
  appendEvent(receipt, receipt.status);
  await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
  if (errors.length > 0) throw new Error(`Rollback failed for ${errors.length} agent(s)`);
  return receipt;
}

export async function run(argv, dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return null;
  }
  const receipt = options.mode === "preflight"
    ? (await preflight(options, dependencies)).receipt
    : options.mode === "apply"
      ? await apply(options, dependencies)
      : options.mode === "verify"
        ? await verify(options, dependencies)
        : await rollback(options, dependencies);
  console.log(JSON.stringify({
    status: receipt.status,
    receipt: options.receipt,
    companyId: receipt.companyId,
    canaryAgentId: receipt.canaryAgentId,
    agentCount: receipt.targets.length,
    observedCommit: receipt.observedHealth?.commit ?? null,
    retainedSecretOnRollback: receipt.status === "rolled_back" && Boolean(receipt.retainedSecretId),
  }));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
