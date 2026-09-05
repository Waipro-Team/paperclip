# CI a21 — controlled gateway fixtures

Base HEAD: a21ac20a31cc3f69c38b47699bf3eade4d1d04da. CI run 33990590162 failed in two test jobs: server 2/5 (10 failures, 908 passes) and serialized 3/5 (1 failure, 292 passes across the files reached). All 11 failures wait for the synthetic gateway's first agent payload.

The new stock OpenClaw execution guard deliberately rejects unverified dispatch after config.get. These two unchanged fixtures used the real adapter and therefore stopped before dispatch. This is a fixture compatibility regression caused by the intended guard, not an environment or timing diagnosis.

Only the heartbeat-comment-wake-batching and low-trust-red-team-routes test files change. Their Vitest mock admits an execution-gate result only for a random fixture ID registered during that gateway's lifetime and its exact agent ID. The original request/config validators still run. Other snapshots use the real denying gate, and production has no bypass flag. Four added controls verify lifetime, stock denial, model rejection and disabled-sandbox rejection.

Validation: 27/27 tests PASS (23 existing + 4 controls), zero skipped, with actual embedded PostgreSQL as claw360 UID 10001. The exact command uses configLoader runner and cache=false from server/. Full server typecheck PASS after adding the installed Cargo directory to the SSH PATH; the initial attempt stopped at missing cargo before tsc.

- a21-ci-diagnosis.json: cause, CI job IDs/counts, exact source hashes, local command and coverage limits.
- a21-ci-failures.log: compact exact CI failure stacks and summary lines with original job-log line numbers.
- a21-fixture-regression-tests.json and .log: local receipt and compact PASS output.
- a21-fixture-typecheck.json and .log: typecheck receipt/output.

The complete 46 KB local test output remains server-only in a21-fixture-regression-tests.raw.log. Do not add that raw file to Git. Its hash is in the receipt; it retains nonterminal synthetic adapter errors and asynchronous DB teardown warnings. Vitest reported no failed tests. Original CI logs remain retrievable by job ID and are hashed in the diagnosis.

This targeted result does not turn the earlier CI run green. Independent review of the two test changes is pending at source freeze.
