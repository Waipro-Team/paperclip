# Paperclip intake preflight — 6 September 2026

Candidate on base `9ac50ed69eaf90dd3358e57aeaf4c61d63c294f8`; no commit,
push, deployment, migration, restart or live credential use by this writer.
The UTC test timestamp is 5 September, corresponding to 6 September in Europe/Rome.

`POST /api/companies/:companyId/regia/intake/preflight` accepts only
`{ binding }`, using the same strict binding schema as intake creation.
The response includes schemaVersion 1, capability `regia_intake_preflight_v1`,
companyId, the complete normalized binding, and the actual authenticated
board principal: userId, source, companyIds, isInstanceAdmin.
The secret version remains the requested selector (`latest` by default or an
explicit positive integer). No resolved value or version payload is returned.
Missing users and the synthetic fallback `board` are rejected on both paths.

The route uses the same POST board/company membership permissions as intake,
including viewer denial. It does not rewrite a session or a broad admin into
a limited board key. A Portal receiver must independently require its expected
userId, source `board_key`, exactly its one company and isInstanceAdmin false.

The service checks the binding in a PostgreSQL REPEATABLE READ READ ONLY
transaction. The common helper validates the canonical, invokable Regia root,
company project/workspace, active environment pinned to project and agent,
and exact company secret/environment binding and usable version metadata.
The version resolver now selects explicit metadata columns and retains its
binding and class-3 lease checks. It does not select encrypted material,
decrypt, invoke a provider or write secret access audit entries.

The response always reports executionAuthorized false and intakeAvailable true.
This means admission for a governed, blocked intake. It does not attest an
execution sandbox, external boundary, provider authentication or callback.
The existing execution binding and approval gates remain separate.
Creation revalidates the current binding; a successful preflight is not cached
authorization. Already-created intake replays retain their existing idempotent
receipt semantics and do not create or dispatch a new run.

Zero mutations refers to this preflight service and domain state (tasks,
goals, approvals, receipts, issue counters, project links, wakes, leases,
secret access events and resolution timestamps). Normal authentication may
update the board API key's last-used timestamp before the service; that is
not part of the read-only claim.

## Evidence

- [Candidate and nine source/test hashes](paperclip-preflight-candidate.json).
- [Targeted command and timing](paperclip-preflight-tests.json).
- [Sanitized test outcomes](paperclip-preflight-tests.log).

146 unique tests passed with no skips under claw360 UID 10001:
81 secret-service, 36 intake service with real disposable PostgreSQL,
21 route, 5 OpenAPI and 3 existing authentication/presence tests.
The initial 60-case run is a subset and is not added to this total.
There are 40 new cases across the intake service and route suites.
Server `tsc --noEmit`, shared package typecheck and `git diff --check` passed.

The database evidence includes a real role that lacks SELECT permission on
secret material and provider metadata. Preflight succeeds with that role;
an explicit SELECT of material is independently denied. Actual transaction
settings are repeatable read/read only. A separate connection changes a
binding during a snapshot: preflight sees the coherent old snapshot, while
a later intake and later preflight reject the changed current binding.
Eighteen mismatch cases preserve domain snapshots, including tenant,
project/workspace, root/catalog, paused agent, environment, secret and
version failures. A valid preflight followed by intake remains blocked on
the native approval gate, without wakes or leases.

The independent Python receiver → authenticated HTTP → PostgreSQL interop
fixture and its evidence are owned by paperclip_ci and reported separately.
Native_auth_boundary was asked for the distinct first Codex review of this
increment; this author receipt does not assert that review's verdict.

Full repository CI, global build and global typecheck for this increment
remain assigned to the parent after review and commit. The earlier 9ac50ed
CI successes apply to the base only. No live Paperclip intake or Telegram
polling/execution is attested by these tests.
