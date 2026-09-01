import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReceiptSafeAdapterConfig,
  run,
} from "./openclaw-secret-ref-canary.mjs";

const companyId = "11111111-1111-4111-8111-111111111111";
const canaryAgentId = "22222222-2222-4222-8222-222222222222";
const fleetAgentId = "33333333-3333-4333-8333-333333333333";
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
  return [
    mode,
    "--company-id", companyId,
    "--canary-agent-id", canaryAgentId,
    "--fleet-agent-ids", `${fleetAgentId},${canaryAgentId}`,
    "--receipt", "/tmp/openclaw-canary-receipt.json",
  ];
}

function healthySecretProvider() {
  return {
    providers: [{ provider: "local_encrypted", status: "ok" }],
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
  assert.throws(() => assertReceiptSafeAdapterConfig({ authToken: sourceToken }), /must be a secret_ref/);
  assert.throws(
    () => assertReceiptSafeAdapterConfig({ headers: { Authorization: `Bearer ${sourceToken}` } }),
    /legacy auth header/,
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
    api,
    loadBoardToken: async () => boardToken,
    loadSourceToken: async () => sourceToken,
    writeReceipt: async (_path, value) => receipts.push(structuredClone(value)),
  }));

  assert.equal(receipt.status, "pass");
  assert.deepEqual(receipt.secretProviderHealth, { provider: "local_encrypted", status: "ok" });
  assert.deepEqual(receipt.targets.map((target) => target.id), [canaryAgentId, fleetAgentId]);
  assert.deepEqual(receipt.targets.map((target) => target.smoke.status), ["pass", "pass"]);
  const patchCalls = calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(patchCalls.map((call) => call.apiPath), [`/agents/${canaryAgentId}`, `/agents/${fleetAgentId}`]);
  assert.equal(patchCalls[0].body.adapterConfig.authToken.type, "secret_ref");
  assert.equal(patchCalls[0].body.adapterConfig.authToken.secretId, secretId);
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
      api,
      loadBoardToken: async () => boardToken,
      loadSourceToken: async () => sourceToken,
      writeReceipt: async (_path, value) => { terminalReceipt = structuredClone(value); },
    })),
    /automatic rollback=rolled_back/,
  );

  assert.deepEqual(patchOrder, [
    `${canaryAgentId}:bind`,
    `${fleetAgentId}:bind`,
    `${fleetAgentId}:restore`,
    `${canaryAgentId}:restore`,
  ]);
  assert.equal(terminalReceipt.status, "rolled_back");
  assert.equal(terminalReceipt.retainedSecretId, secretId);
  assert.equal(terminalReceipt.targets.every((target) => target.applied === false), true);
  assert.equal(terminalReceipt.targets.every((target) => target.mutationState === "rolled_back"), true);
  assert.equal(JSON.stringify(terminalReceipt).includes(sourceToken), false);
});

test("a crash-window binding_pending receipt is rolled back idempotently", async () => {
  const prior = safeAgent(canaryAgentId, "QA & Audit").adapterConfig;
  let restoredBody;
  let terminalReceipt;
  const receipt = {
    schemaVersion: 1,
    status: "applying",
    apiBase: "http://127.0.0.1:3100",
    expectedCommit,
    companyId,
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

  assert.equal(result.status, "rolled_back");
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
    schemaVersion: 1,
    status: "pass",
    apiBase: "http://127.0.0.1:3100",
    expectedCommit,
    companyId,
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
