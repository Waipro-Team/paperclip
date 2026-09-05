# Paperclip test environment evidence — 2026-09-05

Candidate base HEAD: `706e2d42fb2f26aa73f346e23c0365950ff6d686` on `codex/portal360-reconcile-20260902`.

The root `pnpm test:run` remains **failed and incomplete**. Seven invoked groups reported 10,286 passed, 2 failed and 2,120 skipped tests (12,408 total); 1,042 files passed, 1 failed and 132 skipped (1,175 total). The only terminal failures are adapter-utils T18 and T19, both timeouts while expecting an EACCES identity latch.

These fixtures remove directory permissions with chmod 000. Root can still access those paths, so the intended EACCES condition does not occur. The same actual tests run under existing user `claw360` (UID 10001) both pass: T18 276 ms, T19 265 ms; exit 0, 3.225 seconds wall time. The other 32 tests in the file were filtered out. No adapter-utils source differs from HEAD and no source, configuration or ACL was changed for this verification.

- [Structured summary](summary.json): exact per-group counts, original log line references, failure stacks and coverage limits.
- [Compact original excerpts](global-suites-and-errors.log): seven suite summaries and the two terminal errors, with source line numbers.
- [Actual non-root run](claw360-t18-t19.log) and [reproduction command](claw360-t18-t19.json): public Vitest API with `config: false` and temporary cache. Adapter-utils has no own Vitest configuration; this selects its default project without loading unrelated workspace UI configuration. Temporary cache removed in a finally block.
- Earlier startup failures are retained separately in `workspace-config-startup.*` and `package-config-startup.*`; no tests ran during those attempts.

The original log remains on the server at `/root/work/paperclip-portal360-reconcile-20260902/doc/evidence/team-runtime-20260905/test.log` (15,487,081 bytes, 385,555 lines). Do not include that large original in Git. SHA-256: `ad12c97558fc44b07e1cfca39fd5c54472e5c2ce2f3f15fcf75291bb26ebad4b`.

The stable runner stops after adapter-utils. Later adapter projects and all 143 serialized server suites were not reached. The general-server OpenClaw adapter file did pass 9 tests; the OpenClaw package isolation/dispatch tests and issue-import route tests require their separate receipts. Rust is outside this Vitest run and has its separate 222-pass receipt. There are 110 explicit PostgreSQL root skip messages, which does not classify every skipped test. These environment-dependent failures do not establish a product regression, and the skipped/unexecuted coverage prevents declaring the global run green.
