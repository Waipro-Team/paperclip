import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const fixture = vi.hoisted(() => ({
  registry: {} as Record<string, unknown>,
  overrides: {} as Record<string, Record<string, unknown>>,
  calls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
  frames: [] as Record<string, unknown>[],
  children: [] as any[],
  reads: [] as string[],
  order: [] as string[],
  handler: null as null | ((frame: any, child: any) => void),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const metadata = (name: string) => ({
    uid: 0, gid: 0, mode: 0o100600, size: 1024,
    isFile: () => ["/etc/paperclip/openclaw-boundaries.json", "/etc/paperclip/keys/giulia", "/etc/paperclip/keys/known_hosts"].includes(name),
    isDirectory: () => !["/etc/paperclip/openclaw-boundaries.json", "/etc/paperclip/keys/giulia", "/etc/paperclip/keys/known_hosts"].includes(name),
    isSymbolicLink: () => false,
    ...fixture.overrides[name],
  });
  return { ...actual,
    lstat: vi.fn(async (name: string) => metadata(name)),
    open: vi.fn(async (name: string) => ({
      stat: async () => metadata(name),
      readFile: async () => { fixture.reads.push(name); return JSON.stringify(fixture.registry); },
      close: async () => {},
    })),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough, Writable } = await import("node:stream");
  return { ...actual, spawn: vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
    fixture.calls.push({ command, args, options });
    const child: any = new EventEmitter();
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const frame = JSON.parse(String(chunk));
      fixture.frames.push(frame);
      fixture.order.push("wire:" + frame.type);
      queueMicrotask(() => fixture.handler?.(frame, child));
      callback();
    } });
    child.send = (frame: unknown) => child.stdout.write(JSON.stringify(frame) + "\n");
    child.finish = (code = 0) => {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      child.stdout.end();
      queueMicrotask(() => child.emit("close", code, null));
    };
    child.kill = vi.fn(() => { child.finish(143); return true; });
    fixture.children.push(child);
    return child;
  }) };
});

