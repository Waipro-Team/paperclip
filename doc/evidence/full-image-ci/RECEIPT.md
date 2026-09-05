# Disposable hosted image preflight — prepared, not executed

The server build at source commit460b8f151 completed compilation but crossed the18 GiB disk stop threshold during the final image COPY. Its reviewed immutable evidence was committed at8233a4a0cf165375a6236a7ee074b649fc3fb791. This increment moves the next complete-image validation to a disposable GitHub-hosted runner; it changes no product code, runtime, billing, permissions or deployment configuration.

## Candidate scope

- New PR workflow is restricted to this fork and the current reconcile branch, with all source paths included; only evidence receipts and Docker-ignored workflow metadata are excluded, and this preflight workflow is explicitly included. A later receipt-only commit does not inherit an earlier image attestation: every result stays bound to its actual source commit. It checks out the exact pull request head commit, not the synthetic merge SHA; credentials are not persisted.
- Permissions are only contents:read. No secrets expression, registry login, image push, deployment or default-branch mutation.
- The explicit runner is ubuntu-24.04. GitHub documents public standard Linux runners as disposable VMs with4 CPUs/16 GB RAM/14 GB guaranteed storage; enough capacity is not assumed. [Official runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- Only the optional SDK paths already listed in the official Docker workflow are removed, exclusively after the hosted-runner guard. No Docker system prune. Actual free space and memory are recorded after cleanup; the build requires more than40 GiB free before starting. This is a conservative entry margin, not a proved peak bound. The watchdog remains18 GiB with minimum protected reserve15 GiB; time limit1800 seconds; dedicated builder6 GiB memory/two CPUs.
- COMMIT must be a full lowercase40-character hash and equal the checked-out source HEAD. OUTPUT must be the one exact non-symlink directory under RUNNER_TEMP. Hosted context and Linux are mandatory; these runners reject the server by default. GitHub supplies the runner variables. [Official variable reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)
- Historical scripts and manifests are unchanged. Reusable copies under scripts/portal360-image-preflight retain the reviewed behaviors with guarded CI input/output and dynamic source stamps.
- Official lock preprocessing runs in a dedicated2 GiB/one CPU registry-metadata fixture using bridge networking, and proves the source archive changed only pnpm-lock.yaml. The build then uses the captured derived lock bytes, preserving both hashes and source commit in one artifact. It does not mutate the checkout lock.
- A successful build is loaded only into this runner. The smoke uses the resulting immutable image ID, readonly UID1001/rootfs, network none, explicit tmpfs, and synthetic ephemeral authentication. It tests auth plus route validation/presence; no valid intake is submitted and execution is not tested.
- Fixture containers/cache/temp contexts are removed by their own runners; final workflow cleanup removes only the exact resulting candidate image. Evidence upload is a fixed list of files under RUNNER_TEMP; no environment/config/credential directories and no image archive. The VM is discarded after the job.

## Local verification, 2026-09-05 UTC

Seven pure guard tests passed on the canonical server: valid hosted context, server/self-hosted rejection, exact commit format, output escape, output symlink, temp symlink and existing-file rejection. These tests create and remove only their own temporary directory and perform no Docker or network operations. Python syntax, workflow YAML parse and constrained trigger/permissions/runner assertions passed. All historical full-image evidence hashes still match. Hosted execution is not yet attested.

Repetition for the pure checks only:

    python3 -I -B scripts/portal360-image-preflight/test_preflight_config.py

Next gate: independent review of this scoped workflow and runner diff before selective commit/push triggers the candidate PR run. A green source CI remains distinct from a completed image and its smoke result.
