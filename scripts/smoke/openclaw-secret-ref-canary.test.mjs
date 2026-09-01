import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReceiptSafeAdapterConfig,
  run,
} from "./openclaw-secret-ref-canary.mjs";

const companyId = "11111111-1111-4111-8111-111111111111";
const canaryAgentId = "22222222-2222-4222-8222-222222222222";
const fleetAgentId = "33333333-3333-4333-8333-333333333333";
const environmentId = "66666666-6666-4666-8666-666666666666";
const canaryRunId = "77777777-7777-4777-8777-777777777777";
const nextCanaryRunId = "88888888-8888-4888-8888-888888888888";
const orphanSecretId = "99999999-9999-4999-8999-999999999999";
const canarySecretKey = `openclaw-gateway-canary-${canaryRunId}`;
const canarySecretName = `OpenClaw gateway canary ${canaryRunId}`;
const sourceToken = "source-gateway-token-0123456789";
const boardToken = "board-token-0123456789";
const secretId = "44444444-4444-4444-8444-444444444444";
const expectedCommit = "542cfbba0d78440f153ae1e11285170825ed4a8d";

function safeAgent(id, name, company = companyId) {
  return {
    id,
    name,
    companyId: company,
    status: id === canaryAgentId ? "error" : "idle",
    adapterType: "openclaw_gateway",
    adapterConfig: {
      url: "ws://127.0.0.1:18789",
      devicePrivateKeyPem: {
        type: "secret_ref",
        secretId: "55555555-5555-4555-8555-555555555555",
        version: "latest",
      },
    },
  };
}

function args(mode) {
  const values = [
    mode,
    "--company-id", companyId,
    "--canary-agent-id", canaryAgentId,
    "--fleet-agent-ids", `${fleetAgentId},${canaryAgentId}`,
    "--environment-id", environmentId,
    "--receipt", "/tmp/openclaw-canary-receipt.json",
  ];
  if (mode === "apply") values.push("--promote-fleet");
  return values;
}

function healthySecretProvider() {
  return {
    providers: [{ provider: "local_encrypted", status: "ok" }],
  };
}

function managedSandbox() {
  return {
    id: environmentId,
    companyId,
    driver: "sandbox",
    status: "active",
    metadata: { managedByPaperclip: true },
  };
}

function fullRollbackPolicy() {
  return {
    adapterConfigs: "restore_exact_previous_config",
    createdEncryptedSecret: "delete_exact_canary_secret",
    fullStateRollback: true,
  };
}

function activeCanarySecret(runId = canaryRunId, id = secretId) {
  return {
    id,
    key: `openclaw-gateway-canary-${runId}`,
    name: `OpenClaw gateway canary ${runId}`,
    description: `Paperclip OpenClaw canary ${runId}; safe to delete only through its journaled rollback.`,
    provider: "local_encrypted",
    status: "active",
  };
}

function journalFields(overrides = {}) {
  return {
    schemaVersion: 3,
    canaryRunId,
    plannedSecretKey: canarySecretKey,
    secretLifecycle: "created",
    rollbackPolicy: fullRollbackPolicy(),
    ...overrides,
  };
}

