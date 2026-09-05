# Paperclip — Rust CI repair candidate, 2026-09-05

Base: `706e2d42fb2f26aa73f346e23c0365950ff6d686`, branch
`codex/portal360-reconcile-20260902`, server candidate
`/root/work/paperclip-portal360-reconcile-20260902`.

The [CI build](https://github.com/Waipro-Team/paperclip/actions/runs/33987564083/job/101363922426)
failed in `ambiguous_replacement_turn_adopts_one_later_completion_identity`.
The failing loop originated upstream in `cf6db7b523`; the OpenClaw changes in
the base commit did not touch this Rust code.

Three separate causes were distinguished:

1. The test allowed 128 immediate polls. After channel disconnection, those
   polls may finish before the operating system exposes child exit. It now
   waits up to five seconds and yields for one millisecond on an empty poll.
2. A one-millisecond stdout timeout did not prove EOF. Codex could publish
   process exit while the reader thread still held terminal notifications.
   The new supervisor method publishes exit only after stdout is drained.
   It reaps remaining process-group members after leader exit, so inherited
   writer handles cannot park the EOF wait. A writer outside the original
   process group instead causes an explicit error when shutdown grace expires
   (two seconds in Codex), preserving a bounded fail-closed outcome.
3. The missing-identity fixture wrote completion after returning an invalid
   successful response, which correctly causes immediate process termination.
   That case now emits its completion before the invalid response, using an
   existing fixture switch. The other two cases still emit later completions.
   No assertion about identity, completion authority or exit status was removed.

Validation on the final source hashes in `summary.json`:

- Rust 1.97.1, matching the package toolchain: fmt and workspace check passed.
- Entire Rust release suite: 222 passed, zero failures or ignored tests.
- 200 repetitions, four concurrent processes pinned to CPU 0: 200 passed.
- New OS regression proves unread stdout precedes exit and inherited writer
  handles are closed without waiting for the background sleeper. A separate
  Linux regression keeps a detached setsid writer alive and verifies bounded
  failure after the configured 50 ms grace, with cleanup of the synthetic group.

The unchanged baseline initially used host stable Rust 1.98.0: 200/200 serial
passes, 73/200 contention failures. Subsequent comparisons all used Rust 1.97.1.
The intermediate failures are retained explicitly; they are not final results.
See `summary.json` and the selected failure logs.

Reproduce the normal checks from `packages/paperclip-runner`:

```sh
/root/.cargo/bin/cargo fmt --manifest-path runner/Cargo.toml --all -- --check
/root/.cargo/bin/cargo check --manifest-path runner/Cargo.toml --locked --workspace
/root/.cargo/bin/cargo test --release --manifest-path runner/Cargo.toml --locked --workspace
```

For the contention check, pass the compiled `codex_provider` executable to
`stress.py` from this directory. The executable path is printed by the cargo
test command. The helper runs only the synthetic integration test, bounds every
invocation to twenty seconds, and removes its own temporary fixture directory.

The first independent Codex review reproduced the detached-writer hang.
The deadline fix and its regression passed the second and final independent
Codex review, which repeated 65/65 targeted tests and reported no remaining
blocking findings. Reviewer: the distinct Codex agent import_client. This is
separate from Marco/Claude and CodeRabbit review. This receipt is a source candidate: no commit, remote CI
rerun, deployment or operational-agent activation is attested here.
