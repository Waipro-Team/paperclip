import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agentApiKeys, agentWakeupRequests, agents, approvals, authUsers,
  boardApiKeys, builtInManagedResources, companies, companyMemberships,
  companySecretBindings, companySecrets, companySecretVersions, createDb,
  environments, environmentLeases, goals, heartbeatRuns, issues, projectWorkspaces, projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Explicit cross-repository test: absent checkout is a visible skip. When opted
// in, unsupported/root PostgreSQL hosts fail instead of turning green via skip.
const portalRoot = process.env.PAPERCLIP_PORTAL_RECEIVER_ROOT;
const describeWire = portalRoot ? describe : describe.skip;
if (!portalRoot) console.warn("Telegram Python wire requires PAPERCLIP_PORTAL_RECEIVER_ROOT; not run.");
const COMPANY = "11111111-1111-4111-8111-111111111111";
const FOREIGN_COMPANY = "22222222-2222-4222-8222-222222222222";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const WORKSPACE = "66666666-6666-4666-8666-666666666666";
const SECRET = "77777777-7777-4777-8777-777777777777";
const FOREIGN_AGENT = "88888888-8888-4888-8888-888888888888";
const BOARD_USER = "synthetic-telegram-wire-board";
const PREFLIGHT = "/api/companies/" + COMPANY + "/regia/intake/preflight";
const SESSION = "/api/auth/get-session";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// Real Portal source and urllib; only synthetic credential resolution, Telegram,
// and the fixture port are replaced. The backend/auth/service/DB have no mocks.
const PYTHON_RECEIVER = String.raw`
import contextlib, copy, io, json, socket, sys, tempfile
from pathlib import Path
from urllib.parse import urlsplit
value = json.load(sys.stdin)
sys.path.insert(0, value["portalRoot"])
from services import fabry_telegram_receiver as receiver
target = urlsplit(value["fixtureBase"])
assert target.scheme == "http" and target.hostname == "127.0.0.1"
assert target.port and target.port != 3100 and target.path == ""
calls = {"telegram": [], "journal": 0, "poll": 0}
real_connect = socket.socket.connect
def fixture_connect(self, address):
    assert address == ("127.0.0.1", target.port), "non_fixture_socket_denied"
    return real_connect(self, address)
socket.socket.connect = fixture_connect
real_init = receiver.HttpClients.__init__
def fixture_init(self, config, secret):
    assert config.paperclip_base == "http://127.0.0.1:3100"
    real_init(self, config, secret)
    self.config = copy.copy(config)
    object.__setattr__(self.config, "paperclip_base", value["fixtureBase"])
receiver.HttpClients.__init__ = fixture_init
def synthetic_secret(ref):
    return {"systemd:owners": "[[101,101]]",
            "systemd:paperclip-token": value["token"],
            "systemd:telegram-token": "123456:SYNTHETIC_ONLY"}[ref]
receiver.systemd_secret = synthetic_secret
def telegram(self, method, body):
    calls["telegram"].append(method)
    assert method == "getMe", "telegram_poll_or_send_forbidden"
    return {"is_bot": True, "username": "Synthetic_Wire_bot"}
receiver.HttpClients.telegram = telegram
def journal_forbidden(*args, **kwargs):
    calls["journal"] += 1
    raise AssertionError("preflight_must_not_open_journal")
receiver.Journal = journal_forbidden
def poll_forbidden(*args, **kwargs):
    calls["poll"] += 1
    raise AssertionError("preflight_must_not_poll")
receiver.Receiver.poll_once = poll_forbidden
with tempfile.TemporaryDirectory(prefix="paperclip-telegram-wire-") as directory:
    config = value["config"]
    config["state_directory"] = str(Path(directory) / "state-never-created")
    path = Path(directory) / "synthetic-config.json"
    path.write_text(json.dumps(config))
    path.chmod(0o600)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        result = receiver.main(["--config", str(path), "--preflight-only"])
    transcript = output.getvalue()
    assert value["token"] not in transcript
    print(json.dumps({"exit": result, "output": transcript.strip(), "calls": calls,
                      "stateCreated": Path(config["state_directory"]).exists(),
                      "productionBase": receiver.ReceiverConfig.__dataclass_fields__["paperclip_base"].default}))
`;

type WireResult = {
  exit: number; output: string;
  calls: { telegram: string[]; journal: number; poll: number };
  stateCreated: boolean; productionBase: string;
};
type Trace = { method: string; path: string; status: number };