async function withoutConsoleLog(fn) {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

test("receipt safety accepts secret refs and rejects raw or redacted credentials", () => {
  assert.doesNotThrow(() => assertReceiptSafeAdapterConfig({
    authToken: { type: "secret_ref", secretId, version: "latest" },
    headers: { "x-trace-id": "safe" },
  }));
  assert.throws(() => assertReceiptSafeAdapterConfig({ authToken: sourceToken }), /must use a secret reference/);
  assert.throws(
    () => assertReceiptSafeAdapterConfig({ headers: { Authorization: `Bearer ${sourceToken}` } }),
    /credential-bearing header/,
  );
  assert.throws(
    () => assertReceiptSafeAdapterConfig({ headers: { Cookie: "session=dummy-secret" } }),
    /credential-bearing header/,
  );
  assert.throws(
    () => assertReceiptSafeAdapterConfig({ url: "ws://demo-user:demo-pass@127.0.0.1:18789" }),
    /URL userinfo/,
  );
  assert.throws(
    () => assertReceiptSafeAdapterConfig({ proxy: { password: "dummy-secret" } }),
    /must use a secret reference/,
  );
  assert.throws(() => assertReceiptSafeAdapterConfig({ url: "***REDACTED***" }), /redacted/);
  assert.throws(
    () => assertReceiptSafeAdapterConfig({ env: { API_TOKEN: { type: "plain", value: sourceToken } } }),
    /must use a secret reference/,
  );
});

test("apply binds and probes the canary before the remaining fleet without leaking tokens to receipts", async () => {
  const agents = new Map([
    [canaryAgentId, safeAgent(canaryAgentId, "QA & Audit")],
    [fleetAgentId, safeAgent(fleetAgentId, "Chiara")],
  ]);
  const calls = [];
  const receipts = [];
  const api = async (method, apiPath, body) => {
    calls.push({ method, apiPath, body });
    if (apiPath === "/health") return { status: "ok", commit: expectedCommit };
    if (apiPath.endsWith("/secret-providers/health")) return healthySecretProvider();
    if (apiPath === `/environments/${environmentId}`) return managedSandbox();
    if (apiPath === `/companies/${companyId}`) return { id: companyId, name: "Core360" };
    if (method === "GET" && apiPath.startsWith("/agents/")) return structuredClone(agents.get(apiPath.split("/").at(-1)));
    if (method === "POST" && apiPath.endsWith("/secrets")) {
      assert.equal(body.key, canarySecretKey);
      assert.equal(body.name, `OpenClaw gateway canary ${canaryRunId}`);
      assert.match(body.description, new RegExp(canaryRunId));
      return { id: secretId };
    }
    if (method === "PATCH" && apiPath.startsWith("/agents/")) {
      const id = apiPath.split("/").at(-1);
      const current = agents.get(id);
      current.adapterConfig = body.replaceAdapterConfig
        ? structuredClone(body.adapterConfig)
        : { ...current.adapterConfig, ...structuredClone(body.adapterConfig) };
      return structuredClone(current);
    }
    if (apiPath.endsWith("/test-environment")) {
      return { status: "pass", testedAt: "2026-09-01T00:00:00.000Z", checks: [{ code: "gateway_auth", level: "info" }] };
    }
    throw new Error(`unexpected API call ${method} ${apiPath}`);
  };

  const receipt = await withoutConsoleLog(() => run(args("apply"), {
    applyEnabled: true,
    api,
    readReceipt: async () => undefined,
    randomUUID: () => canaryRunId,
    loadBoardToken: async () => boardToken,
    loadSourceToken: async () => sourceToken,
    writeReceipt: async (_path, value) => receipts.push(structuredClone(value)),
  }));

  assert.equal(receipt.status, "fleet_pass");
  assert.deepEqual(receipt.secretProviderHealth, { provider: "local_encrypted", status: "ok" });
  assert.deepEqual(receipt.targets.map((target) => target.id), [canaryAgentId, fleetAgentId]);
  assert.deepEqual(receipt.targets.map((target) => target.smoke.status), ["pass", "pass"]);
  const patchCalls = calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(patchCalls.map((call) => call.apiPath), [`/agents/${canaryAgentId}`, `/agents/${fleetAgentId}`]);
  assert.equal(patchCalls[0].body.adapterConfig.authToken.type, "secret_ref");
  assert.equal(patchCalls[0].body.adapterConfig.authToken.secretId, secretId);
  const smokeCalls = calls.filter((call) => call.apiPath.endsWith("/test-environment"));
  assert.equal(smokeCalls.length, 2);
  assert.equal(smokeCalls.every((call) => call.body.environmentId === environmentId), true);
  const pendingReceiptIndex = receipts.findIndex((value) => value.status === "secret_creation_pending");
  const createdReceiptIndex = receipts.findIndex((value) => value.status === "secret_created");
  assert.notEqual(pendingReceiptIndex, -1);
  assert.equal(createdReceiptIndex > pendingReceiptIndex, true);
  assert.equal(receipts[pendingReceiptIndex].plannedSecretKey, canarySecretKey);
  assert.equal(receipts[pendingReceiptIndex].createdSecretId, null);
  const persistedReceipts = JSON.stringify(receipts);
  assert.equal(persistedReceipts.includes(sourceToken), false);
  assert.equal(persistedReceipts.includes(boardToken), false);
});

test("a fleet smoke failure restores every applied config and deletes only its encrypted secret", async () => {
  const agents = new Map([
    [canaryAgentId, safeAgent(canaryAgentId, "QA & Audit")],
    [fleetAgentId, safeAgent(fleetAgentId, "Chiara")],
  ]);
  const patchOrder = [];
  let smokeCount = 0;
  let secretExists = false;
  const deletedSecrets = [];
  const preexistingSecret = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    key: "preexisting-openclaw-token",
    name: "Preexisting OpenClaw token",
    status: "active",
  };
  let terminalReceipt;
  const api = async (method, apiPath, body) => {
    if (apiPath === "/health") return { status: "ok", commit: expectedCommit };
    if (apiPath.endsWith("/secret-providers/health")) return healthySecretProvider();
    if (apiPath === `/environments/${environmentId}`) return managedSandbox();
    if (apiPath === `/companies/${companyId}`) return { id: companyId, name: "Core360" };
    if (method === "GET" && apiPath.startsWith("/agents/")) return structuredClone(agents.get(apiPath.split("/").at(-1)));
    if (method === "POST" && apiPath.endsWith("/secrets")) {
      secretExists = true;
      return { id: secretId };
    }
    if (method === "GET" && apiPath === `/companies/${companyId}/secrets`) {
      return secretExists ? [activeCanarySecret(), preexistingSecret] : [preexistingSecret];
    }
    if (method === "DELETE" && apiPath === `/secrets/${secretId}`) {
      deletedSecrets.push(secretId);
      secretExists = false;
      return { ok: true };
    }
    if (method === "PATCH" && apiPath.startsWith("/agents/")) {
      const id = apiPath.split("/").at(-1);
      patchOrder.push(`${id}:${body.replaceAdapterConfig ? "restore" : "bind"}`);
      const current = agents.get(id);
      current.adapterConfig = body.replaceAdapterConfig
        ? structuredClone(body.adapterConfig)
        : { ...current.adapterConfig, ...structuredClone(body.adapterConfig) };
      return structuredClone(current);
    }
    if (apiPath.endsWith("/test-environment")) {
      smokeCount += 1;
      return smokeCount === 1
        ? { status: "pass", checks: [] }
        : { status: "fail", checks: [{ code: "gateway_auth", level: "error" }] };
    }
    throw new Error(`unexpected API call ${method} ${apiPath}`);
  };

  await assert.rejects(
    withoutConsoleLog(() => run(args("apply"), {
      applyEnabled: true,
      api,
      readReceipt: async () => undefined,
      randomUUID: () => canaryRunId,
      loadBoardToken: async () => boardToken,
      loadSourceToken: async () => sourceToken,
      writeReceipt: async (_path, value) => { terminalReceipt = structuredClone(value); },
    })),
    /automatic rollback=full_state_rolled_back/,
  );

  assert.deepEqual(patchOrder, [
    `${canaryAgentId}:bind`,
    `${fleetAgentId}:bind`,
    `${fleetAgentId}:restore`,
    `${canaryAgentId}:restore`,
  ]);
  assert.equal(terminalReceipt.status, "full_state_rolled_back");
  assert.equal(terminalReceipt.createdSecretId, null);
  assert.equal(terminalReceipt.deletedSecretId, secretId);
  assert.equal(terminalReceipt.rollbackPolicy.fullStateRollback, true);
  assert.equal(secretExists, false);
  assert.deepEqual(deletedSecrets, [secretId]);
  assert.equal(terminalReceipt.targets.every((target) => target.applied === false), true);
  assert.equal(terminalReceipt.targets.every((target) => target.mutationState === "rolled_back"), true);
  assert.equal(JSON.stringify(terminalReceipt).includes(sourceToken), false);
});

