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
    if (method === "POST" && apiPath.endsWith("/secrets")) return { id: secretId };
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
  const persistedReceipts = JSON.stringify(receipts);
  assert.equal(persistedReceipts.includes(sourceToken), false);
  assert.equal(persistedReceipts.includes(boardToken), false);
});

test("a fleet smoke failure restores every applied config and retains the encrypted secret", async () => {
  const agents = new Map([
    [canaryAgentId, safeAgent(canaryAgentId, "QA & Audit")],
    [fleetAgentId, safeAgent(fleetAgentId, "Chiara")],
  ]);
  const patchOrder = [];
  let smokeCount = 0;
  let terminalReceipt;
  const api = async (method, apiPath, body) => {
    if (apiPath === "/health") return { status: "ok", commit: expectedCommit };
    if (apiPath.endsWith("/secret-providers/health")) return healthySecretProvider();
    if (apiPath === `/environments/${environmentId}`) return managedSandbox();
    if (apiPath === `/companies/${companyId}`) return { id: companyId, name: "Core360" };
    if (method === "GET" && apiPath.startsWith("/agents/")) return structuredClone(agents.get(apiPath.split("/").at(-1)));
    if (method === "POST" && apiPath.endsWith("/secrets")) return { id: secretId };
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
      loadBoardToken: async () => boardToken,
      loadSourceToken: async () => sourceToken,
      writeReceipt: async (_path, value) => { terminalReceipt = structuredClone(value); },
    })),
    /automatic rollback=adapter_configs_restored_secret_retained/,
  );

  assert.deepEqual(patchOrder, [
    `${canaryAgentId}:bind`,
    `${fleetAgentId}:bind`,
    `${fleetAgentId}:restore`,
    `${canaryAgentId}:restore`,
  ]);
  assert.equal(terminalReceipt.status, "adapter_configs_restored_secret_retained");
  assert.equal(terminalReceipt.retainedSecretId, secretId);
  assert.equal(terminalReceipt.rollbackPolicy.fullStateRollback, false);
  assert.equal(terminalReceipt.targets.every((target) => target.applied === false), true);
  assert.equal(terminalReceipt.targets.every((target) => target.mutationState === "rolled_back"), true);
  assert.equal(JSON.stringify(terminalReceipt).includes(sourceToken), false);
});

test("a crash-window binding_pending receipt is rolled back idempotently", async () => {
  const prior = safeAgent(canaryAgentId, "QA & Audit").adapterConfig;
  let restoredBody;
  let terminalReceipt;
  const receipt = {
    schemaVersion: 2,
    status: "applying",
    apiBase: "http://127.0.0.1:3100",
    expectedCommit,
    companyId,
    environmentId,
    canaryAgentId,
    fleetAgentIds: [canaryAgentId],
    createdSecretId: secretId,
    rollbackPolicy: {
      adapterConfigs: "restore_exact_previous_config",
      createdEncryptedSecret: "retain_for_recoverability",
      fullStateRollback: false,
    },
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

  assert.equal(result.status, "adapter_configs_restored_secret_retained");
  assert.equal(restoredBody.replaceAdapterConfig, true);
  assert.deepEqual(restoredBody.adapterConfig, prior);
  assert.equal(terminalReceipt.targets[0].mutationState, "rolled_back");
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
    schemaVersion: 2,
    status: "pass",
    apiBase: "http://127.0.0.1:3100",
    expectedCommit,
    companyId,
    environmentId,
    canaryAgentId,
    fleetAgentIds: [canaryAgentId],
    createdSecretId: secretId,
    rollbackPolicy: {
      adapterConfigs: "restore_exact_previous_config",
      createdEncryptedSecret: "retain_for_recoverability",
      fullStateRollback: false,
    },
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

test("a foreign-company sandbox rejection restores the canary and records partial rollback semantics", async () => {
  const agent = safeAgent(canaryAgentId, "QA & Audit");
  const mutations = [];
  let terminalReceipt;
  const api = async (method, apiPath, body) => {
    if (apiPath === "/health") return { status: "ok", commit: expectedCommit };
    if (apiPath.endsWith("/secret-providers/health")) return healthySecretProvider();
    if (apiPath === `/environments/${environmentId}`) return { ...managedSandbox(), companyId: null };
    if (apiPath === `/companies/${companyId}`) return { id: companyId };
    if (method === "GET" && apiPath === `/agents/${canaryAgentId}`) return structuredClone(agent);
    if (method === "GET" && apiPath === `/agents/${fleetAgentId}`) return safeAgent(fleetAgentId, "Chiara");
    if (method === "POST" && apiPath.endsWith("/secrets")) return { id: secretId };
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
      loadBoardToken: async () => boardToken,
      loadSourceToken: async () => sourceToken,
      writeReceipt: async (_path, value) => { terminalReceipt = structuredClone(value); },
    })),
    /environment_company_mismatch; automatic rollback=adapter_configs_restored_secret_retained/,
  );
  assert.deepEqual(mutations, ["bind", "restore"]);
  assert.equal(terminalReceipt.status, "adapter_configs_restored_secret_retained");
  assert.equal(terminalReceipt.rollbackPolicy.fullStateRollback, false);
});

test("manual rollback rejects a tampered receipt before any adapter mutation", async () => {
  let mutations = 0;
  const receipt = {
    schemaVersion: 2,
    status: "canary_pass",
    apiBase: "http://127.0.0.1:3100",
    expectedCommit,
    companyId,
    environmentId,
    canaryAgentId,
    fleetAgentIds: [canaryAgentId],
    createdSecretId: secretId,
    rollbackPolicy: {
      adapterConfigs: "restore_exact_previous_config",
      createdEncryptedSecret: "retain_for_recoverability",
      fullStateRollback: false,
    },
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