import { assertBoundaryKeyPermissions, canonicalBoundaryParams, createTrustedBoundaryClient, parseBoundaryJson, type BoundaryIdentity } from "./trusted-boundary.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const identity: BoundaryIdentity = {
  boundaryId: "giulia-canary",
  companyId: "11111111-1111-4111-8111-111111111111",
  paperclipAgentId: "22222222-2222-4222-8222-222222222222",
  openclawAgentId: "giulia",
  runId: "33333333-3333-4333-8333-333333333333",
};
const gatewayRunId = "44444444-4444-4444-8444-444444444444";
function entry() {
  return (fixture.registry.boundaries as Record<string, any>)[identity.boundaryId];
}
function ready(frame: Record<string, unknown>) {
  const now = Date.now();
  return {
    v: 1, type: "ready", id: "open-1",
    boundaryId: frame.boundaryId, companyId: frame.companyId, paperclipAgentId: frame.paperclipAgentId,
    openclawAgentId: frame.openclawAgentId, runId: frame.runId,
    nonce: frame.nonce, paramsSha256: frame.paramsSha256,
    leaseId: "55555555-5555-4555-8555-555555555555",
    containerId: entry().containerId, imageId: entry().imageId,
    configSha256: entry().configSha256, soulSha256: entry().soulSha256,
    stateSha256: "e".repeat(64),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (entry().maxDurationMs ?? 180_000)).toISOString(),
  };
}
function accepted(child: any) {
  child.send({ v: 1, type: "accepted", id: "dispatch-1", runId: identity.runId, gatewayRunId,
    payload: { status: "ok", runId: gatewayRunId } });
}
function result(child: any, status = "ok") {
  child.send({ v: 1, type: "result", id: "dispatch-1", runId: identity.runId, gatewayRunId, status,
    payload: { status, runId: gatewayRunId, summary: "Persisted result",
      meta: { agentMeta: { provider: "claude-cli", model: "opus", usage: { inputTokens: 7, outputTokens: 11 } } } } });
}
function normalBroker(frame: any, child: any) {
  if (frame.type === "open") child.send(ready(frame));
  if (frame.type === "dispatch") {
    accepted(child);
    child.send({ v: 1, type: "event", frame: { type: "event", event: "agent",
      payload: { runId: gatewayRunId, stream: "assistant", data: { delta: "Giulia result" } } } });
    result(child);
    child.finish();
  }
}
function params(id = identity) {
  return canonicalBoundaryParams({ identity: id, message: "Synthetic task", timeoutSeconds: 120, template: {} });
}
async function client(id = identity, requestParams = params(id)) {
  return createTrustedBoundaryClient({ identity: id, params: requestParams, onEvent: async () => {} });
}
function context(config: Record<string, unknown> = {}): AdapterExecutionContext {
  return {
    runId: identity.runId,
    agent: { id: identity.paperclipAgentId, companyId: identity.companyId, name: "Giulia",
      adapterType: "openclaw_gateway", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { boundaryId: identity.boundaryId, agentId: identity.openclawAgentId, ...config },
    context: { issueId: "synthetic-issue", taskId: "synthetic-issue" },
    onLog: async () => {},
    onDispatch: () => { fixture.order.push("dispatch"); },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.spyOn(process, "getegid").mockReturnValue(0);
  vi.spyOn(process, "getgroups").mockReturnValue([0]);
  fixture.registry = { v: 1, boundaries: { [identity.boundaryId]: {
    companyId: identity.companyId, paperclipAgentId: identity.paperclipAgentId, openclawAgentId: identity.openclawAgentId,
    ssh: { host: "waipro.example", port: 22, user: "giulia-broker",
      identityFile: "/etc/paperclip/keys/giulia", knownHostsFile: "/etc/paperclip/keys/known_hosts" },
    containerId: "a".repeat(64), imageId: "sha256:" + "b".repeat(64),
    configSha256: "c".repeat(64), soulSha256: "d".repeat(64),
  } } };
  fixture.overrides = {}; fixture.calls = []; fixture.frames = [];
  fixture.children = []; fixture.reads = []; fixture.order = [];
  fixture.handler = normalBroker;
});
afterEach(() => {
  for (const child of fixture.children) child.finish(143);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("trusted boundary private registry", () => {
  it.each([
    ["/etc/paperclip/openclaw-boundaries.json", { uid: 1000 }],
    ["/etc/paperclip/openclaw-boundaries.json", { mode: 0o100620 }],
    ["/etc/paperclip", { mode: 0o40777 }],
    ["/etc", { isSymbolicLink: (): boolean => true }],
    ["/etc/paperclip/keys/giulia", { isSymbolicLink: (): boolean => true }],
    ["/etc/paperclip/keys/known_hosts", { mode: 0o100666 }],
  ] as const)("rejects untrusted file or ancestry %s", async (name, metadata) => {
    fixture.overrides[name] = metadata;
    await expect(client()).rejects.toMatchObject({ code: "openclaw_boundary_registry_untrusted" });
    expect(fixture.calls).toHaveLength(0);
  });


  it.each([0o100644, 0o100640, 0o100604, 0o100700, 0o100000, 0o104600])(
    "rejects private key mode %s before opening SSH without reading its contents", async (mode) => {
      fixture.overrides["/etc/paperclip/keys/giulia"] = { mode };
      await expect(client()).rejects.toMatchObject({ code: "openclaw_boundary_registry_untrusted" });
      expect(fixture.calls).toHaveLength(0);
      expect(fixture.reads).toEqual(["/etc/paperclip/openclaw-boundaries.json"]);
    },
  );

  it.each([0o100400, 0o100600])("accepts only root-readable private key mode %s", async (mode) => {
    fixture.overrides["/etc/paperclip/keys/giulia"] = { mode };
    const transport = await client();
    await transport.connect();
    expect(fixture.calls).toHaveLength(1);
    transport.close();
  });


  it.each([0o100440, 0o100640])("admits a private service-group key mode %s for the actual process group", async (mode) => {
    entry().ssh.identityFileGroupId = 10001;
    fixture.overrides["/etc/paperclip/keys/giulia"] = { mode, gid: 10001 };
    vi.spyOn(process, "geteuid").mockReturnValue(10001);
    vi.spyOn(process, "getegid").mockReturnValue(10001);
    vi.spyOn(process, "getgroups").mockReturnValue([]);
    const transport = await client(); await transport.connect(); transport.close();
    expect(fixture.calls).toHaveLength(1);
  });

  it("supports a pinned supplementary service group without making Paperclip root", async () => {
    entry().ssh.identityFileGroupId = 10002;
    fixture.overrides["/etc/paperclip/keys/giulia"] = { mode: 0o100640, gid: 10002 };
    vi.spyOn(process, "geteuid").mockReturnValue(10001);
    vi.spyOn(process, "getegid").mockReturnValue(10001);
    vi.spyOn(process, "getgroups").mockReturnValue([10002]);
    const transport = await client(); await transport.connect(); transport.close();
    expect(fixture.calls).toHaveLength(1);
  });

  it.each(["unregistered-gid", "wrong-gid", "not-member", "other-readable", "root-only-unreadable",
    "invalid-group-id", "wrong-owner", "special-mode"])("rejects a %s key before SSH", async (kind) => {
    vi.spyOn(process, "geteuid").mockReturnValue(10001);
    vi.spyOn(process, "getegid").mockReturnValue(10001);
    vi.spyOn(process, "getgroups").mockReturnValue([]);
    entry().ssh.identityFileGroupId = 10001;
    fixture.overrides["/etc/paperclip/keys/giulia"] = { mode: 0o100640, gid: 10001 };
    if (kind === "unregistered-gid") delete entry().ssh.identityFileGroupId;
    if (kind === "wrong-gid") fixture.overrides["/etc/paperclip/keys/giulia"].gid = 10002;
    if (kind === "not-member") {
      entry().ssh.identityFileGroupId = 10002;
      fixture.overrides["/etc/paperclip/keys/giulia"].gid = 10002;
    }
    if (kind === "other-readable") fixture.overrides["/etc/paperclip/keys/giulia"].mode = 0o100644;
    if (kind === "root-only-unreadable") {
      delete entry().ssh.identityFileGroupId;
      fixture.overrides["/etc/paperclip/keys/giulia"].mode = 0o100600;
    }
    if (kind === "invalid-group-id") entry().ssh.identityFileGroupId = "10001";
    if (kind === "wrong-owner") fixture.overrides["/etc/paperclip/keys/giulia"].uid = 10001;
    if (kind === "special-mode") fixture.overrides["/etc/paperclip/keys/giulia"].mode = 0o104640;
    await expect(client()).rejects.toMatchObject({ code: "openclaw_boundary_registry_untrusted" });
    expect(fixture.calls).toHaveLength(0);
  });

  it.runIf(process.platform === "linux" && process.getuid?.() === 0)(
    "checks real key permissions and kernel readability under UID/GID 10001", async () => {
      const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const directory = await fs.mkdtemp(join(tmpdir(), "boundary-key-permissions-"));
      const file = join(directory, "synthetic-key");
      // Test data only. No real SSH key or service path is read or changed.
      try {
        await fs.chmod(directory, 0o755);
        await fs.writeFile(file, "SYNTHETIC_PERMISSION_FIXTURE", { mode: 0o600 });
        const source = `import { statSync, readFileSync } from "node:fs";
          const check = ${assertBoundaryKeyPermissions.toString()};
          const file = process.argv[1];
          const group = JSON.parse(process.argv[2]);
          let admitted = true, readable = true;
          try { check(statSync(file), group === null ? undefined : group); } catch { admitted = false; }
          try { readFileSync(file); } catch { readable = false; }
          process.stdout.write(JSON.stringify({ uid: process.geteuid(), gid: process.getegid(), admitted, readable }));`;
        for (const scenario of [
          { mode: 0o640, fileGid: 10001, groupId: 10001, admitted: true, readable: true },
          { mode: 0o440, fileGid: 10001, groupId: 10001, admitted: true, readable: true },
          { mode: 0o600, fileGid: 10001, groupId: null, admitted: false, readable: false },
          { mode: 0o640, fileGid: 10002, groupId: 10002, admitted: false, readable: false },
          { mode: 0o640, fileGid: 10001, groupId: null, admitted: false, readable: true },
          { mode: 0o644, fileGid: 10001, groupId: 10001, admitted: false, readable: true },
        ]) {
          await fs.chown(file, 0, scenario.fileGid);
          await fs.chmod(file, scenario.mode);
          const outcome = spawnSync(process.execPath, ["--input-type=module", "-e", source, file, JSON.stringify(scenario.groupId)],
            { uid: 10001, gid: 10001, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000 });
          expect(outcome.status, outcome.stderr).toBe(0);
          expect(JSON.parse(outcome.stdout)).toEqual({ uid: 10001, gid: 10001,
            admitted: scenario.admitted, readable: scenario.readable });
        }
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    },
  );

  it.each(["companyId", "paperclipAgentId", "openclawAgentId"] as const)(
    "binds %s to the server identity instead of config claims", async (key) => {
      entry()[key] = "another-identity";
      await expect(client()).rejects.toMatchObject({ code: "openclaw_boundary_registry_untrusted" });
      expect(fixture.calls).toHaveLength(0);
    },
  );

  it("requires an existing exact boundary selector and canonical private key paths", async () => {
    await expect(client({ ...identity, boundaryId: "not-registered" })).rejects.toMatchObject({ code: "openclaw_boundary_registry_untrusted" });
    entry().ssh.identityFile = "/etc/paperclip/keys/../other";
    await expect(client()).rejects.toMatchObject({ code: "openclaw_boundary_registry_untrusted" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("pins SSH host keys and identity without a remote command, shell, environment or credential reads", async () => {
    const transport = await client();
    await transport.connect();
    const invocation = fixture.calls[0];
    expect(invocation.command).toBe("/usr/bin/ssh");
    expect(invocation.args.at(-1)).toBe("giulia-broker@waipro.example");
    for (const option of ["BatchMode=yes", "IdentitiesOnly=yes", "StrictHostKeyChecking=yes",
      "ForwardAgent=no", "ClearAllForwardings=yes", "IdentityAgent=none",
      "ProxyCommand=none", "ProxyJump=none", "PermitLocalCommand=no",
      "UserKnownHostsFile=/etc/paperclip/keys/known_hosts"]) expect(invocation.args).toContain(option);
    expect(invocation.options).toMatchObject({ shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
    expect(Object.keys(invocation.options.env as object)).toEqual(["PATH", "LANG"]);
    expect(fixture.reads).toEqual(["/etc/paperclip/openclaw-boundaries.json"]);
    transport.close();
  });
});

describe("broker protocol admission and ordering", () => {
  it.each([
    ["nonce", "f".repeat(64)], ["paramsSha256", "f".repeat(64)],
    ["companyId", "66666666-6666-4666-8666-666666666666"],
    ["paperclipAgentId", "66666666-6666-4666-8666-666666666666"],
    ["openclawAgentId", "other"], ["runId", "66666666-6666-4666-8666-666666666666"],
    ["containerId", "f".repeat(64)], ["imageId", "sha256:" + "f".repeat(64)],
    ["configSha256", "f".repeat(64)], ["soulSha256", "f".repeat(64)],
    ["stateSha256", ""], ["leaseId", ""], ["expiresAt", "2020-01-01T00:00:00Z"],
    ["issuedAt", "2020-01-01T00:00:00Z"], ["id", "other-open"],
  ])("rejects an unbound or stale ready %s before dispatch", async (key, value) => {
    fixture.handler = (frame, child) => child.send({ ...ready(frame), [key]: value });
    const transport = await client();
    await expect(transport.connect()).rejects.toMatchObject({ code: "openclaw_boundary_protocol_invalid", dispatched: false });
    expect(fixture.frames.map((frame) => frame.type)).toEqual(["open"]);
  });

  it("does not replay a ready proof from an earlier SSH session", async () => {
    let oldProof: unknown;
    fixture.handler = (frame, child) => {
      oldProof ??= ready(frame);
      child.send(oldProof);
    };
    const first = await client(); await first.connect(); first.close();
    const second = await client();
    await expect(second.connect()).rejects.toMatchObject({ code: "openclaw_boundary_protocol_invalid" });
    expect(fixture.frames.map((frame) => frame.type)).toEqual(["open", "open"]);
  });

  it("rejects a lease that expired between admission and dispatch", async () => {
    vi.useFakeTimers();
    fixture.handler = (frame, child) => child.send({ ...ready(frame),
      expiresAt: new Date(Date.now() + 1000).toISOString() });
    const transport = await client(); await transport.connect();
    await vi.advanceTimersByTimeAsync(1001);
    await expect(transport.request("agent", params())).rejects.toMatchObject({ code: "openclaw_boundary_dispatch_rejected" });
    expect(fixture.frames.map((frame) => frame.type)).toEqual(["open"]);
    transport.close();
  });

  it("rejects params changed after ready and sends exactly one dispatch with stored digest", async () => {
    const transport = await client();
    const proof = await transport.connect();
    await expect(transport.request("agent", { ...params(), message: "changed" })).rejects.toMatchObject({
      code: "openclaw_boundary_dispatch_rejected",
    });
    const ack = await transport.request<Record<string, unknown>>("agent", params());
    const completed = await transport.request<Record<string, unknown>>("agent.wait", { runId: ack.runId });
    expect(completed).toMatchObject({ status: "ok", paperclipBoundary: { leaseId: proof.leaseId } });
    expect(fixture.frames.map((frame) => frame.type)).toEqual(["open", "dispatch"]);
    expect(fixture.frames[1]).toEqual({ v: 1, type: "dispatch", id: "dispatch-1",
      leaseId: proof.leaseId, paramsSha256: proof.paramsSha256 });
    await expect(transport.request("agent", params())).rejects.toMatchObject({ code: "openclaw_boundary_dispatch_rejected" });
    expect(fixture.frames).toHaveLength(2);
  });

  it.each(["config.get", "device.pair.approve", "sessions.get"])("forbids arbitrary broker RPC %s", async (method) => {
    const transport = await client(); await transport.connect();
    await expect(transport.request(method, {})).rejects.toMatchObject({ code: "openclaw_boundary_rpc_forbidden" });
    expect(fixture.frames).toHaveLength(1);
    transport.close();
  });

  it.each(["duplicate-key", "nonfinite", "overlong", "noise"])("fails closed for malformed %s output", async (kind) => {
    fixture.handler = (_frame, child) => {
      const wire = kind === "duplicate-key" ? '{"v":1,"v":1,"type":"ready"}\n'
        : kind === "nonfinite" ? '{"v":1,"value":1e999}\n'
        : kind === "overlong" ? "x".repeat(1024 * 1024)
        : "ssh banner outside protocol\n";
      child.stdout.write(wire);
    };
    const transport = await client();
    await expect(transport.connect()).rejects.toBeInstanceOf(Error);
    expect(fixture.frames.map((frame) => frame.type)).toEqual(["open"]);
  });


  it.each(["invalid-utf8", "truncated-utf8", "partial-frame", "bom"])("rejects %s on the authenticated stream", async (kind) => {
    fixture.handler = (_frame, child) => {
      child.stdout.write(kind === "invalid-utf8" ? Buffer.from([0xff, 0x0a])
        : kind === "truncated-utf8" ? Buffer.from([0xf0, 0x9f])
        : kind === "bom" ? Buffer.from("\uFEFF" + JSON.stringify(ready(_frame)) + "\n") : Buffer.from('{"v":1'));
      child.finish();
    };
    const transport = await client();
    await expect(transport.connect()).rejects.toBeInstanceOf(Error);
    expect(fixture.frames.map((frame) => frame.type)).toEqual(["open"]);
  });

  it("accepts valid UTF-8 frames fragmented inside a multibyte code point", async () => {
    fixture.handler = (frame, child) => {
      if (frame.type === "open") child.send(ready(frame));
      else {
        accepted(child);
        const wire = Buffer.from(JSON.stringify({ v: 1, type: "event", frame: {
          type: "event", event: "agent", payload: { runId: gatewayRunId,
            stream: "assistant", data: { delta: "Pronta 🧰" } },
        } }) + "\n");
        const split = wire.indexOf(Buffer.from("🧰")) + 2;
        child.stdout.write(wire.subarray(0, split));
        child.stdout.write(wire.subarray(split));
        result(child); child.finish();
      }
    };
    expect(await execute(context())).toMatchObject({ exitCode: 0, summary: "Pronta 🧰" });
  });

  it.each(["result-binding", "trailing-data", "duplicate-ready"])("rejects invalid %s without replay", async (kind) => {
    fixture.handler = (frame, child) => {
      if (frame.type === "open") {
        child.send(ready(frame));
        if (kind === "duplicate-ready") child.send(ready(frame));
      } else {
        accepted(child);
        if (kind === "result-binding") child.send({ v: 1, type: "result", id: "dispatch-1",
          runId: "other-run", gatewayRunId, status: "ok", payload: { status: "ok" } });
        else { result(child); child.stdout.write(" "); child.finish(); }
      }
    };
    expect(await execute(context())).toMatchObject({ exitCode: 1 });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.frames.filter((frame) => frame.type === "dispatch").length).toBe(kind === "duplicate-ready" ? 0 : 1);
  });

  it("keeps the run indeterminate after a result followed by a failed broker exit", async () => {
    fixture.handler = (frame, child) => {
      if (frame.type === "open") child.send(ready(frame));
      else { accepted(child); result(child); child.finish(1); }
    };
    const response = await execute(context());
    expect(response).toMatchObject({ exitCode: 1, errorCode: "openclaw_boundary_transport_closed",
      resultJson: { dispatched: true, indeterminate: true } });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.frames.map((frame) => frame.type)).toEqual(["open", "dispatch"]);
  });

  it("rejects cross-run events and terminal results", async () => {
    fixture.handler = (frame, child) => {
      if (frame.type === "open") child.send(ready(frame));
      else {
        accepted(child);
        child.send({ v: 1, type: "event", frame: { type: "event", event: "agent",
          payload: { runId: "other-run", stream: "assistant", data: { delta: "wrong tenant" } } } });
      }
    };
    const response = await execute(context());
    expect(response).toMatchObject({ exitCode: 1, errorCode: "openclaw_boundary_protocol_invalid" });
    expect(response.summary).toBeUndefined();
    expect(fixture.calls).toHaveLength(1);
  });

  it("keeps a clean terminal timeout indeterminate because wait expiry does not cancel the native process", async () => {
    fixture.handler = (frame, child) => {
      if (frame.type === "open") child.send(ready(frame));
      else { accepted(child); result(child, "timeout"); child.finish(); }
    };
    expect(await execute(context())).toMatchObject({ exitCode: 1, timedOut: true,
      resultJson: { status: "timeout", dispatched: true, indeterminate: true } });
    expect(fixture.calls).toHaveLength(1);
  });

  it("never copies broker errors or stderr into adapter results or logs", async () => {
    fixture.handler = (frame, child) => {
      child.stderr.write("SYNTHETIC_PRIVATE_PATH_OR_TOKEN");
      child.send({ v: 1, type: "error", id: frame.id,
        code: "synthetic_private_error_detail", dispatched: false, indeterminate: false });
    };
    const logs: string[] = [];
    const ctx = context(); ctx.onLog = async (_stream, chunk) => { logs.push(chunk); };
    const response = await execute(ctx);
    expect(response).toMatchObject({ exitCode: 1, errorCode: "openclaw_boundary_broker_rejected" });
    expect(JSON.stringify({ response, logs })).not.toContain("SYNTHETIC_PRIVATE");
    expect(JSON.stringify({ response, logs })).not.toContain("synthetic_private_error_detail");
    expect(fixture.frames).toHaveLength(1);
  });

  it("closes an unresponsive broker on the connect deadline without dispatch", async () => {
    vi.useFakeTimers();
    fixture.handler = () => {};
    const transport = await client();
    const connecting = transport.connect();
    const assertion = expect(connecting).rejects.toMatchObject({ code: "openclaw_boundary_connect_timeout", dispatched: false });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(fixture.frames.map((frame) => frame.type)).toEqual(["open"]);
  });


  it("allows forty seconds of silent native computation after acceptance", async () => {
    vi.useFakeTimers();
    fixture.handler = (frame, child) => {
      if (frame.type === "open") child.send(ready(frame));
      else {
        accepted(child);
        setTimeout(() => { result(child); child.finish(); }, 40_000);
      }
    };
    let completed = false;
    const running = execute(context()).then((response) => { completed = true; return response; });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(completed).toBe(false);
    expect(fixture.children[0].kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(await running).toMatchObject({ exitCode: 0 });
    expect(fixture.calls).toHaveLength(1);
  });

  it("still expires a silent broker before acceptance at thirty seconds", async () => {
    vi.useFakeTimers();
    fixture.handler = (frame, child) => {
      if (frame.type === "open") child.send(ready(frame));
    };
    const running = execute(context());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await running).toMatchObject({ exitCode: 1, errorCode: "openclaw_boundary_idle_timeout",
      resultJson: { dispatched: true, indeterminate: true } });
    expect(fixture.calls).toHaveLength(1);
  });

  it("expires accepted silent work at the private 180-second hard limit without replay", async () => {
    vi.useFakeTimers();
    fixture.handler = (frame, child) => {
      if (frame.type === "open") child.send(ready(frame));
      else accepted(child);
    };
    let completed = false;
    const running = execute(context()).then((response) => { completed = true; return response; });
    await vi.advanceTimersByTimeAsync(179_999);
    expect(completed).toBe(false);
    expect(fixture.children[0].kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toMatchObject({ exitCode: 1, errorCode: "openclaw_boundary_deadline",
      resultJson: { dispatched: true, indeterminate: true } });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.frames.map((frame) => frame.type)).toEqual(["open", "dispatch"]);
  });

  it("enforces the private hard deadline after dispatch and never reconnects", async () => {
    vi.useFakeTimers(); entry().maxDurationMs = 1000;
    fixture.handler = (frame, child) => {
      if (frame.type === "open") child.send(ready(frame));
      else accepted(child);
    };
    const running = execute(context({ timeoutSec: 1 }));
    await vi.advanceTimersByTimeAsync(1000);
    const response = await running;
    expect(response).toMatchObject({ exitCode: 1, timedOut: true, errorCode: "openclaw_boundary_deadline",
      resultJson: { dispatched: true, indeterminate: true } });
    expect(fixture.calls).toHaveLength(1);
  });
});

describe("bound execution integration", () => {
  it("uses fresh broker proof for an isolated default/native agent and reuses result/event parsing", async () => {
    const ctx = context({ sessionKeyStrategy: "fixed", sessionKey: "agent:other:private" });
    for (const key of ["url", "headers", "authToken", "password", "deviceToken"]) {
      Object.defineProperty(ctx.config, key, { get() { throw new Error("untrusted endpoint/auth was read"); } });
    }
    const response = await execute(ctx);
    expect(response).toMatchObject({ exitCode: 0, summary: "Giulia result", provider: "claude-cli", model: "opus",
      usage: { inputTokens: 7, outputTokens: 11 },
      resultJson: { paperclipBoundary: { ...identity, imageId: entry().imageId } } });
    const outbound = JSON.parse(fixture.frames[0].paramsJson as string);
    expect(outbound).toMatchObject({ timeout: 120, deliver: false, idempotencyKey: identity.runId,
      sessionKey: `agent:giulia:paperclip:company:${identity.companyId}:run:${identity.runId}` });
    expect(fixture.order).toEqual(["wire:open", "dispatch", "wire:dispatch"]);
    expect(fixture.frames).toHaveLength(2);
  });


  it("admits the default agent only when its complete identity is pinned privately", async () => {
    entry().openclawAgentId = "main";
    const response = await execute(context({ agentId: "main" }));
    expect(response).toMatchObject({ exitCode: 0, resultJson: { paperclipBoundary: { openclawAgentId: "main" } } });
    expect(JSON.parse(fixture.frames[0].paramsJson as string).sessionKey)
      .toBe(`agent:main:paperclip:company:${identity.companyId}:run:${identity.runId}`);
  });

  it.each([{ model: "claude-cli/opus" }, { provider: "other" }, { sessionId: "old" }, { timeout: 999 },
    { deliver: true }, { unknownSelector: true }])("rejects payload selectors %j without transport", async (payloadTemplate) => {
    const response = await execute(context({ payloadTemplate }));
    expect(response).toMatchObject({ exitCode: 1, errorCode: "openclaw_boundary_params_invalid" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("never interprets environment probes as a trusted execution identity", async () => {
    const response = await testEnvironment({ companyId: identity.companyId, adapterType: "openclaw_gateway",
      config: { boundaryId: identity.boundaryId, agentId: "giulia" } });
    expect(response).toMatchObject({ status: "fail", checks: [{ code: "openclaw_boundary_execution_identity_required" }] });
    expect(fixture.calls).toHaveLength(0);
  });

  it("rejects no-timeout requests instead of forwarding OpenClaw's disabling zero", async () => {
    expect(await execute(context({ timeoutSec: 0 }))).toMatchObject({
      exitCode: 1, errorCode: "openclaw_boundary_params_invalid",
    });
    expect(fixture.calls).toHaveLength(0);
  });
});

describe("strict protocol JSON", () => {
  it("preserves unicode message bytes and rejects duplicate escaped keys", () => {
    expect(parseBoundaryJson('{"message":"Giulia è pronta 🧰","values":[true,null,1.5]}'))
      .toEqual({ message: "Giulia è pronta 🧰", values: [true, null, 1.5] });
    expect(() => parseBoundaryJson('{"a":1,"\\u0061":2}')).toThrow();
  });
});
