import crypto from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const REGISTRY_PATH = "/etc/paperclip/openclaw-boundaries.json";
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 16 * MAX_FRAME_BYTES;
const MAX_DURATION_MS = 180_000;
const CONNECT_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 30_000;
const CLOCK_SKEW_MS = 5_000;

type RecordValue = Record<string, unknown>;
export type BoundaryIdentity = {
  boundaryId: string;
  companyId: string;
  paperclipAgentId: string;
  openclawAgentId: string;
  runId: string;
};
type BoundaryEntry = Omit<BoundaryIdentity, "boundaryId" | "runId"> & {
  ssh: { host: string; port: number; user: string; identityFile: string; knownHostsFile: string; identityFileGroupId?: number };
  containerId: string;
  imageId: string;
  configSha256: string;
  soulSha256: string;
  maxDurationMs: number;
};
export type BoundaryEvent = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};
type Ready = BoundaryIdentity & {
  v: 1; type: "ready"; id: string; nonce: string; paramsSha256: string;
  leaseId: string; containerId: string; imageId: string;
  configSha256: string; soulSha256: string; stateSha256: string;
  issuedAt: string; expiresAt: string;
};

export class TrustedBoundaryError extends Error {
  constructor(
    readonly code: string,
    readonly dispatched = false,
    readonly indeterminate = false,
  ) {
    super(code);
    this.name = "TrustedBoundaryError";
  }
}

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object_required");
  return value as RecordValue;
}
function keys(value: RecordValue, required: string[], optional: string[] = []) {
  if (required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error("schema_mismatch");
  }
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || pattern.exec(value)?.[0] !== value) throw new Error("invalid_string");
  return value;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Parse protocol JSON without accepting duplicate keys, nonfinite numbers or deep frames. */
export function parseBoundaryJson(source: string): unknown {
  let pos = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(source[pos] ?? "") && pos < source.length) pos++; };
  const string = (): string => {
    const start = pos++;
    while (pos < source.length) {
      const char = source[pos++];
      if (char === '"') return JSON.parse(source.slice(start, pos));
      if (char === "\\") pos++;
    }
    throw new Error("invalid_json");
  };
  const value = (depth: number): unknown => {
    if (depth > 64) throw new Error("json_depth");
    whitespace();
    const char = source[pos];
    if (char === '"') return string();
    if (char === "{") {
      pos++; whitespace();
      const output: RecordValue = Object.create(null);
      if (source[pos] === "}") { pos++; return output; }
      while (true) {
        whitespace();
        if (source[pos] !== '"') throw new Error("invalid_json");
        const key = string();
        if (Object.hasOwn(output, key)) throw new Error("duplicate_json_key");
        whitespace();
        if (source[pos++] !== ":") throw new Error("invalid_json");
        output[key] = value(depth + 1);
        whitespace();
        const next = source[pos++];
        if (next === "}") return output;
        if (next !== ",") throw new Error("invalid_json");
      }
    }
    if (char === "[") {
      pos++; whitespace();
      const output: unknown[] = [];
      if (source[pos] === "]") { pos++; return output; }
      while (true) {
        output.push(value(depth + 1)); whitespace();
        const next = source[pos++];
        if (next === "]") return output;
        if (next !== ",") throw new Error("invalid_json");
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(pos))?.[0];
    if (!token) throw new Error("invalid_json");
    pos += token.length;
    const parsed = JSON.parse(token);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) throw new Error("nonfinite_json");
    return parsed;
  };
  const output = value(0);
  whitespace();
  if (pos !== source.length) throw new Error("invalid_json");
  return output;
}


/** Check key confidentiality and readability against the effective service identity. */
export function assertBoundaryKeyPermissions(
  stat: { uid: number; gid: number; mode: number },
  groupId?: number,
): void {
  const mode = stat.mode & 0o7777;
  if (stat.uid !== 0) throw new Error("private_key_owner");
  if (groupId === undefined) {
    if (![0o400, 0o600].includes(mode) || process.geteuid?.() !== 0) {
      throw new Error("private_key_permissions");
    }
    return;
  }
  if (!Number.isInteger(groupId) || groupId < 0 || groupId > 4_294_967_294 ||
      stat.gid !== groupId || ![0o440, 0o640].includes(mode) ||
      ![process.getegid?.(), ...(process.getgroups?.() ?? [])].includes(groupId)) {
    throw new Error("private_key_group_permissions");
  }
}

