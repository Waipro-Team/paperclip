# Paperclip full-image preflight — disk gate proved

The official production build completed dependency installation, UI, plugin SDK, server and Rust runner compilation, but did **not** produce a complete image. The disk watchdog stopped the final `COPY --chown=node:node --from=build /app /app`. The image smoke was not run. This is a bounded server capacity result, not a source compilation failure or runtime readiness claim.

## Exact inputs

- Canonical server checkout: `/root/work/paperclip-portal360-reconcile-20260902`, branch `codex/portal360-reconcile-20260902`.
- Source commit: `460b8f151a1a0054bf84c54f0e60617b52fc8a47`.
- Committed root lock SHA-256: `c92dc538b4cc082d850da897049a36537cf5c070705ff13e4b8d8fbe68a2de31` (unchanged).
- Captured Docker-context lock SHA-256: `cb5329794adbf94f80f7d06d9593acd940dd7085bb053e78962780154aa97bcf`.
- Context derived from the exact git archive. The only substituted source file was `pnpm-lock.yaml`; Dockerfile and .dockerignore hashes, full regular-file tree digest, build arguments and context verification are in `build-result.json`.
- The workflow `.github/workflows/docker.yml` performs `pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile` before Docker builds (lines90 and284 at source commit). `doc/DEVELOPING.md` reserves root-lock changes for GitHub Actions. This preflight preserved the root lock and saved the derived bytes and diff. Reviewer independently verified this preprocessing before the corrected build.
- The captured lock is replayed exactly; metadata refresh is not claimed intrinsically deterministic. Official base tags and global CLI latest packages remain mutable inputs. This receipt does not claim a bit-reproducible image.

## Observed result on 2026-09-05 UTC

- Source CI at the exact source commit succeeded: [Paperclip candidate CI](https://github.com/Waipro-Team/paperclip/actions/runs/33948093823). Build, typecheck/release registry, general/server shards and e2e succeeded. Structured run evidence: `source-ci.json`.
- Final directory-context build duration: 1234.10 seconds; cancellation exit130; reason `disk_reserve`.
- Initial free space: 29.230 GiB; lowest observed: 17.992 GiB. Stop threshold18 GiB, minimum authorized reserve15 GiB, maximum build time1800 seconds. The reserve remained above15 GiB.
- Builder actual limits: memory6 GiB, memory+swap6 GiB, CPU quota200000/period100000 (two CPUs). HostConfig and direct cgroup readings saved. A later read observed memory4493152256 bytes and oom/oom_kill counters0; this observation is contextual, not a saved success test.
- Build log proves frozen install and completed UI/SDK/server/Rust stages, including the full server build stamp. Native alias preparation in the final image stage was not reached in this attempt; its earlier isolated proof remains in `../embedded-postgres-soname/`.
- The attempted late CPU/I/O observation occurred after builder removal; `assembly-observation.json` explicitly reports unavailable, and is not evidence of completed assembly.
- Cleanup removed the unique builder container, its cache volume and the exact temporary source context. No candidate image remains. Final free space: 29.229 GiB. No global prune, live image/container/volume, deployment or production data was changed.
- `smoke-image.py` was reviewed and syntax-checked, but not run. It requires a completed exact image, rejects declared anonymous volumes, uses UID1001/read-only rootfs/network none with only declared tmpfs, creates ephemeral synthetic authentication, and probes validation400 versus missing404. Its scope would be auth and route presence, not task execution or business acceptance.

## Prior attempt classification

1. `build-raw-*`: source archive omitted the official lock preprocessing; frozen install rejected lock/config mismatch after48.02 seconds. This is a preflight runner omission, not failure of the official workflow.
2. `build-stream-*`: captured reviewed lock applied, but recomposed PAX tar stdin was misdetected by Buildx as a Dockerfile. HTTP2 compression/transport failure after15.07 seconds happened before compilation. This is our transport defect, not a Paperclip code failure.
3. `build-result.json` / `build.txt`: explicit verified extracted directory eliminated stdin autodetection. Source stages passed; disk reserve stopped final copy. All three attempts cleaned only their own fixture resources. No further identical retry was made.

## Repetition and remaining gate

The scripts retain the exact commit and captured lock inputs. They are diagnostic evidence, not an instruction to repeat on this host while capacity is unchanged. No image or live API readiness is claimed. The next justified proof is the same official image plus isolated authentication/route smoke on an adequately provisioned disposable builder, preserving commit and derived lock hash, with no registry publishing or deployment. The source CI and earlier 19-test auth/intake fixture remain independent completed evidence.

Validation detail: scripts, Markdown, JSON and derived YAML passed staged whitespace checks. Raw terminal logs and the captured unified diff preserve their original CR/trailing/context spaces and are excluded from whitespace lint only; see `validation-scope.json`. Their exact bytes remain covered by the manifest.
