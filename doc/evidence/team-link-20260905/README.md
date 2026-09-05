# Paperclip trusted team link — candidate checks

The reviewed candidate is based on a21ac20a31cc3f69c38b47699bf3eade4d1d04da.
Its exact seven source hashes and review attributions are in
[candidate-checks.json](candidate-checks.json).

The adapter requires a fresh authenticated broker session bound to the server
identity, immutable request digest and pinned container/image/config/SOUL
evidence. Stock dispatch remains denied. The SSH key must be confidential and
readable by the actual service identity: a non-root service uses a private
operator-pinned GID, exact key owner/mode and verified process membership.
After acceptance, quiet native computation uses the private total deadline.
Transport loss or wait timeout does not establish cancellation and causes no
automatic replay.

Validation recorded for these source hashes:

- 162 unique adapter/regression tests passed, including six real OS key-permission
  scenarios executed as UID/GID 10001 with temporary synthetic data.
- 27 controlled gateway fixture tests passed with real embedded PostgreSQL as
  UID 10001; the existing compact receipt is linked from candidate-checks.json.
- The adapter passed typecheck/build. Global checks and exact exit codes are in
  [global-typecheck.json](global-typecheck.json) and [global-build.json](global-build.json).
  Their compact logs preserve original output line numbers.
- Independent Codex reviewer native_auth_boundary closed adapter round 2 and
  fixture round 1 with PASS. These are not Marco/Claude or CodeRabbit reviews.

The earlier [CI run 33990590162](https://github.com/Waipro-Team/paperclip/actions/runs/33990590162)
for a21 remains FAILED. Its eleven failures were the two synthetic gateways
waiting for a dispatch denied by the new stock gate. The reviewed fixture
changes admit only registered fixture instances while retaining real request
and configuration validators. Historical a21 receipts retain their state at
freeze; their pending-review wording is superseded by the attribution above.

This receipt precedes the new commit and push. It does not claim that the new
HEAD has passed CI. Query GitHub Actions by its exact committed SHA for that
result. The full root suite and Rust stress checks were not repeated in this
closure, as directed by the coordinator.

No deployment, merge, actual tenant run, SSH authentication, native model,
MCP access or Paperclip callback is attested here. Private registry/key/group
provisioning and live end-to-end evidence remain separate work.