async function protectedPath(file: string, regularFile: boolean, privateKey = false, groupId?: number) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error("path_invalid");
  let current = file;
  let leaf = true;
  while (true) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 ||
        (leaf && regularFile ? !stat.isFile() : !stat.isDirectory())) throw new Error("path_untrusted");
    if (leaf && privateKey) assertBoundaryKeyPermissions(stat, groupId);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent; leaf = false;
  }
}

async function loadEntry(identity: BoundaryIdentity): Promise<BoundaryEntry> {
  try {
    text(identity.boundaryId, ID);
    text(identity.companyId, UUID);
    text(identity.paperclipAgentId, UUID);
    text(identity.openclawAgentId, ID);
    text(identity.runId, UUID);
    await protectedPath(REGISTRY_PATH, true);
    const file = await open(REGISTRY_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    let registry: RecordValue;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 65_536) throw new Error("registry_untrusted");
      registry = record(parseBoundaryJson(await file.readFile("utf8")));
    } finally { await file.close(); }
    keys(registry, ["v", "boundaries"]);
    if (registry.v !== 1) throw new Error("version");
    const entry = record(record(registry.boundaries)[identity.boundaryId]);
    keys(entry, ["companyId", "paperclipAgentId", "openclawAgentId", "ssh", "containerId", "imageId", "configSha256", "soulSha256"], ["maxDurationMs"]);
    for (const key of ["companyId", "paperclipAgentId", "openclawAgentId"] as const) {
      if (entry[key] !== identity[key]) throw new Error("identity_mismatch");
    }
    const ssh = record(entry.ssh);
    keys(ssh, ["host", "port", "user", "identityFile", "knownHostsFile"], ["identityFileGroupId"]);
    if (Object.hasOwn(ssh, "identityFileGroupId") &&
        (!Number.isInteger(ssh.identityFileGroupId) || Number(ssh.identityFileGroupId) < 0 ||
         Number(ssh.identityFileGroupId) > 4_294_967_294)) throw new Error("private_key_group");
    text(ssh.host, /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/);
    text(ssh.user, /^[a-z_][a-z0-9_-]{0,31}$/);
    if (!Number.isInteger(ssh.port) || Number(ssh.port) < 1 || Number(ssh.port) > 65535) throw new Error("port");
    for (const key of ["identityFile", "knownHostsFile"]) {
      if (typeof ssh[key] !== "string") throw new Error("path");
      await protectedPath(ssh[key] as string, true, key === "identityFile", ssh.identityFileGroupId as number | undefined);
    }
    text(entry.containerId, SHA256);
    text(entry.imageId, /^sha256:[a-f0-9]{64}$/);
    text(entry.configSha256, SHA256);
    text(entry.soulSha256, SHA256);
    const maxDurationMs = entry.maxDurationMs ?? MAX_DURATION_MS;
    if (!Number.isInteger(maxDurationMs) || Number(maxDurationMs) < 1000 || Number(maxDurationMs) > MAX_DURATION_MS) throw new Error("duration");
    return { ...entry, ssh: { ...ssh }, maxDurationMs } as BoundaryEntry;
  } catch {
    throw new TrustedBoundaryError("openclaw_boundary_registry_untrusted");
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A transport may fail before the consumer requests the next phase.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export function canonicalBoundaryParams(input: {
  identity: BoundaryIdentity;
  message: string;
  timeoutSeconds: number;
  template: RecordValue;
}): Readonly<RecordValue> {
  const allowedTemplate = new Set(["message", "text", "paperclip", "agentId", "deliver"]);
  if (Object.keys(input.template).some((key) => !allowedTemplate.has(key)) ||
      (Object.hasOwn(input.template, "deliver") && input.template.deliver !== false) ||
      (Object.hasOwn(input.template, "agentId") && input.template.agentId !== input.identity.openclawAgentId) ||
      !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 120) {
    throw new TrustedBoundaryError("openclaw_boundary_params_invalid");
  }
  return Object.freeze({
    agentId: input.identity.openclawAgentId,
    message: input.message,
    sessionKey: `agent:${input.identity.openclawAgentId}:paperclip:company:${input.identity.companyId}:run:${input.identity.runId}`,
    idempotencyKey: input.identity.runId,
    timeout: input.timeoutSeconds,
    deliver: false,
  });
}

type BoundaryInput = {
  identity: BoundaryIdentity;
  params: Readonly<RecordValue>;
  onEvent: (frame: BoundaryEvent) => void | Promise<void>;
};

export async function createTrustedBoundaryClient(input: BoundaryInput) {
  const entry = await loadEntry(input.identity);
  return new TrustedBoundaryClient(input, entry);
}

class TrustedBoundaryClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly paramsJson: string;
  private readonly paramsSha256: string;
  private readonly nonce = crypto.randomBytes(32).toString("hex");
  private readonly ready = deferred<Ready>();
  private readonly accepted = deferred<RecordValue>();
  private readonly result = deferred<RecordValue>();
  private proof: Ready | null = null;
  private terminal: RecordValue | null = null;
  private failure: TrustedBoundaryError | null = null;
  private dispatched = false;
  private connected = false;
  private waitStarted = false;
  private cleanExit = false;
  private gatewayRunId: string | null = null;
  private startedAt = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private inputBuffer = "";
  private streamBytes = 0;
  private events: BoundaryEvent[] = [];
  private eventChain: Promise<void> = Promise.resolve();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly input: BoundaryInput, private readonly entry: BoundaryEntry) {
    this.paramsJson = JSON.stringify(input.params);
    this.paramsSha256 = crypto.createHash("sha256").update(this.paramsJson, "utf8").digest("hex");
    const params = record(parseBoundaryJson(this.paramsJson));
    keys(params, ["agentId", "message", "sessionKey", "idempotencyKey", "timeout"], ["deliver"]);
    if (params.agentId !== input.identity.openclawAgentId ||
        params.idempotencyKey !== input.identity.runId ||
        params.sessionKey !== `agent:${input.identity.openclawAgentId}:paperclip:company:${input.identity.companyId}:run:${input.identity.runId}` ||
        typeof params.message !== "string" || !params.message.trim() ||
        !Number.isInteger(params.timeout) || Number(params.timeout) < 1 ||
        Number(params.timeout) > 120 || Number(params.timeout) * 1000 > entry.maxDurationMs ||
        (Object.hasOwn(params, "deliver") && params.deliver !== false)) {
      throw new TrustedBoundaryError("openclaw_boundary_params_invalid");
    }
  }

  async connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<Ready> {
    if (this.connected) throw new TrustedBoundaryError("openclaw_boundary_protocol_invalid");
    this.connected = true;
    this.startedAt = Date.now();
    const openFrame = { v: 1, type: "open", id: "open-1", mode: "execute",
      ...this.input.identity, nonce: this.nonce, paramsJson: this.paramsJson, paramsSha256: this.paramsSha256 };
    const wire = this.encode(openFrame);
    const { ssh } = this.entry;
    this.child = spawn("/usr/bin/ssh", [
      "-F", "/dev/null", "-T",
      "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${ssh.knownHostsFile}`,
      "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UpdateHostKeys=no",
      "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
      "-o", "PermitLocalCommand=no", "-o", "ProxyCommand=none", "-o", "ProxyJump=none",
      "-o", "IdentityAgent=none", "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no", "-o", "ConnectionAttempts=1",
      "-o", "ConnectTimeout=15", "-i", ssh.identityFile, "-p", String(ssh.port),
      `${ssh.user}@${ssh.host}`,
    ], { shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    // SSH diagnostics can contain private host/key paths. Never log them.
    this.child.stderr.on("data", () => {});
    this.child.on("error", () => this.fail("openclaw_boundary_transport_failed"));
    this.child.stdin.on("error", () => this.fail("openclaw_boundary_transport_failed"));
    this.child.on("close", (code) => {
      try { this.inputBuffer += this.decoder.decode(); }
      catch { this.fail("openclaw_boundary_protocol_invalid"); }
      if (!this.failure && code === 0 && this.terminal && !this.inputBuffer) {
        this.cleanExit = true;
        this.finalizeResult();
      } else if (!this.failure) this.fail("openclaw_boundary_transport_closed");
    });
    this.timers.push(setTimeout(() => {
      if (!this.proof) this.fail("openclaw_boundary_connect_timeout");
    }, Math.min(CONNECT_TIMEOUT_MS, Math.max(1, timeoutMs))));
    this.timers.push(setTimeout(() => this.fail("openclaw_boundary_deadline"), this.entry.maxDurationMs));
    this.resetIdle();
    this.child.stdin.write(wire);
    const proof = await this.ready.promise;
    if (this.failure) throw this.failure;
    return proof;
  }

  async request<T = RecordValue>(method: string, params: unknown, _options?: unknown): Promise<T> {
    if (this.failure) throw this.failure;
    if (method === "agent") {
      if (!this.proof || this.dispatched || JSON.stringify(params) !== this.paramsJson ||
          Date.parse(this.proof.expiresAt) <= Date.now()) {
        throw new TrustedBoundaryError("openclaw_boundary_dispatch_rejected", this.dispatched, this.dispatched);
      }
      this.dispatched = true;
      this.write({ v: 1, type: "dispatch", id: "dispatch-1",
        leaseId: this.proof.leaseId, paramsSha256: this.paramsSha256 });
      return this.accepted.promise as Promise<T>;
    }
    if (method === "agent.wait" && this.dispatched && this.gatewayRunId &&
        record(params).runId === this.gatewayRunId && !this.waitStarted) {
      this.waitStarted = true;
      for (const event of this.events) this.deliver(event);
      this.events = [];
      this.finalizeResult();
      return this.result.promise as Promise<T>;
    }
    throw new TrustedBoundaryError("openclaw_boundary_rpc_forbidden", this.dispatched, this.dispatched);
  }

  close() {
    this.clearTimers();
    if (this.child && this.child.exitCode === null) {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
      const child = this.child;
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000);
      timer.unref();
    }
  }

  private encode(frame: unknown): string {
    const wire = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(wire, "utf8") > MAX_FRAME_BYTES) throw new TrustedBoundaryError("openclaw_boundary_frame_too_large");
    return wire;
  }
  private write(frame: unknown) {
    if (!this.child || this.failure) throw this.failure ?? new TrustedBoundaryError("openclaw_boundary_transport_failed");
    this.child.stdin.write(this.encode(frame));
  }
  private resetIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // Native computation can be silent. After accepted, only the private hard
    // deadline bounds the run; lack of model events is not transport failure.
    if (this.gatewayRunId) return;
    this.idleTimer = setTimeout(() => this.fail("openclaw_boundary_idle_timeout"), IDLE_TIMEOUT_MS);
  }
  private clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }
  private fail(code: string) {
    if (this.failure) return;
    this.failure = new TrustedBoundaryError(code, this.dispatched, this.dispatched);
    this.ready.reject(this.failure); this.accepted.reject(this.failure); this.result.reject(this.failure);
    this.close();
  }
  private receive(chunk: Buffer) {
    if (this.failure) return;
    this.streamBytes += chunk.byteLength;
    if (this.streamBytes > MAX_STREAM_BYTES) return this.fail("openclaw_boundary_stream_too_large");
    try { this.inputBuffer += this.decoder.decode(chunk, { stream: true }); }
    catch { return this.fail("openclaw_boundary_protocol_invalid"); }
    while (this.inputBuffer.includes("\n")) {
      const newline = this.inputBuffer.indexOf("\n");
      const line = this.inputBuffer.slice(0, newline);
      this.inputBuffer = this.inputBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") + 1 > MAX_FRAME_BYTES) return this.fail("openclaw_boundary_frame_too_large");
      try { this.frame(record(parseBoundaryJson(line))); this.resetIdle(); }
      catch { return this.fail("openclaw_boundary_protocol_invalid"); }
      if (this.failure) return;
    }
    if (Buffer.byteLength(this.inputBuffer, "utf8") >= MAX_FRAME_BYTES) this.fail("openclaw_boundary_frame_too_large");
  }
  private frame(frame: RecordValue) {
    if (frame.v !== 1 || this.terminal) throw new Error("frame_order");
    if (frame.type === "error") {
      keys(frame, ["v", "type", "code", "dispatched", "indeterminate"], ["id"]);
      text(frame.code, /^[a-z][a-z0-9_]{1,100}$/);
      if (typeof frame.dispatched !== "boolean" || typeof frame.indeterminate !== "boolean") throw new Error("error_shape");
      // Codes are not copied from the remote host into logs or results.
      this.fail("openclaw_boundary_broker_rejected"); return;
    }
    if (frame.type === "ready") {
      keys(frame, ["v", "type", "id", ...Object.keys(this.input.identity), "nonce", "paramsSha256",
        "leaseId", "containerId", "imageId", "configSha256", "soulSha256", "stateSha256", "issuedAt", "expiresAt"]);
      if (this.proof || this.dispatched || frame.id !== "open-1" ||
          frame.nonce !== this.nonce || frame.paramsSha256 !== this.paramsSha256) throw new Error("ready_binding");
      for (const [key, value] of Object.entries(this.input.identity)) if (frame[key] !== value) throw new Error("ready_identity");
      for (const key of ["containerId", "imageId", "configSha256", "soulSha256"] as const) {
        if (frame[key] !== this.entry[key]) throw new Error("ready_runtime");
      }
      text(frame.stateSha256, SHA256);
      text(frame.leaseId, /^[A-Za-z0-9_-]{16,128}$/);
      const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/;
      const issued = Date.parse(text(frame.issuedAt, utc)), expires = Date.parse(text(frame.expiresAt, utc));
      const now = Date.now();
      if (!Number.isFinite(issued) || !Number.isFinite(expires) ||
          issued < this.startedAt - CLOCK_SKEW_MS || issued > now + CLOCK_SKEW_MS ||
          expires <= now || expires <= issued || expires - issued > this.entry.maxDurationMs) throw new Error("ready_expired");
      this.proof = frame as unknown as Ready;
      this.ready.resolve(this.proof); return;
    }
    if (frame.type === "accepted") {
      keys(frame, ["v", "type", "id", "runId", "gatewayRunId", "payload"]);
      if (!this.dispatched || this.gatewayRunId || frame.id !== "dispatch-1" ||
          frame.runId !== this.input.identity.runId) throw new Error("accepted_binding");
      this.gatewayRunId = text(frame.gatewayRunId, ID);
      const payload = record(frame.payload);
      if (payload.runId !== this.gatewayRunId) throw new Error("accepted_payload_binding");
      // The broker owns agent.wait even for an immediately completed ACK.
      this.accepted.resolve({ ...payload, runId: this.gatewayRunId, status: "accepted" }); return;
    }
    if (frame.type === "event") {
      keys(frame, ["v", "type", "frame"]);
      const event = record(frame.frame);
      if (!this.gatewayRunId || event.type !== "event" || !["agent", "chat"].includes(String(event.event)) ||
          record(event.payload).runId !== this.gatewayRunId) throw new Error("event_binding");
      if (this.waitStarted) this.deliver(event as BoundaryEvent);
      else this.events.push(event as BoundaryEvent);
      return;
    }
    if (frame.type === "result") {
      keys(frame, ["v", "type", "id", "runId", "gatewayRunId", "status", "payload"]);
      if (!this.gatewayRunId || frame.id !== "dispatch-1" || frame.runId !== this.input.identity.runId ||
          frame.gatewayRunId !== this.gatewayRunId || !["ok", "error", "timeout"].includes(String(frame.status))) throw new Error("result_binding");
      const payload = record(frame.payload);
      if ((payload.runId !== undefined && payload.runId !== this.gatewayRunId) ||
          (payload.status !== undefined && payload.status !== frame.status)) throw new Error("result_payload_binding");
      this.terminal = { ...payload, runId: this.gatewayRunId, status: frame.status, paperclipBoundary: this.proof,
        // agent.wait timeout is not a cancellation; the broker retains quarantine.
        ...(frame.status === "timeout" ? { dispatched: true, indeterminate: true } : {}) };
      this.child?.stdin.end();
      this.timers.push(setTimeout(() => {
        if (!this.cleanExit) this.fail("openclaw_boundary_shutdown_timeout");
      }, 2000));
      return;
    }
    throw new Error("unknown_frame");
  }
  private deliver(event: BoundaryEvent) {
    this.eventChain = this.eventChain.then(() => this.input.onEvent(event)).catch(() => {
      this.fail("openclaw_boundary_event_delivery_failed");
    });
  }
  private finalizeResult() {
    if (!this.cleanExit || !this.waitStarted || !this.terminal || this.failure) return;
    void this.eventChain.then(() => {
      if (!this.failure && this.terminal) { this.clearTimers(); this.result.resolve(this.terminal); }
    });
  }
}
