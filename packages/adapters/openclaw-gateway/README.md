# OpenClaw Gateway Adapter

This document describes how `@paperclipai/adapter-openclaw-gateway` invokes OpenClaw over the Gateway protocol.

## Transport

Without a `boundaryId`, the adapter uses the stock WebSocket gateway transport.
The trusted boundary transport is described separately below.

- URL must be `ws://` or `wss://`
- Connect flow follows gateway protocol:
1. receive `connect.challenge`
2. send `req connect` (protocol/client/auth/device payload)
3. read `config.get` and check request and execution isolation
4. only after execution authorization, send `req agent`
5. wait for completion via `req agent.wait` and stream `event agent` frames

**Stock deployment gate:** stock OpenClaw 2026.7.1-2 cannot provide the
execution proof needed by step 3. This candidate refuses every unverified
`agent` dispatch, including configurations that appear to use embedded models.
The environment test also fails with the specific isolation error. This is a
containment fix; it does not make the team runnable.

## Stock Gateway Auth Modes

Gateway credentials can be provided in any of these ways:

- `authToken` / `token` in adapter config (recommended; persisted as a secret reference)
- `headers.x-openclaw-token` (legacy input; migrated to `authToken` before persistence)
- `headers.x-openclaw-auth` (legacy input; migrated to `authToken` before persistence)
- `password` (shared password mode)

When a token is present and `authorization` header is missing, the adapter derives `Authorization: Bearer <token>`.

## Stock Gateway Device Auth

By default the adapter sends a signed `device` payload in `connect` params.

- set `disableDeviceAuth=true` to omit device signing
- set `devicePrivateKeyPem` to pin a stable signing key
- without `devicePrivateKeyPem`, the adapter generates an ephemeral Ed25519 keypair per run
- when `autoPairOnFirstConnect` is enabled (default), the adapter handles one initial `pairing required` by calling `device.pair.list` + `device.pair.approve` over shared auth, then retries once.

## Stock Gateway Session Strategy

The adapter supports the same session routing model as HTTP OpenClaw mode:

- `sessionKeyStrategy=issue|fixed|run`
- `sessionKey` is used when strategy is `fixed`

The resolved key must be explicitly routed to the configured agent and is
sent as `agent.sessionKey`. A fixed key routed to another agent is rejected
before transport. A matching key alone cannot prove stored session isolation.

## Stock Gateway Payload Mapping

The agent request is built as:

- required fields:
  - `message` (wake text plus optional `payloadTemplate.message`/`payloadTemplate.text` prefix)
  - `idempotencyKey` (Paperclip `runId`)
  - `sessionKey` (resolved strategy)
- required `agentId` comes from top-level config; a conflicting template is rejected
- template fields are merged before validation; adapter-owned `agentId`,
  `sessionKey`, `message`, and `idempotencyKey` cannot be overridden
- request selectors `provider`, `model`, `sessionId`, `runtime`, `agentRuntime`,
  `agentHarnessRuntime`, `sessionEffects`, `modelRun`, `promptMode`, and `cwd`
  are rejected by presence, even if empty or null, before opening a WebSocket

## Stock Gateway Timeouts

- `timeoutSec` controls adapter-level request budget
- `waitTimeoutMs` controls `agent.wait.timeoutMs`

If `agent.wait` returns `timeout`, adapter returns `openclaw_gateway_wait_timeout`.

## Log Format

Structured gateway event logs use:

- `[openclaw-gateway] ...` for lifecycle/system logs
- `[openclaw-gateway:event] run=<id> stream=<stream> data=<json>` for `event agent` frames

UI/CLI parsers consume these lines to render transcript updates.

## No-remote-git contract

