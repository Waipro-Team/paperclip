import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const websocketState = vi.hoisted(() => ({
  connectionAttempts: 0,
  failConnectAttempts: 0,
  failAgentRequests: 0,
  events: [] as string[],
  configSnapshot: {
    sourceConfig: {
      agents: {
        defaults: { sandbox: { mode: "all", scope: "session" } },
        list: [{ id: "tenant-a" }],
      },
    },
  } as unknown,
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;
    readonly attempt: number;

    constructor() {
      super();
      this.attempt = ++websocketState.connectionAttempts;
      websocketState.events.push(`construct:${this.attempt}`);
      queueMicrotask(() => {
        if (this.attempt <= websocketState.failConnectAttempts) {
          this.emit("error", new Error("ECONNREFUSED"));
          return;
        }
        this.emit("open");
        this.emit("message", JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "test-nonce" },
        }));
      });
    }

    send(payload: string) {
      const request = JSON.parse(payload) as { id: string; method: string };
      websocketState.events.push(`send:${request.method}`);
      if (request.method === "agent" && websocketState.failAgentRequests > 0) {
        websocketState.failAgentRequests--;
        queueMicrotask(() => {
          this.emit("close", 1006, Buffer.from("ECONNRESET"));
        });
        return;
      }
      const responsePayload = request.method === "connect"
        ? { protocol: 3 }
        : request.method === "config.get"
          ? websocketState.configSnapshot
          : { status: "ok", runId: "remote-run-1", summary: "done" };
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          type: "res",
          id: request.id,
          ok: true,
          payload: responsePayload,
        }));
      });
    }

    close() {}
  }

  return { WebSocket: FakeWebSocket };
});

import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import * as isolation from "./isolation.js";

// These three transport-only tests exercise the lifecycle after authorization.
// Real-gate tests below never mock this verifier and must never dispatch.
function authorizeTransportFixture() {
  vi.spyOn(isolation, "validateOpenClawExecutionIsolation").mockReturnValue({ ok: true });
}

function createContext(input: {
  onDispatch?: () => void;
  onLog?: AdapterExecutionContext["onLog"];
  executionTarget?: AdapterExecutionContext["executionTarget"];
} = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      url: "ws://127.0.0.1:18789",
      agentId: "tenant-a",
      disableDeviceAuth: true,
      timeoutSec: 1,
    },
    context: {
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "interaction_resolved",
    },
    onLog: input.onLog ?? (async () => {}),
    onDispatch: input.onDispatch,
    executionTarget: input.executionTarget,
  };
}

describe("openclaw_gateway execute dispatch boundary", () => {
  beforeEach(() => {
    websocketState.connectionAttempts = 0;
    websocketState.failConnectAttempts = 0;
    websocketState.failAgentRequests = 0;
    websocketState.events = [];
    websocketState.configSnapshot = {
      sourceConfig: {
        agents: {
          defaults: { sandbox: { mode: "all", scope: "session" } },
          list: [{ id: "tenant-a" }],
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reports dispatch after transport setup and before the remote agent request", async () => {
    authorizeTransportFixture();
    const onDispatch = vi.fn(() => {
      websocketState.events.push("dispatch");
    });

    const result = await execute(createContext({ onDispatch }));

    expect(result).toMatchObject({ exitCode: 0 });
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(websocketState.events).toEqual([
      "construct:1",
      "send:connect",
      "send:config.get",
      "dispatch",
      "send:agent",
    ]);
  });

  it("retains the continuation gate through transient connection backoff", async () => {
    authorizeTransportFixture();
    vi.useFakeTimers();
    websocketState.failConnectAttempts = 1;
    let resolveBackoff!: () => void;
    const backoffReached = new Promise<void>((resolve) => {
      resolveBackoff = resolve;
    });
    let resolveAuthorityChange!: () => void;
    const authorityChange = new Promise<void>((resolve) => {
      resolveAuthorityChange = resolve;
    });
    const onDispatch = vi.fn(resolveAuthorityChange);
    const resultPromise = execute(createContext({
      onDispatch,
      onLog: async (_stream, chunk) => {
        if (chunk.includes("transient error, retry")) resolveBackoff();
      },
    }));

    await backoffReached;
    expect(websocketState.connectionAttempts).toBe(1);
    expect(onDispatch).not.toHaveBeenCalled();

    let authorityChangeSettled = false;
    void authorityChange.then(() => {
      authorityChangeSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(authorityChangeSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await resultPromise;
    await authorityChange;

    expect(result).toMatchObject({ exitCode: 0 });
    expect(websocketState.connectionAttempts).toBe(2);
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(authorityChangeSettled).toBe(true);
  });

  it("does not retry after the remote-work boundary has been crossed", async () => {
    authorizeTransportFixture();
    websocketState.failAgentRequests = 1;
    const onDispatch = vi.fn();

    const result = await execute(createContext({ onDispatch }));

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_request_failed",
    });
    expect(websocketState.connectionAttempts).toBe(1);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it("refuses a remote execution target before opening a host websocket", async () => {
    const onDispatch = vi.fn();

    const result = await execute(createContext({
      onDispatch,
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
      },
    }));

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_execution_target_unsupported",
    });
    expect(websocketState.connectionAttempts).toBe(0);
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it("requires an explicit non-main agentId before opening a websocket", async () => {
    const missingAgentContext = createContext();
    delete missingAgentContext.config.agentId;
    const missingResult = await execute(missingAgentContext);
    const mainResult = await execute({
      ...createContext(),
      config: { ...createContext().config, agentId: "main" },
    });

    expect(missingResult).toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_agent_id_missing",
    });
    expect(mainResult).toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_main_agent_forbidden",
    });
    expect(websocketState.connectionAttempts).toBe(0);
  });

  it("rejects a cross-agent payload override before opening a websocket", async () => {
    const context = createContext();
    context.config.payloadTemplate = { agentId: "tenant-b" };

    const result = await execute(context);

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_agent_id_mismatch",
    });
    expect(websocketState.connectionAttempts).toBe(0);
  });

  it("does not dispatch when the selected agent belongs to a different tenant", async () => {
    websocketState.configSnapshot = {
      sourceConfig: {
        agents: {
          defaults: { sandbox: { mode: "all" } },
          list: [{ id: "tenant-b" }],
        },
      },
    };
    const onDispatch = vi.fn();

    const result = await execute(createContext({ onDispatch }));

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_agent_not_found",
    });
    expect(websocketState.events).not.toContain("send:agent");
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch when the selected agent has sandbox.mode=off", async () => {
    websocketState.configSnapshot = {
      resolved: {
        agents: {
          defaults: { sandbox: { mode: "off" } },
          list: [{ id: "tenant-a" }],
        },
      },
    };
    const onDispatch = vi.fn();

    const result = await execute(createContext({ onDispatch }));

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_sandbox_not_enforced",
    });
    expect(websocketState.events).not.toContain("send:agent");
    expect(onDispatch).not.toHaveBeenCalled();
  });
});