test("a crash-window binding_pending receipt is rolled back idempotently", async () => {
  const prior = safeAgent(canaryAgentId, "QA & Audit").adapterConfig;
  let restoredBody;
  let terminalReceipt;
  let secretExists = true;
  const receipt = {
    ...journalFields(),
    status: "applying",
    apiBase: "http://127.0.0.1:3100",
    expectedCommit,
    companyId,
    environmentId,
    canaryAgentId,
    fleetAgentIds: [canaryAgentId],
    createdSecretId: secretId,
    targets: [{
      id: canaryAgentId,
      previousAdapterConfig: structuredClone(prior),
      applied: false,
      mutationState: "binding_pending",
    }],
    events: [],
  };
  const api = async (method, apiPath, body) => {
    if (apiPath === "/health") return { status: "ok", commit: receipt.expectedCommit };
    if (method === "PATCH" && apiPath === `/agents/${canaryAgentId}`) {
      restoredBody = body;
      return { adapterConfig: structuredClone(body.adapterConfig) };
    }
    if (method === "GET" && apiPath === `/companies/${companyId}/secrets`) {
      return secretExists ? [activeCanarySecret()] : [];
    }
    if (method === "DELETE" && apiPath === `/secrets/${secretId}`) {
      secretExists = false;
      return { ok: true };
    }
    throw new Error(`unexpected API call ${method} ${apiPath}`);
  };

  const result = await withoutConsoleLog(() => run([
    "rollback",
    "--receipt", "/tmp/openclaw-canary-receipt.json",
  ], {
    api,
    readReceipt: async () => structuredClone(receipt),
    loadBoardToken: async () => boardToken,
    writeReceipt: async (_path, value) => { terminalReceipt = structuredClone(value); },
  }));

  assert.equal(result.status, "full_state_rolled_back");
  assert.equal(restoredBody.replaceAdapterConfig, true);
  assert.deepEqual(restoredBody.adapterConfig, prior);
  assert.equal(terminalReceipt.targets[0].mutationState, "rolled_back");
  assert.equal(terminalReceipt.deletedSecretId, secretId);
  assert.equal(secretExists, false);
  assert.equal(JSON.stringify(terminalReceipt).includes(sourceToken), false);
});

