# Transferable image artifact — reviewed-image export candidate

The successful image preflight at source4aa976632 verified an image which was intentionally removed at the end of the disposable job. Producing the actual transferable image is the missing deliverable; the new build must earn its own smoke result and image identity.

The workflow adds export only after a successful image smoke and before final image cleanup. It calls docker image save with the exact immutable image ID, streams through gzip -n -1 and preserves the archive SHA-256, actual byte count, Docker image size, source commit, both lock hashes and smoke-result hash in image-export.json. It never exports or commits the smoke container, so the temporary authentication/database state is not part of this archive. [Docker image save](https://docs.docker.com/reference/cli/docker/image/save/)

Export rejects missing or mismatched source/image/lock identities, missing full health stamp, failed auth/route outcomes, uncleared fixture state, wrong platform or an oversized image. Eight pure tests passed, including a main-path negative proving that a failed smoke cannot start the export pipeline. No Docker export or new image build was executed during these tests.

Resource bounds: maximum archive6 GiB; maximum export/hash duration300 seconds; at least18 GiB free, with entry reserve for the entire archive cap. The compressed stream is written once without an intermediate uncompressed tar. Failure removes only the output file created by this export. The existing final image cleanup still runs on workflow failure.

The binary is a separate GitHub artifact with retention1 day and compression-level0 because it is already compressed. The small evidence artifact retains7 days and adds only fixed image-export JSON/log paths. There is no registry login/push, package-write permission, deploy, secret input or billing/settings change. Workflow permissions stay contents:read. The existing standard hosted public-fork restriction remains. [Artifact action](https://github.com/actions/upload-artifact)

Actionlint1.7.12 semantic validation, Python/YAML/Bash syntax and whitespace checks passed. Its temporary verified tool binary was removed. The current image verification receipt has already passed independent review; this extension has not yet run.

## Proposed server transfer gate, not yet executed

The canonical server was observed using Docker containerd/overlayfs, with31338799104 bytes free. The previous tested image size was4790410296 bytes; a new image must be measured independently. Before downloading its binary, read the small export manifest and GitHub artifact metadata and require enough space for a conservative envelope of15 GiB reserve plus twice the measured image size plus twice the measured compressed archive size. This envelope is a preflight margin, not a formal bound on all Docker daemon temporary allocations. Recheck and monitor actual disk use during download/load; if insufficient, stop without changing live or rollback images.

Docker can load the compressed archive directly; no manual expanded tar is necessary. Verify archive hash/source/image identity before loading, then verify the loaded image identity afterward. No unverified image pull or service switch is authorized by this export change. [Docker image load](https://docs.docker.com/reference/cli/docker/image/load/)

The archive is not yet available and its compressed size is not estimated as a completed fact. Any subsequent load remains conditional on the actual artifact and capacity checks.