Like every Paperclip adapter, this one must treat the local execution-workspace
cwd as the only persistence boundary across runs — no `git push` from runtime
code, no assuming a `git remote` exists. The gateway transport here doesn't
touch the workspace directly, but if you extend the adapter to ship code to
the OpenClaw side, use the round-trip helpers in `@paperclipai/adapter-utils`
(`prepareWorkspaceForSshExecution` → `restoreWorkspaceFromSshExecution`)
rather than reaching for a git remote. See
[`packages/adapters/AUTHORING.md`](../AUTHORING.md#no-remote-git-contract-cross-run-persistence)
for the full contract and the pinning test at
[`packages/adapter-utils/src/ssh-fixture.test.ts`](../../adapter-utils/src/ssh-fixture.test.ts).

## CLI process isolation gate

The adapter rejects the built-in `claude-cli` and `google-gemini-cli`
providers and any provider declared in `agents.defaults.cliBackends` when
selected by the agent's effective primary or fallback models. Model aliases
from `agents.defaults.models` are also checked. Explicit per-agent primary
models clear inherited fallbacks unless that model supplies its own fallback
list, matching the inspected OpenClaw runtime.

Setting `sandbox.mode=all` does not establish isolation of a native CLI process
or its native tools. There is no override flag: the stock gateway path cannot admit native harnesses from configuration alone.
Only the separately authenticated trusted boundary path can admit a pinned route.
The error is `openclaw_gateway_cli_process_isolation_unverified`.

The configuration check is only a necessary precondition. The final execution
gate returns `openclaw_gateway_execution_isolation_unverified` when that check
passes: runtime-only plugins and persisted session model/harness overrides
remain unverified. Request overrides fail earlier with
`openclaw_gateway_request_route_unverified`; cross-agent resolved keys return
`openclaw_gateway_session_agent_mismatch`. No denial calls `onDispatch` or sends
`agent`. Snapshot contents are never logged or included in results.

There is no caller-configurable override or accepted self-reported attestation.
Stock admission would need a trusted tenant boundary covering the gateway, CLI,
MCP processes, mounts, credentials and network, bound to the selected endpoint
and request, or a gateway-enforced atomic execution contract. Reading session
metadata and then dispatching would still allow a concurrent route change.
A runtime version, an empty plugin list or `plugins.enabled=false` in a file
snapshot cannot substitute for that contract.

### Inspected runtime and repeatable evidence

Read-only inspection on Agency on 2026-09-05 used the installed OpenClaw
`2026.7.1-2` under `/usr/local/lib/node_modules/openclaw`:

- `dist/config-DQFoEP4y.js:551`: `config.get` calls
  `readConfigFileSnapshot()`; it does not bind a route to an invocation.
- `dist/redact-snapshot-C_BFfSrJ.js:267`: `runtimeConfig` in the reply is a
  redacted alias of the file snapshot's config; plugin metadata is omitted.
- `dist/model-selection-cli-BxYQ8SKm.js:49` and
  `dist/cli-backends-blVNpctb.js:172`: CLI selection includes runtime and setup
  plugin registries, beyond `agents.defaults.cliBackends`.
- `dist/agent-D6kiZtPt.js:909`: authorized callers may set request provider/model;
  session IDs are independently resolved at line 1094.
- `dist/thinking-runtime-rftFo2fO.js:55`: stored session runtime overrides
  precede configured policy; automatic selection consults registered harnesses.
- `dist/sessions-UcKjjh_n.js:1656`: `sessions.get` returns messages, not an
  execution authorization. `sessions.resolve` only resolves an identity.

Source SHA-256 for the two core observations:
`config-DQFoEP4y.js` =
`074c4e6adf00b4b4fac3129b1e5ef7f12d08034a232359946f2ea3e3b4e0739c`;
`model-selection-cli-BxYQ8SKm.js` =
`fa8c758eeea3a06889f175d7d7770e8dd763dbed597157ceb69f4c59233a3356`.

From the repository root, repeat the synthetic checks with:

```sh
pnpm exec vitest run packages/adapters/openclaw-gateway/src/server packages/adapters/openclaw-gateway/src/ui/build-config.test.ts
pnpm --filter @paperclipai/adapter-openclaw-gateway typecheck
pnpm --filter @paperclipai/adapter-openclaw-gateway build
git diff --check
```

The three transport lifecycle tests explicitly stub authorization to exercise
post-admission ordering/retry semantics. The real-gate tests never stub it:
they cover payload overrides, cross-agent keys, all session strategies,
configuration-only environment probes, and absence of secret snapshot logging.
These tests do not attest live process containment, authentication or E2E work.

## Trusted boundary transport

Setting `boundaryId` selects an operator-provisioned boundary. It grants no
capability by itself. The adapter loads only the fixed server-private file
`/etc/paperclip/openclaw-boundaries.json`, with this schema:

```json
{
  "v": 1,
  "boundaries": {
    "<boundaryId>": {
      "companyId": "<Paperclip company UUID>",
      "paperclipAgentId": "<Paperclip agent UUID>",
      "openclawAgentId": "<OpenClaw agent ID>",
      "ssh": {
        "host": "<pinned SSH host>",
        "port": 22,
        "user": "<dedicated forced-command user>",
        "identityFile": "/etc/paperclip/keys/<dedicated identity>",
        "knownHostsFile": "/etc/paperclip/keys/known_hosts"
      },
      "containerId": "<64 hexadecimal characters>",
      "imageId": "sha256:<64 hexadecimal characters>",
      "configSha256": "<64 hexadecimal characters>",
      "soulSha256": "<64 hexadecimal characters>",
      "maxDurationMs": 180000
    }
  }
}
```

All files and their ancestors must be root-owned, without symlinks or
group/world writes. For a non-root Paperclip process, the private registry may
set optional integer `ssh.identityFileGroupId`: the key must then be owned by
root and that exact GID, with mode 0440 or 0640, and the effective service
process must belong to that group. The operator must provision a private
service group; a group shared with other tenants or unrelated users is not
suitable. Without that field, only root-owned mode 0400 or 0600 with effective
process UID 0 is supported. No other permission or special bits are allowed.
The operator must also make the registry readable and path ancestors traversable
by the service while preserving root ownership and no group/other writes.
This contract does not require running Paperclip as root. Registry and key paths come from the operator, never from
adapter config. The adapter reads registry contents only; SSH reads the dedicated
identity file. SSH uses strict host-key verification, an empty SSH config, no
remote command, no forwarding, no agent, no proxy and a fixed environment.
The host must enforce a boundary-specific forced command on that identity.

The server-derived company, Paperclip agent and run IDs must match the private
entry. The bound route ignores user gateway URL/auth and uses a fresh SSH
channel to the broker. The broker must verify the complete tenant container,
native CLI/MCP processes, credentials, mounts and network policy. These checks
are operator-controlled expectations; gateway `config.get` is not a proof.

Before dispatch, JSONL wire v1 binds a random nonce, the exact UTF-8 bytes of
`paramsJson`, their SHA-256, the complete execution identity and the pinned
container/image/config/SOUL hashes to a fresh lease. The client validates those
bindings and lease times on the authenticated channel. It then sends one
`dispatch` for the stored digest, after Paperclip's `onDispatch`; the broker
owns the gateway handshake, credentials, single `agent` request and
`agent.wait`. No arbitrary RPC or reconnect is exposed. The accepted gateway
run ID filters all events and results. Result receipts preserve the validated
proof as `paperclipBoundary`.

The bound payload allows only `agentId`, `message`, `sessionKey`,
`idempotencyKey`, `timeout` and `deliver:false`. It always creates
`agent:<agentId>:paperclip:company:<companyId>:run:<runId>`, regardless of
the fixed/issue session setting. Payload-template route selectors, unknown
fields and timeout overrides fail before transport. A private entry may
explicitly select the default agent or a native CLI provider inside the
verified container.

OpenClaw `agent.timeout` is **seconds**, bounded to 1–120; zero is rejected.
Read-only inspection of installed 2026.7.1-2 found `overrideSeconds` in
`dist/agent-D6kiZtPt.js` and multiplication by 1000 in
`dist/timeout-0Cw4kcol.js`. Broker connection is capped at 15 seconds, frame
idle before acceptance at 30 seconds, total duration at 180 seconds (or a
smaller private limit). After acceptance, silent computation is bounded by the
private total deadline, not by event frequency. Limits also cap
each UTF-8 frame at 1 MiB and the stream at 16 MiB. Success requires a terminal
result followed by clean SSH exit within two seconds. Invalid UTF-8, malformed
or duplicate JSON keys, stale/replayed proofs, wrong identity, EOF, errors and
deadline expiry fail closed.

After dispatch, transport loss and wait timeout are indeterminate: closing SSH
does not cancel a native model process. The host broker must retain durable
quarantine and reject subsequent runs until operator recovery establishes a
safe state. The adapter performs no automatic replay. The environment-test
context lacks the server-derived Paperclip agent identity, so a boundary probe
returns `openclaw_boundary_execution_identity_required`; it is not a readiness
attestation.

This candidate includes protocol, registry and adapter integration tests using
synthetic SSH/registry fixtures. They establish client admission and replay
behavior, not real host containment, pairing, credentials, model execution or
end-to-end readiness. Operator deployment and an actual bound run require
separate evidence.