test("preflight fails closed on a commit mismatch before any mutation", async () => {
  let mutations = 0;
  const api = async (method, apiPath) => {
    if (method !== "GET") mutations += 1;
    if (apiPath === "/health") return { status: "ok", commit: "unexpected-commit" };
    throw new Error(`unexpected API call ${method} ${apiPath}`);
  };

  await assert.rejects(
    withoutConsoleLog(() => run(args("preflight"), {
      api,
      loadBoardToken: async () => boardToken,
      loadSourceToken: async () => sourceToken,
      writeReceipt: async () => {},
    })),
    /commit mismatch/,
  );
  assert.equal(mutations, 0);
});

test("apply cannot bypass the pinned deployment commit", async () => {
  await assert.rejects(
    withoutConsoleLog(() => run([...args("apply"), "--allow-commit-drift"], {})),
    /only permitted for verify or rollback/,
  );
});

test("verification fails closed when an exact authToken binding row is missing", async () => {
  let smokeCalls = 0;
  const receipt = {
    ...journalFields(),
    status: "pass",
    apiBase: "http://127.0.0.1:3100",
    expectedCommit,
    companyId,
    environmentId,
    canaryAgentId,
    fleetAgentIds: [canaryAgentId],
    createdSecretId: secretId,
    targets: [{
      id: canaryAgentId,
      previousAdapterConfig: safeAgent(canaryAgentId, "QA & Audit").adapterConfig,
      applied: true,
      mutationState: "bound",
    }],
    events: [],
  };
  const api = async (method, apiPath) => {
    if (apiPath === "/health") return { status: "ok", commit: receipt.expectedCommit };
    if (apiPath === `/environments/${environmentId}`) return managedSandbox();
    if (method === "GET" && apiPath === `/companies/${companyId}/secrets`) return [activeCanarySecret()];
    if (apiPath === `/secrets/${secretId}/usage`) return { secretId, bindings: [] };
    if (apiPath === `/agents/${canaryAgentId}`) {
      return {
        ...safeAgent(canaryAgentId, "QA & Audit"),
        adapterConfig: {
          ...safeAgent(canaryAgentId, "QA & Audit").adapterConfig,
          authToken: { type: "secret_ref", secretId, version: "latest" },
        },
      };
    }
    if (apiPath.endsWith("/test-environment")) {
      smokeCalls += 1;
      return { status: "pass", checks: [] };
    }
    throw new Error(`unexpected API call ${method} ${apiPath}`);
  };

  await assert.rejects(
    withoutConsoleLog(() => run([
      "verify",
      "--receipt", "/tmp/openclaw-canary-receipt.json",
    ], {
      api,
      readReceipt: async () => structuredClone(receipt),
      loadBoardToken: async () => boardToken,
      writeReceipt: async () => {},
    })),
    /0 authToken binding rows/,
  );
  assert.equal(smokeCalls, 0);
});