describe("openclaw gateway real isolation gate", () => {
  beforeEach(() => {
    websocketState.connectionAttempts = 0;
    websocketState.failConnectAttempts = 0;
    websocketState.failAgentRequests = 0;
    websocketState.events = [];
    websocketState.configSnapshot = { runtimeConfig: { agents: {
      defaults: { model: "anthropic/claude-sonnet-5", sandbox: { mode: "all", scope: "agent" } },
      list: [{ id: "tenant-a" }],
    } } };
  });

  it.each([
    { model: "claude-cli/sonnet" },
    { model: "alias-for-plugin" },
    { provider: "runtime-only-provider" },
    { sessionId: "session-with-native-runtime-override" },
  ])("rejects request routing override before transport: %j", async (payloadTemplate) => {
    const context = createContext({ onDispatch: vi.fn() });
    context.config.payloadTemplate = payloadTemplate;
    const result = await execute(context);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_request_route_unverified" });
    expect(websocketState.connectionAttempts).toBe(0);
    expect(context.onDispatch).not.toHaveBeenCalled();
  });

  it("rejects a fixed cross-tenant session before transport", async () => {
    const context = createContext({ onDispatch: vi.fn() });
    context.config.sessionKeyStrategy = "fixed";
    context.config.sessionKey = "agent:tenant-b:paperclip";
    const result = await execute(context);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_session_agent_mismatch" });
    expect(websocketState.connectionAttempts).toBe(0);
    expect(context.onDispatch).not.toHaveBeenCalled();
  });

  it.each(["run", "issue", "fixed"])(
    "does not admit %s sessions from config.get without runtime/session proof", async (strategy) => {
      // Stock config.get omits runtime backend registrations and session state.
      // Even a new run key cannot exclude plugin execution or a racing update.
      const context = createContext({ onDispatch: vi.fn() });
      context.config.sessionKeyStrategy = strategy;
      const result = await execute(context);
      expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_execution_isolation_unverified" });
      expect(websocketState.events).toEqual(["construct:1", "send:connect", "send:config.get"]);
      expect(context.onDispatch).not.toHaveBeenCalled();
    },
  );

  it("does not expose the snapshot when denying execution", async () => {
    websocketState.configSnapshot = { runtimeConfig: {
      unrelated: "SYNTHETIC_SECRET_DO_NOT_LOG",
      agents: { defaults: { sandbox: { mode: "all" } }, list: [{ id: "tenant-a" }] },
    } };
    const logs: string[] = [];
    const result = await execute(createContext({ onLog: async (_stream, text) => { logs.push(text); } }));
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_execution_isolation_unverified" });
    expect(JSON.stringify({ result, logs })).not.toContain("SYNTHETIC_SECRET_DO_NOT_LOG");
    expect(websocketState.events).not.toContain("send:agent");
  });

  it("does not label the environment ready from a configuration-only probe", async () => {
    const result = await testEnvironment({
      adapterType: "openclaw_gateway",
      config: createContext().config,
    } as Parameters<typeof testEnvironment>[0]);
    expect(result.status).toBe("fail");
    expect(result.checks).toContainEqual(expect.objectContaining({
      level: "error", code: "openclaw_gateway_execution_isolation_unverified",
    }));
    expect(websocketState.events).not.toContain("send:agent");
  });
});