async function pythonReceiver(input: Record<string, unknown>): Promise<WireResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-I", "-B", "-c", PYTHON_RECEIVER], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("Python wire harness failed (exit " + code + ", stderr present: " + Boolean(stderr) + ")"));
        return;
      }
      try { resolve(JSON.parse(stdout) as WireResult); } catch { reject(new Error("Python wire result invalid")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

describeWire("Portal Python receiver → authenticated Express API → real PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let boardToken: string;
  let agentToken: string;
  let boardKeyId: string;
  let mountApp: (oldEndpoint?: boolean) => express.Express;

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error("Real PostgreSQL wire test unavailable: " + support.reason);
    if (process.getuid?.() === 0) throw new Error("Run the wire test as an unprivileged PostgreSQL user");
    const [{ actorMiddleware }, { authRoutes }, { regiaIntakeRoutes }, { boardMutationGuard }, { errorHandler }] =
      await Promise.all([
        import("../middleware/auth.js"), import("../routes/auth.js"), import("../routes/regia-intake.js"),
        import("../middleware/board-mutation-guard.js"), import("../middleware/error-handler.js"),
      ]);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-telegram-wire-");
    db = createDb(tempDb.connectionString);
    mountApp = (oldEndpoint = false) => {
      const app = express();
      app.use(express.json());
      app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
      app.use("/api/auth", authRoutes(db));
      app.use("/api", boardMutationGuard());
      if (oldEndpoint) app.post(PREFLIGHT, (_req, res) => { res.sendStatus(404); });
      app.use("/api", regiaIntakeRoutes(db));
      app.use(errorHandler);
      return app;
    };
    await db.insert(companies).values([
      { id: COMPANY, name: "Synthetic wire company", issuePrefix: "WIRE" },
      { id: FOREIGN_COMPANY, name: "Synthetic foreign company", issuePrefix: "OTHER" },
    ]);
    await db.insert(authUsers).values({
      id: BOARD_USER, name: "Synthetic Wire Board", email: "wire@example.invalid",
      createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId: COMPANY, principalType: "user", principalId: BOARD_USER,
      status: "active", membershipRole: "member",
    });
    boardToken = "pcp_board_synthetic_wire_" + randomUUID();
    agentToken = "synthetic_agent_wire_" + randomUUID();
    boardKeyId = randomUUID();
    await db.insert(boardApiKeys).values({
      id: boardKeyId, userId: BOARD_USER, name: "Synthetic wire only",
      keyHash: hash(boardToken), expiresAt: new Date(Date.now() + 300_000),
    });
    await db.insert(environments).values({
      id: ENVIRONMENT, name: "Synthetic isolated environment", driver: "sandbox", status: "active",
    });
    await db.insert(agents).values([
      { id: AGENT, companyId: COMPANY, name: "Synthetic Regia", role: "ceo", status: "idle",
        defaultEnvironmentId: ENVIRONMENT, metadata: { catalogRoleKey: "director_pmo_control_room" } },
      { id: FOREIGN_AGENT, companyId: FOREIGN_COMPANY, name: "Synthetic Foreign Regia", role: "ceo",
        status: "idle", defaultEnvironmentId: ENVIRONMENT, metadata: { catalogRoleKey: "director_pmo_control_room" } },
    ]);
    await db.insert(agentApiKeys).values({
      agentId: AGENT, companyId: COMPANY, name: "Synthetic agent only", keyHash: hash(agentToken),
      responsibleUserId: BOARD_USER,
    });
    await db.insert(projects).values({
      id: PROJECT, companyId: COMPANY, name: "Synthetic Portal", status: "in_progress",
      leadAgentId: AGENT, executionWorkspacePolicy: { environmentId: ENVIRONMENT },
    });
    await db.insert(projectWorkspaces).values({
      id: WORKSPACE, companyId: COMPANY, projectId: PROJECT, name: "canonical",
      sourceType: "git_repo", isPrimary: true,
    });
    await db.insert(companySecrets).values({
      id: SECRET, companyId: COMPANY, key: "SYNTHETIC_WIRE_CREDENTIAL", name: "Synthetic metadata only", status: "active",
    });
    await db.insert(companySecretVersions).values({
      secretId: SECRET, version: 1, material: { encrypted: "synthetic-never-decrypted" },
      valueSha256: "a".repeat(64), fingerprintSha256: "b".repeat(64), status: "current",
    });
    await db.insert(companySecretBindings).values({
      companyId: COMPANY, secretId: SECRET, targetType: "environment", targetId: ENVIRONMENT,
      configPath: "credentials.regia", versionSelector: "latest", required: true,
    });
    await db.insert(builtInManagedResources).values({
      companyId: COMPANY, bundleKey: "synthetic-wire", resourceKind: "environment",
      resourceKey: "synthetic-sandbox", resourceId: ENVIRONMENT, stockVersion: "1",
      stockHash: "synthetic-only", defaultsJson: {},
    });
  }, 90_000);

  afterAll(async () => { await tempDb?.cleanup(); });

  async function domainCounts() {
    return Object.fromEntries(await Promise.all(Object.entries({
      issues, goals, approvals, receipts: activityLog, wakes: agentWakeupRequests,
      leases: environmentLeases, runs: heartbeatRuns,
    }).map(async ([name, table]) => {
      const [row] = await db.select({ count: count() }).from(table);
      return [name, row!.count];
    })));
  }

  async function runCase(options: {
    oldEndpoint?: boolean; agentCredential?: boolean; foreignCompany?: boolean;
    foreignAgent?: boolean; wrongExpectedUser?: boolean;
  } = {}) {
    const before = await domainCounts();
    expect(Object.values(before)).toEqual(Array(7).fill(0));
    const trace: Trace[] = [];
    const app = express();
    app.use((req, res, next) => {
      const method = req.method;
      const path = req.originalUrl;
      res.on("finish", () => trace.push({ method, path, status: res.statusCode }));
      next();
    });
    // The old version has a real session API but no preflight route.
    app.use(mountApp(options.oldEndpoint));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string" || address.port === 3100) throw new Error("Non-fixture HTTP listener");
      const result = await pythonReceiver({
        portalRoot, fixtureBase: "http://127.0.0.1:" + address.port,
        token: options.agentCredential ? agentToken : boardToken,
        config: {
          schema_version: 1,
          expected_board_user_id: options.wrongExpectedUser ? "synthetic-other-user" : BOARD_USER,
          expected_bot_username: "Synthetic_Wire_bot",
          telegram_token_ref: "systemd:telegram-token", paperclip_token_ref: "systemd:paperclip-token",
          paperclip_base: "http://127.0.0.1:3100",
          binding: {
            company_id: options.foreignCompany ? FOREIGN_COMPANY : COMPANY,
            project_id: PROJECT, workspace_id: WORKSPACE,
            agent_id: options.foreignAgent ? FOREIGN_AGENT : AGENT,
            environment_id: ENVIRONMENT, credential_secret_id: SECRET,
            owner_allowlist_ref: "systemd:owners", bot_ref: "bot:synthetic-wire",
          },
        },
      });
      expect(result.calls.journal).toBe(0);
      expect(result.calls.poll).toBe(0);
      expect(result.stateCreated).toBe(false);
      expect(result.productionBase).toBe("http://127.0.0.1:3100");
      expect(trace.every((item) => item.path === SESSION || item.path.endsWith("/regia/intake/preflight"))).toBe(true);
      const after = await domainCounts();
      expect(after).toEqual(before);
      console.info("telegram_wire_observation " + JSON.stringify({
        options, runtimeUid: process.getuid?.(), trace, receiver: result, domainCounts: after,
      }));
      return { result, trace };
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  }

  it("accepts the real board-key session and pinned binding without work or polling", async () => {
    const { result, trace } = await runCase();
    expect(result.exit).toBe(0);
    expect(result.output).toBe("fabbry_preflight_ok");
    expect(result.calls.telegram).toEqual(["getMe"]);
    expect(trace).toEqual([
      { method: "GET", path: SESSION, status: 200 },
      { method: "POST", path: PREFLIGHT, status: 200 },
    ]);
    // Authentication bookkeeping writes are legitimate; domain data stays empty.
    const [key] = await db.select({ lastUsedAt: boardApiKeys.lastUsedAt }).from(boardApiKeys).where(eq(boardApiKeys.id, boardKeyId));
    expect(key!.lastUsedAt).toBeInstanceOf(Date);
  });

  it.each([
    ["old endpoint", { oldEndpoint: true }, 404],
    ["foreign tenant", { foreignCompany: true }, 403],
    ["foreign Regia binding", { foreignAgent: true }, 422],
  ] as const)("blocks %s before Telegram, journal, intake, or polling", async (_name, options, status) => {
    const { result, trace } = await runCase(options);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("fabbry_receiver_startup_blocked");
    expect(result.calls.telegram).toEqual([]);
    expect(trace[0]).toEqual({ method: "GET", path: SESSION, status: 200 });
    expect(trace).toHaveLength(2);
    expect(trace[1]!.method).toBe("POST");
    expect(trace[1]!.path).toMatch(/\/regia\/intake\/preflight$/);
    expect(trace[1]!.status).toBe(status);
    expect(trace[1]!.status).toBeLessThan(500);
  });

  it.each([
    ["agent credential", { agentCredential: true }, 401],
    ["wrong pinned board user", { wrongExpectedUser: true }, 200],
  ] as const)("blocks %s at the real session endpoint", async (_name, options, status) => {
    const { result, trace } = await runCase(options);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("fabbry_receiver_startup_blocked");
    expect(result.calls.telegram).toEqual([]);
    expect(trace).toEqual([{ method: "GET", path: SESSION, status }]);
  });
});