test("preflight fails closed before mutation when an agent belongs to another company", async () => {
  let mutations = 0;
  const api = async (method, apiPath) => {
    if (method !== "GET") mutations += 1;
    if (apiPath === "/health") return { status: "ok", commit: expectedCommit };
    if (apiPath.endsWith("/secret-providers/health")) return healthySecretProvider();
    if (apiPath === `/environments/${environmentId}`) return managedSandbox();
    if (apiPath === `/companies/${companyId}`) return { id: companyId, name: "Core360" };
    if (apiPath === `/agents/${canaryAgentId}`) return safeAgent(canaryAgentId, "QA & Audit", "foreign-company");
    throw new Error(`unexpected API call ${method} ${apiPath}`);
  };

  await assert.rejects(
    withoutConsoleLog(() => run(args("preflight"), {
      api,
      loadBoardToken: async () => boardToken,
      loadSourceToken: async () => sourceToken,
      writeReceipt: async () => {},
    })),
    /company boundary check/,
  );
  assert.equal(mutations, 0);
});

test("apply kill switch fails before API, token, or receipt access", async () => {
  let calls = 0;
  await assert.rejects(
    withoutConsoleLog(() => run(args("apply"), {
      applyEnabled: false,
      api: async () => { calls += 1; },
      loadBoardToken: async () => { calls += 1; return boardToken; },
      loadSourceToken: async () => { calls += 1; return sourceToken; },
      writeReceipt: async () => { calls += 1; },
    })),
    /apply is disabled/,
  );
  assert.equal(calls, 0);
});

test("CLI rejects arbitrary options, duplicate options, and mutation-scope overrides before access", async () => {
  let calls = 0;
  const dependencies = {
    applyEnabled: true,
    api: async () => { calls += 1; },
    loadBoardToken: async () => { calls += 1; return boardToken; },
    loadSourceToken: async () => { calls += 1; return sourceToken; },
    writeReceipt: async () => { calls += 1; },
  };

  await assert.rejects(
    withoutConsoleLog(() => run([...args("preflight"), "--mode", "apply"], dependencies)),
    /Unsupported option: --mode/,
  );
  await assert.rejects(
    withoutConsoleLog(() => run([...args("preflight"), "--receipt", "/tmp/second.json"], dependencies)),
    /Duplicate option: --receipt/,
  );
  await assert.rejects(
    withoutConsoleLog(() => run([...args("apply"), "--promote-fleet"], dependencies)),
    /Duplicate option: --promote-fleet/,
  );

  const withoutScope = args("apply").filter((value) => value !== "--promote-fleet");
  await assert.rejects(
    withoutConsoleLog(() => run(withoutScope, dependencies)),
    /apply requires exactly one of --canary-only or --promote-fleet/,
  );
  assert.equal(calls, 0);
});

