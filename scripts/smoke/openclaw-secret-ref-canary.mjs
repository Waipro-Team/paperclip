#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const RECEIPT_SCHEMA_VERSION = 3;
const DEFAULT_API_BASE = "http://127.0.0.1:3100";
const DEFAULT_AUTH_STORE = "/var/lib/portal360/paperclip/cli/auth.json";
const DEFAULT_OPENCLAW_CONFIG = "/home/claw360/.openclaw/openclaw.json";
const DEFAULT_EXPECTED_COMMIT = "542cfbba0d78440f153ae1e11285170825ed4a8d";
const REDACTED_SENTINEL = "***REDACTED***";
const APPLY_KILL_SWITCH_ENV = "PAPERCLIP_OPENCLAW_SECRET_REF_CANARY_ENABLED";
const CANARY_SECRET_KEY_PREFIX = "openclaw-gateway-canary-";
const RECOVERABLE_RECEIPT_STATUSES = new Set([
  "applying",
  "secret_creation_pending",
  "secret_created",
  "apply_failed",
  "rollback_failed",
  "recovery_started",
]);
const LEGACY_AUTH_HEADERS = new Set(["authorization", "x-openclaw-token", "x-openclaw-auth"]);
const FORBIDDEN_RECEIPT_HEADERS = new Set([
  ...LEGACY_AUTH_HEADERS,
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);
const SENSITIVE_CONFIG_KEY_RE = /(api[-_]?(?:key|token)|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret(?!id)|passwd|password|credential|jwt|private[-_]?(?:key|keypem)|cookie|connection[-_]?string)/i;
const BOOLEAN_OPTIONS = new Map([
  ["--allow-commit-drift", "allowCommitDrift"],
  ["--canary-only", "canaryOnly"],
  ["--promote-fleet", "promoteFleet"],
]);
const VALUE_OPTIONS = new Map([
  ["--api-base", "apiBase"],
  ["--auth-store", "authStore"],
  ["--openclaw-config", "openclawConfig"],
  ["--expected-commit", "expectedCommit"],
  ["--company-id", "companyId"],
  ["--canary-agent-id", "canaryAgentId"],
  ["--fleet-agent-ids", "fleetAgentIds"],
  ["--environment-id", "environmentId"],
  ["--receipt", "receipt"],
]);

function usage() {
  return `Usage:
  node scripts/smoke/openclaw-secret-ref-canary.mjs preflight \\
    --company-id <uuid> --canary-agent-id <uuid> --fleet-agent-ids <uuid,...> \\
    --environment-id <uuid> --receipt <absolute-path>

  ${APPLY_KILL_SWITCH_ENV}=true node scripts/smoke/openclaw-secret-ref-canary.mjs apply [same options] --canary-only
  ${APPLY_KILL_SWITCH_ENV}=true node scripts/smoke/openclaw-secret-ref-canary.mjs apply [same options] --promote-fleet
  node scripts/smoke/openclaw-secret-ref-canary.mjs verify --receipt <absolute-path>
  node scripts/smoke/openclaw-secret-ref-canary.mjs rollback --receipt <absolute-path>

Options:
  --api-base <url>             Default: ${DEFAULT_API_BASE}
  --auth-store <path>          Default: ${DEFAULT_AUTH_STORE}
  --openclaw-config <path>     Default: ${DEFAULT_OPENCLAW_CONFIG}
  --expected-commit <sha>      Default: ${DEFAULT_EXPECTED_COMMIT}
  --allow-commit-drift         Explicit emergency override for verify/rollback
  --canary-only                Bind and smoke only the canary agent
  --promote-fleet              Bind the canary first, then the remaining exact fleet

The script never prints or stores the OpenClaw gateway token or Paperclip board token.
Apply is disabled unless ${APPLY_KILL_SWITCH_ENV}=true and exactly one of
--canary-only or --promote-fleet is supplied. Every probe must use the active,
platform-managed sandbox selected by --environment-id. Rollback restores adapter
configs and deletes only the encrypted secret whose unique run id was journaled
before creation. An interrupted apply is recovered idempotently on the next run.`;
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!mode || mode === "--help" || mode === "-h") return { help: true };
  if (!["preflight", "apply", "verify", "rollback"].includes(mode)) {
    throw new Error(`Unsupported mode: ${mode}`);
  }
  const values = {
    mode,
    allowCommitDrift: false,
    canaryOnly: false,
    promoteFleet: false,
  };
  const seenOptions = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const booleanKey = BOOLEAN_OPTIONS.get(arg);
    const valueKey = VALUE_OPTIONS.get(arg);
    if (!booleanKey && !valueKey) throw new Error(`Unsupported option: ${arg}`);
    if (seenOptions.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seenOptions.add(arg);
    if (booleanKey) {
      values[booleanKey] = true;
      continue;
    }
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values[valueKey] = next;
    index += 1;
  }
  values.apiBase = normalizeApiBase(values.apiBase ?? DEFAULT_API_BASE);
  values.authStore = values.authStore ?? DEFAULT_AUTH_STORE;
  values.openclawConfig = values.openclawConfig ?? DEFAULT_OPENCLAW_CONFIG;
  values.expectedCommit = values.expectedCommit ?? DEFAULT_EXPECTED_COMMIT;
  if (values.allowCommitDrift && mode !== "verify" && mode !== "rollback") {
    throw new Error("--allow-commit-drift is only permitted for verify or rollback");
  }
  if ((values.canaryOnly || values.promoteFleet) && mode !== "apply") {
    throw new Error("--canary-only and --promote-fleet are only permitted for apply");
  }
  if (mode === "apply" && values.canaryOnly === values.promoteFleet) {
    throw new Error("apply requires exactly one of --canary-only or --promote-fleet");
  }
  if (!values.receipt || !path.isAbsolute(values.receipt)) {
    throw new Error("--receipt must be an absolute path");
  }
  if (mode === "preflight" || mode === "apply") {
    if (!values.companyId || !values.canaryAgentId || !values.fleetAgentIds || !values.environmentId) {
      throw new Error("--company-id, --canary-agent-id, --fleet-agent-ids, and --environment-id are required");
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

function isUserSecretRef(value) {
  return isPlainRecord(value)
    && value.type === "user_secret_ref"
    && typeof value.key === "string"
    && value.key.length > 0;
}

function hasUrlUserInfo(value) {
  if (typeof value !== "string" || !value.includes("://")) return false;
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

export function assertReceiptSafeAdapterConfig(config, label = "adapterConfig") {
  if (!isPlainRecord(config)) throw new Error(`${label} must be an object`);
  const visit = (value, keyPath) => {
    if (value === REDACTED_SENTINEL) {
      throw new Error(`${keyPath} is redacted and cannot be used for rollback`);
    }
    if (hasUrlUserInfo(value)) {
      throw new Error(`${keyPath} contains URL userinfo and cannot enter a receipt`);
    }
    if (isSecretRef(value) || isUserSecretRef(value)) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${keyPath}[${index}]`));
      return;
    }
    if (!isPlainRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = `${keyPath}.${key}`;
      if (keyPath === `${label}.headers` && FORBIDDEN_RECEIPT_HEADERS.has(key.toLowerCase())) {
        throw new Error(`${nextPath} is a credential-bearing header and cannot enter a receipt`);
      }
      if (SENSITIVE_CONFIG_KEY_RE.test(key) && nested !== undefined && !isSecretRef(nested) && !isUserSecretRef(nested)) {
        throw new Error(`${nextPath} must use a secret reference`);
      }
      visit(nested, nextPath);
    }
  };
  visit(config, label);
}

function canarySecretKey(canaryRunId) {
  return `${CANARY_SECRET_KEY_PREFIX}${canaryRunId}`;
}

function canarySecretName(canaryRunId) {
  return `OpenClaw gateway canary ${canaryRunId}`;
}

function canarySecretDescription(canaryRunId) {
  return `Paperclip OpenClaw canary ${canaryRunId}; safe to delete only through its journaled rollback.`;
}

function assertCanaryJournal(receipt, expectedCompanyId = null) {
  if (receipt?.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error("Unsupported receipt schema");
  }
  if (expectedCompanyId && receipt.companyId !== expectedCompanyId) {
    throw new Error("Receipt company does not match the requested company");
  }
  if (
    typeof receipt.canaryRunId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.canaryRunId)
  ) {
    throw new Error("Receipt has no valid canary run id");
  }
  if (receipt.plannedSecretKey !== canarySecretKey(receipt.canaryRunId)) {
    throw new Error("Receipt canary secret key does not match its run id");
  }
  if (
    receipt.rollbackPolicy?.adapterConfigs !== "restore_exact_previous_config"
    || receipt.rollbackPolicy?.createdEncryptedSecret !== "delete_exact_canary_secret"
    || receipt.rollbackPolicy?.fullStateRollback !== true
  ) {
    throw new Error("Unsupported or ambiguous receipt rollback policy");
  }
  for (const target of receipt.targets ?? []) {
    assertReceiptSafeAdapterConfig(
      target.previousAdapterConfig ?? {},
      `targets[${target.id ?? "unknown"}].previousAdapterConfig`,
    );
  }
}

function publicAgentSnapshot(agent) {
  const adapterConfig = structuredClone(agent.adapterConfig ?? {});
  assertReceiptSafeAdapterConfig(adapterConfig);
  return {
    id: agent.id,
    companyId: agent.companyId,
    status: agent.status,
    adapterType: agent.adapterType,
    previousAdapterConfig: adapterConfig,
    applied: false,
    mutationState: "untouched",
    smoke: null,
  };
}

async function loadAndValidateManagedEnvironment(api, companyId, environmentId) {
  const environment = await api("GET", `/environments/${environmentId}`);
  if (environment?.id !== environmentId) {
    throw new Error("Environment identity mismatch");
  }
  if (environment.companyId !== undefined && environment.companyId !== null && environment.companyId !== companyId) {
    throw new Error("Environment failed the company boundary check");
  }
  if (environment.driver !== "sandbox" || environment.status !== "active") {
    throw new Error("Canary environment must be an active sandbox");
  }
  const metadata = isPlainRecord(environment.metadata) ? environment.metadata : {};
  if (metadata.managedByPaperclip !== true && metadata.managedKubernetesSandbox !== true) {
    throw new Error("Canary environment must be platform-managed");
  }
  return {
    id: environment.id,
    driver: environment.driver,
    status: environment.status,
    platformManaged: true,
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
  return { targets };
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

async function runAdapterSmoke(api, companyId, environmentId, config) {
  const result = await api("POST", `/companies/${companyId}/adapters/openclaw_gateway/test-environment`, {
    adapterConfig: config,
    environmentId,
  });
  const summary = smokeSummary(result);
  if (summary.status !== "pass") {
    throw Object.assign(new Error(`OpenClaw adapter smoke returned ${summary.status}`), { smoke: summary });
  }
  return summary;
}

async function restoreAppliedTargets(api, receipt) {
  const errors = [];
  assertCanaryJournal(receipt);
  for (const target of [...receipt.targets].reverse()) {
    const mayHaveMutated = target.applied
      || ["binding_pending", "bound", "rollback_failed"].includes(target.mutationState);
    if (!mayHaveMutated) continue;
    try {
      const restored = await api("PATCH", `/agents/${target.id}`, {
        replaceAdapterConfig: true,
        adapterConfig: target.previousAdapterConfig,
      });
      const restoredConfig = restored?.adapterConfig ?? {};
      assertReceiptSafeAdapterConfig(restoredConfig);
      if (!isDeepStrictEqual(restoredConfig, target.previousAdapterConfig)) {
        throw new Error(`Agent ${target.id} did not restore its exact previous adapter config`);
      }
      target.applied = false;
      target.mutationState = "rolled_back";
      appendEvent(receipt, "agent_rolled_back", { agentId: target.id });
    } catch (error) {
      target.mutationState = "rollback_failed";
      errors.push({ agentId: target.id, error: error instanceof Error ? error.message : "unknown rollback error" });
    }
  }
  return errors;
}

async function listCanarySecretMatches(api, receipt) {
  assertCanaryJournal(receipt);
  const catalog = await api("GET", `/companies/${receipt.companyId}/secrets`);
  const rows = Array.isArray(catalog) ? catalog : [];
  return rows.filter((secret) =>
    secret?.key === receipt.plannedSecretKey
    && secret?.name === canarySecretName(receipt.canaryRunId)
    && secret?.description === canarySecretDescription(receipt.canaryRunId)
    && secret?.provider === "local_encrypted"
    && secret?.status !== "deleted"
  );
}

async function recoverCreatedSecretId(api, receipt) {
  const matches = await listCanarySecretMatches(api, receipt);
  if (matches.length > 1) {
    throw new Error("Multiple active secrets match the exact canary journal");
  }
  if (receipt.createdSecretId) {
    if (matches.length === 0) return null;
    if (matches[0]?.id !== receipt.createdSecretId) {
      throw new Error("Canary secret id does not match the exact journal key and name");
    }
    return receipt.createdSecretId;
  }
  if (matches.length === 0) return null;
  receipt.createdSecretId = matches[0].id;
  receipt.secretLifecycle = "recovered_from_journal";
  appendEvent(receipt, "canary_secret_recovered", { secretId: receipt.createdSecretId });
  return receipt.createdSecretId;
}

async function deleteCanarySecret(api, receipt, writeReceiptImpl, receiptPath) {
  const secretId = await recoverCreatedSecretId(api, receipt);
  if (!secretId) {
    receipt.deletedSecretId = receipt.deletedSecretId ?? receipt.createdSecretId ?? null;
    receipt.createdSecretId = null;
    receipt.secretLifecycle = "absent";
    appendEvent(receipt, "canary_secret_absent");
    await writeReceiptImpl(receiptPath, receipt);
    return;
  }
  receipt.secretLifecycle = "deletion_pending";
  appendEvent(receipt, "canary_secret_deletion_started", { secretId });
  await writeReceiptImpl(receiptPath, receipt);
  await api("DELETE", `/secrets/${secretId}`);
  const remaining = await listCanarySecretMatches(api, receipt);
  if (remaining.length !== 0) {
    throw new Error("Canary secret still exists after deletion");
  }
  receipt.secretLifecycle = "deleted";
  receipt.deletedSecretId = secretId;
  receipt.createdSecretId = null;
  appendEvent(receipt, "canary_secret_deleted", { secretId });
  await writeReceiptImpl(receiptPath, receipt);
}

async function restoreFullCanaryState(api, receipt, writeReceiptImpl, receiptPath) {
  assertCanaryJournal(receipt);
  const rollbackErrors = await restoreAppliedTargets(api, receipt);
  if (rollbackErrors.length > 0) {
    receipt.status = "rollback_failed";
    receipt.rollbackErrors = rollbackErrors;
    appendEvent(receipt, "rollback_failed");
    await writeReceiptImpl(receiptPath, receipt);
    return rollbackErrors;
  }
  try {
    await deleteCanarySecret(api, receipt, writeReceiptImpl, receiptPath);
  } catch (error) {
    receipt.status = "rollback_failed";
    receipt.rollbackErrors = [{
      secretId: receipt.createdSecretId ?? null,
      error: error instanceof Error ? error.message : "unknown secret deletion error",
    }];
    appendEvent(receipt, "rollback_failed");
    await writeReceiptImpl(receiptPath, receipt);
    return receipt.rollbackErrors;
  }
  receipt.status = "full_state_rolled_back";
  delete receipt.rollbackErrors;
  appendEvent(receipt, "full_state_rolled_back");
  await writeReceiptImpl(receiptPath, receipt);
  return [];
}

async function preflight(options, dependencies = {}) {
  const boardToken = await (dependencies.loadBoardToken ?? loadBoardToken)(options.authStore, options.apiBase);
  const api = dependencies.api ?? makeApi(options.apiBase, boardToken, dependencies.fetchImpl);
  const health = await checkHealth(api, options.expectedCommit, options.allowCommitDrift);
  const secretProviderHealth = await checkLocalEncryptedProvider(api, options.companyId);
  const environment = await loadAndValidateManagedEnvironment(api, options.companyId, options.environmentId);
  const { targets } = await loadAndValidateTargets(
    api,
    options.companyId,
    options.canaryAgentId,
    options.fleetAgentIds,
  );
  const sourceToken = await (dependencies.loadSourceToken ?? loadSourceToken)(options.openclawConfig);
  const now = new Date().toISOString();
  const canaryRunId = dependencies.randomUUID?.() ?? randomUUID();
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
    environment,
    environmentId: options.environmentId,
    canaryAgentId: options.canaryAgentId,
    fleetAgentIds: options.fleetAgentIds,
    sourceConfigPath: options.openclawConfig,
    sourceCredentialPresent: true,
    canaryRunId,
    plannedSecretKey: canarySecretKey(canaryRunId),
    createdSecretId: null,
    deletedSecretId: null,
    secretLifecycle: "planned",
    rollbackPolicy: {
      adapterConfigs: "restore_exact_previous_config",
      createdEncryptedSecret: "delete_exact_canary_secret",
      fullStateRollback: true,
    },
    targets,
    events: [{ at: now, event: "preflight_pass" }],
  };
  assertCanaryJournal(receipt, options.companyId);
  await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
  return { api, sourceToken, receipt };
}

async function readOptionalReceipt(receiptPath, readReceiptImpl = readJson) {
  try {
    return await readReceiptImpl(receiptPath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function recoverInterruptedApply(options, dependencies = {}) {
  const prior = await readOptionalReceipt(options.receipt, dependencies.readReceipt ?? readJson);
  if (prior === undefined) return null;
  assertCanaryJournal(prior, options.companyId);
  if (prior.status === "preflight_pass" && !prior.createdSecretId) return null;
  if (prior.status === "full_state_rolled_back") return null;
  if (["canary_pass", "fleet_pass", "verified"].includes(prior.status)) {
    throw new Error("Receipt describes a completed binding; rollback it before starting another apply");
  }
  if (!RECOVERABLE_RECEIPT_STATUSES.has(prior.status)) {
    throw new Error(`Receipt status ${prior.status ?? "missing"} is not recoverable`);
  }
  const boardToken = await (dependencies.loadBoardToken ?? loadBoardToken)(options.authStore, options.apiBase);
  const api = dependencies.api ?? makeApi(options.apiBase, boardToken, dependencies.fetchImpl);
  prior.observedHealth = await checkHealth(api, prior.expectedCommit, false);
  prior.status = "recovery_started";
  appendEvent(prior, "interrupted_apply_recovery_started");
  const writeReceiptImpl = dependencies.writeReceipt ?? writeReceipt;
  await writeReceiptImpl(options.receipt, prior);
  const errors = await restoreFullCanaryState(api, prior, writeReceiptImpl, options.receipt);
  if (errors.length > 0) {
    throw new Error(`Interrupted apply recovery failed for ${errors.length} item(s)`);
  }
  return {
    canaryRunId: prior.canaryRunId,
    deletedSecretId: prior.deletedSecretId ?? null,
    status: prior.status,
  };
}

async function apply(options, dependencies = {}) {
  if (options.mode !== "apply" || options.canaryOnly === options.promoteFleet) {
    throw new Error("apply requires exactly one explicit mutation scope: --canary-only or --promote-fleet");
  }
  const mutationKillSwitch = dependencies.applyEnabled
    ?? process.env[APPLY_KILL_SWITCH_ENV] === "true";
  if (!mutationKillSwitch) {
    throw new Error(`apply is disabled; set ${APPLY_KILL_SWITCH_ENV}=true to open the mutation gate`);
  }
  const recoveredPriorRun = await recoverInterruptedApply(options, dependencies);
  const state = await preflight(options, dependencies);
  const { api, sourceToken, receipt } = state;
  receipt.recoveredPriorRun = recoveredPriorRun;
  receipt.executionMode = options.canaryOnly ? "canary_only" : "fleet_promotion";
  receipt.status = "applying";
  appendEvent(receipt, "apply_started");
  await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);

  try {
    receipt.status = "secret_creation_pending";
    receipt.secretLifecycle = "creation_pending";
    appendEvent(receipt, "encrypted_secret_creation_started");
    await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
    const created = await api("POST", `/companies/${receipt.companyId}/secrets`, {
      name: canarySecretName(receipt.canaryRunId),
      key: receipt.plannedSecretKey,
      provider: "local_encrypted",
      value: sourceToken,
      description: canarySecretDescription(receipt.canaryRunId),
    });
    if (!created?.id) throw new Error("Secret creation returned no id");
    receipt.createdSecretId = created.id;
    receipt.secretLifecycle = "created";
    receipt.status = "secret_created";
    appendEvent(receipt, "encrypted_secret_created");
    await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);

    const targetsToApply = options.canaryOnly
      ? receipt.targets.filter((target) => target.id === receipt.canaryAgentId)
      : receipt.targets;
    for (const target of targetsToApply) {
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
        target.smoke = await runAdapterSmoke(
          api,
          receipt.companyId,
          receipt.environmentId,
          persistedConfig,
        );
      } catch (error) {
        target.smoke = error?.smoke ?? { status: "fail", testedAt: null, checks: [] };
        throw error;
      }
      appendEvent(receipt, "agent_adapter_smoke_pass", { agentId: target.id });
      await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
    }

    receipt.status = options.canaryOnly ? "canary_pass" : "fleet_pass";
    appendEvent(receipt, options.canaryOnly ? "canary_binding_pass" : "fleet_binding_pass");
    await (dependencies.writeReceipt ?? writeReceipt)(options.receipt, receipt);
    return receipt;
  } catch (error) {
    appendEvent(receipt, "apply_failed", { error: error instanceof Error ? error.message : "unknown apply error" });
    receipt.status = "apply_failed";
    await restoreFullCanaryState(
      api,
      receipt,
      dependencies.writeReceipt ?? writeReceipt,
      options.receipt,
    );
    throw new Error(`${error instanceof Error ? error.message : "Apply failed"}; automatic rollback=${receipt.status}`);
  }
}

async function loadReceiptOptions(options, readReceipt = readJson) {
  const receipt = await readReceipt(options.receipt);
  assertCanaryJournal(receipt);
  options.apiBase = normalizeApiBase(receipt.apiBase ?? options.apiBase);
  options.expectedCommit = receipt.expectedCommit ?? options.expectedCommit;
  options.companyId = receipt.companyId;
  options.canaryAgentId = receipt.canaryAgentId;
  options.fleetAgentIds = receipt.fleetAgentIds;
  options.environmentId = receipt.environmentId;
  if (!options.environmentId) throw new Error("Receipt has no managed sandbox environment id");
  return receipt;
}

async function verify(options, dependencies = {}) {
  const receipt = await loadReceiptOptions(options, dependencies.readReceipt);
  const boardToken = await (dependencies.loadBoardToken ?? loadBoardToken)(options.authStore, options.apiBase);
  const api = dependencies.api ?? makeApi(options.apiBase, boardToken, dependencies.fetchImpl);
  receipt.observedHealth = await checkHealth(api, options.expectedCommit, options.allowCommitDrift);
  receipt.environment = await loadAndValidateManagedEnvironment(
    api,
    receipt.companyId,
    receipt.environmentId,
  );
  if (!receipt.createdSecretId) throw new Error("Receipt has no created secret id");
  const journaledSecretId = receipt.createdSecretId;
  const activeSecretId = await recoverCreatedSecretId(api, receipt);
  if (activeSecretId !== journaledSecretId) {
    throw new Error("Receipt canary secret is not active with its exact journal metadata");
  }
  const usage = await api("GET", `/secrets/${receipt.createdSecretId}/usage`);
  const bindings = Array.isArray(usage?.bindings) ? usage.bindings : [];
  const boundTargets = receipt.targets.filter((target) => target.applied || target.mutationState === "bound");
  if (boundTargets.length === 0) throw new Error("Receipt has no bound targets to verify");
  for (const target of boundTargets) {
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
      target.verifySmoke = await runAdapterSmoke(
        api,
        receipt.companyId,
        receipt.environmentId,
        config,
      );
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
  const errors = await restoreFullCanaryState(
    api,
    receipt,
    dependencies.writeReceipt ?? writeReceipt,
    options.receipt,
  );
  if (errors.length > 0) throw new Error(`Rollback failed for ${errors.length} item(s)`);
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
    deletedCanarySecretOnRollback:
      receipt.status === "full_state_rolled_back"
      && Boolean(receipt.deletedSecretId),
    fullStateRollback: receipt.rollbackPolicy?.fullStateRollback ?? null,
  }));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