test("canary-only binds, smokes, and verifies only the canary in the managed tenant sandbox", async () => {
  const agents = new Map([
    [canaryAgentId, safeAgent(canaryAgentId, "QA & Audit")],
    [fleetAgentId, safeAgent(fleetAgentId, "Chiara")],
  ]);
  const calls = [];
  const api = async (method, apiPath, body) => {
    calls.push({ method, apiPath, body });
    if (apiPath === "/health") return { status: "ok", commit: expectedCommit };
    if (apiPath.endsWith("/secret-providers/health")) return healthySecretProvider();
    if (apiPath === `/environments/${environmentId}`) return managedSandbox();
    if (apiPath === `/companies/${companyId}`) return { id: companyId, name: "Core360" };
    if (method === "GET" && apiPath.startsWith("/agents/")) {
      return structuredClone(agents.get(apiPath.split("/").at(-1)));
    }
    if (method === "POST" && apiPath.endsWith("/secrets")) return { id: secretId };
    if (method === "PATCH" && apiPath.startsWith("/agents/")) {
      const id = apiPath.split("/").at(-1);
      const current = agents.get(id);
      current.adapterConfig = body.replaceAdapterConfig
        ? structuredClone(body.adapterConfig)
        : { ...current.adapterConfig, ...structuredClone(body.adapterConfig) };
      return structuredClone(current);
    }
    if (method === "GET" && apiPath === `/companies/${companyId}/secrets`) return [activeCanarySecret()];
    if (apiPath === `/secrets/${secretId}/usage`) {
      return {
        secretId,
        bindings: [{ targetType: "agent", targetId: canaryAgentId, configPath: "authToken" }],
      };
    }
    if (apiPath.endsWith("/test-environment")) {
      return { status: "pass", checks: [{ code: "openclaw_gateway_probe_ok", level: "info" }] };
    }
    throw new Error(`unexpected API call ${method} ${apiPath}`);
  };
  const applyArgs = args("apply");
  applyArgs[applyArgs.indexOf("--promote-fleet")] = "--canary-only";
  let receipt = await withoutConsoleLog(() => run(applyArgs, {
    applyEnabled: true,
    api,
    readReceipt: async () => undefined,
    randomUUID: () => canaryRunId,
    loadBoardToken: async () => boardToken,
    loadSourceToken: async () => sourceToken,
    writeReceipt: async () => {},
  }));

  assert.equal(receipt.status, "canary_pass");
  assert.equal(receipt.executionMode, "canary_only");
  assert.equal(receipt.targets[0].mutationState, "bound");
  assert.equal(receipt.targets[1].mutationState, "untouched");
  assert.equal(JSON.stringify(receipt).includes("QA & Audit"), false);
  assert.equal(JSON.stringify(receipt).includes("Chiara"), false);
  assert.equal(JSON.stringify(receipt).includes("Core360"), false);
  assert.equal(
    calls.filter((call) => call.method === "PATCH" && !call.body.replaceAdapterConfig).length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.apiPath.endsWith("/test-environment"))
      .every((call) => call.body.environmentId === environmentId),
    true,
  );

  receipt = await withoutConsoleLog(() => run([
    "verify",
    "--receipt", "/tmp/openclaw-canary-receipt.json",
  ], {
    api,
    readReceipt: async () => structuredClone(receipt),
    loadBoardToken: async () => boardToken,
    writeReceipt: async () => {},
  }));
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.targets[1].mutationState, "untouched");
});

test("preflight rejects a non-managed sandbox before loading the source credential", async () => {
  let sourceReads = 0;
  const api = async (method, apiPath) => {
    if (apiPath === "/health") return { status: "ok", commit: expectedCommit };
    if (apiPath.endsWith("/secret-providers/health")) return healthySecretProvider();
    if (apiPath === `/environments/${environmentId}`) {
      return { ...managedSandbox(), metadata: {}, driver: "local" };
    }
    throw new Error(`unexpected API call ${method} ${apiPath}`);
  };
  await assert.rejects(
    withoutConsoleLog(() => run(args("preflight"), {
      api,
      loadBoardToken: async () => boardToken,
      loadSourceToken: async () => { sourceReads += 1; return sourceToken; },
      writeReceipt: async () => {},
    })),
    /active sandbox/,
  );
  assert.equal(sourceReads, 0);
});

test("preflight rejects a sandbox owned by another company before loading credentials or mutating", async () => {
  const foreignCompanyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let sourceReads = 0;
  let mutations = 0;
  const api = async (method, apiPath) => {
    if (method !== "GET") mutations += 1;
    if (apiPath === "/health") return { status: "ok", commit: expectedCommit };
    if (apiPath.endsWith("/secret-providers/health")) return healthySecretProvider();
    if (apiPath === `/environments/${environmentId}`) {
      return { ...managedSandbox(), companyId: foreignCompanyId };
    }
    throw new Error(`unexpected API call ${method} ${apiPath}`);
  };

  await assert.rejects(
    withoutConsoleLog(() => run(args("preflight"), {
      api,
      loadBoardToken: async () => boardToken,
      loadSourceToken: async () => { sourceReads += 1; return sourceToken; },
      writeReceipt: async () => {},
    })),
    /company boundary check/,
  );
  assert.equal(sourceReads, 0);
  assert.equal(mutations, 0);
});

test("a foreign-company sandbox rejection restores the canary with full-state rollback", async () => {
  const agent = safeAgent(canaryAgentId, "QA & Audit");
  const mutations = [];
  let secretExists = false;
  let terminalReceipt;
  const api = async (method, apiPath, body) => {
    if (apiPath === "/health") return { status: "ok", commit: expectedCommit };
    if (apiPath.endsWith("/secret-providers/health")) return healthySecretProvider();
    if (apiPath === `/environments/${environmentId}`) return { ...managedSandbox(), companyId: null };
    if (apiPath === `/companies/${companyId}`) return { id: companyId };
    if (method === "GET" && apiPath === `/agents/${canaryAgentId}`) return structuredClone(agent);
    if (method === "GET" && apiPath === `/agents/${fleetAgentId}`) return safeAgent(fleetAgentId, "Chiara");
    if (method === "POST" && apiPath.endsWith("/secrets")) {
      secretExists = true;
      return { id: secretId };
    }
    if (method === "GET" && apiPath === `/companies/${companyId}/secrets`) {
      return secretExists ? [activeCanarySecret()] : [];
    }
    if (method === "DELETE" && apiPath === `/secrets/${secretId}`) {
      secretExists = false;
      return { ok: true };
    }
    if (method === "PATCH" && apiPath === `/agents/${canaryAgentId}`) {
      mutations.push(body.replaceAdapterConfig ? "restore" : "bind");
      agent.adapterConfig = body.replaceAdapterConfig
        ? structuredClone(body.adapterConfig)
        : { ...agent.adapterConfig, ...structuredClone(body.adapterConfig) };
      return structuredClone(agent);
    }
    if (apiPath.endsWith("/test-environment")) {
      throw new Error("Paperclip POST test-environment failed: HTTP 403 code=environment_company_mismatch");
    }
    throw new Error(`unexpected API call ${method} ${apiPath}`);
  };
  const applyArgs = args("apply");
  applyArgs[applyArgs.indexOf("--promote-fleet")] = "--canary-only";
  await assert.rejects(
    withoutConsoleLog(() => run(applyArgs, {
      applyEnabled: true,
      api,
      readReceipt: async () => undefined,
      randomUUID: () => canaryRunId,
      loadBoardToken: async () => boardToken,
      loadSourceToken: async () => sourceToken,
      writeReceipt: async (_path, value) => { terminalReceipt = structuredClone(value); },
    })),
    /environment_company_mismatch; automatic rollback=full_state_rolled_back/,
  );
  assert.deepEqual(mutations, ["bind", "restore"]);
  assert.equal(terminalReceipt.status, "full_state_rolled_back");
  assert.equal(terminalReceipt.rollbackPolicy.fullStateRollback, true);
  assert.equal(secretExists, false);
});

test("rerun recovers a crash after secret creation from the pre-creation journal and deletes only the orphan", async () => {
  const prior = {
    ...journalFields({ secretLifecycle: "creation_pending" }),
    status: "secret_creation_pending",
    apiBase: "http://127.0.0.1:3100",
    expectedCommit,
    companyId,
    environmentId,
    canaryAgentId,
    fleetAgentIds: [canaryAgentId],
    createdSecretId: null,
    deletedSecretId: null,
    targets: [{
      id: canaryAgentId,
      companyId,
      adapterType: "openclaw_gateway",
      previousAdapterConfig: safeAgent(canaryAgentId, "QA & Audit").adapterConfig,
      applied: false,
      mutationState: "untouched",
      smoke: null,
    }],
    events: [],
  };
  const agent = safeAgent(canaryAgentId, "QA & Audit");
  let catalog = [activeCanarySecret(canaryRunId, orphanSecretId)];
  const deletedSecrets = [];
  const api = async (method, apiPath, body) => {
    if (apiPath === "/health") return { status: "ok", commit: expectedCommit };
    if (apiPath.endsWith("/secret-providers/health")) return healthySecretProvider();
    if (apiPath === `/environments/${environmentId}`) return managedSandbox();
    if (apiPath === `/companies/${companyId}`) return { id: companyId };
    if (method === "GET" && apiPath === `/agents/${canaryAgentId}`) return structuredClone(agent);
    if (method === "GET" && apiPath === `/companies/${companyId}/secrets`) return structuredClone(catalog);
    if (method === "DELETE" && apiPath === `/secrets/${orphanSecretId}`) {
      deletedSecrets.push(orphanSecretId);
      catalog = [];
      return { ok: true };
    }
    if (method === "POST" && apiPath.endsWith("/secrets")) {
      assert.equal(body.key, `openclaw-gateway-canary-${nextCanaryRunId}`);
      assert.equal(body.name, `OpenClaw gateway canary ${nextCanaryRunId}`);
      catalog = [activeCanarySecret(nextCanaryRunId, secretId)];
      return { id: secretId };
    }
    if (method === "PATCH" && apiPath === `/agents/${canaryAgentId}`) {
      agent.adapterConfig = body.replaceAdapterConfig
        ? structuredClone(body.adapterConfig)
        : { ...agent.adapterConfig, ...structuredClone(body.adapterConfig) };
      return structuredClone(agent);
    }
    if (apiPath.endsWith("/test-environment")) return { status: "pass", checks: [] };
    throw new Error(`unexpected API call ${method} ${apiPath}`);
  };
  const applyArgs = [
    "apply",
    "--company-id", companyId,
    "--canary-agent-id", canaryAgentId,
    "--fleet-agent-ids", canaryAgentId,
    "--environment-id", environmentId,
    "--receipt", "/tmp/openclaw-canary-receipt.json",
    "--canary-only",
  ];
  const receipt = await withoutConsoleLog(() => run(applyArgs, {
    applyEnabled: true,
    api,
    readReceipt: async () => structuredClone(prior),
    randomUUID: () => nextCanaryRunId,
    loadBoardToken: async () => boardToken,
    loadSourceToken: async () => sourceToken,
    writeReceipt: async () => {},
  }));

  assert.equal(receipt.status, "canary_pass");
  assert.deepEqual(deletedSecrets, [orphanSecretId]);
  assert.deepEqual(receipt.recoveredPriorRun, {
    canaryRunId,
    deletedSecretId: orphanSecretId,
    status: "full_state_rolled_back",
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].id, secretId);
  assert.equal(catalog[0].key, `openclaw-gateway-canary-${nextCanaryRunId}`);
});

test("manual rollback rejects a tampered receipt before any adapter mutation", async () => {
  let mutations = 0;
  const receipt = {
    ...journalFields(),
    status: "canary_pass",
    apiBase: "http://127.0.0.1:3100",
    expectedCommit,
    companyId,
    environmentId,
    canaryAgentId,
    fleetAgentIds: [canaryAgentId],
    createdSecretId: secretId,
    targets: [{
      id: canaryAgentId,
      previousAdapterConfig: { headers: { Cookie: "session=tampered" } },
      applied: true,
      mutationState: "bound",
    }],
    events: [],
  };
  await assert.rejects(
    withoutConsoleLog(() => run([
      "rollback",
      "--receipt", "/tmp/openclaw-canary-receipt.json",
    ], {
      api: async (method, apiPath) => {
        if (apiPath === "/health") return { status: "ok", commit: expectedCommit };
        if (method === "PATCH") mutations += 1;
        throw new Error(`unexpected API call ${method} ${apiPath}`);
      },
      readReceipt: async () => structuredClone(receipt),
      loadBoardToken: async () => boardToken,
      writeReceipt: async () => {},
    })),
    /credential-bearing header/,
  );
  assert.equal(mutations, 0);
});

test("manual rollback rejects a tampered canary key before deleting any secret", async () => {
  const receipt = {
    ...journalFields({ plannedSecretKey: "preexisting-openclaw-token" }),
    status: "secret_created",
    apiBase: "http://127.0.0.1:3100",
    expectedCommit,
    companyId,
    environmentId,
    canaryAgentId,
    fleetAgentIds: [canaryAgentId],
    createdSecretId: secretId,
    targets: [{
      id: canaryAgentId,
      previousAdapterConfig: { url: "ws://127.0.0.1:18789" },
      applied: false,
      mutationState: "untouched",
    }],
    events: [],
  };
  const mutations = [];
  await assert.rejects(
    withoutConsoleLog(() => run([
      "rollback",
      "--receipt", "/tmp/openclaw-canary-receipt.json",
    ], {
      api: async (method, apiPath) => {
        if (method !== "GET") mutations.push(`${method} ${apiPath}`);
        if (method === "GET" && apiPath === "/health") return { status: "ok", commit: expectedCommit };
        return [];
      },
      readReceipt: async () => structuredClone(receipt),
      loadBoardToken: async () => boardToken,
      writeReceipt: async () => {},
    })),
    /canary secret key does not match its run id/,
  );
  assert.deepEqual(mutations, []);
});
