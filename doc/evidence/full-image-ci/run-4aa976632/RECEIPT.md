# Complete candidate image and isolated auth/route validation — PASS

The actual candidate image built successfully, started against fresh disposable state and passed authentication plus intake route-presence/validation probes. Both the source CI and image preflight succeeded at source commit4aa9766329449d19216cdfb47124ef300570251b. This is not deployment, valid intake acceptance or agent/task execution.

## Bound result

- [Exact-source CI](https://github.com/Waipro-Team/paperclip/actions/runs/33951001240): all jobs succeeded.
- [Hosted image preflight](https://github.com/Waipro-Team/paperclip/actions/runs/33951001006): preprocessing, full production build, image smoke, cleanup and evidence upload succeeded.
- Docker image ID: sha256:51494ceb67afde934f3f1589162cfa7408dad71b5b52a9891f6639dfb1406d72. This is the actual local Docker image identity, not a registry manifest digest.
- Image size:4790410296 bytes. Build duration:522.03 seconds.
- Source lock SHA-256:c92dc538b4cc082d850da897049a36537cf5c070705ff13e4b8d8fbe68a2de31. Captured derived lock SHA-256:cb5329794adbf94f80f7d06d9593acd940dd7085bb053e78962780154aa97bcf. The root lock remained unchanged and only pnpm-lock.yaml changed in the archived context.
- Dockerfile SHA-256:e220748da3c2621a97c9f8cbfccccfce86f238d97cf71490a579c54090455496. Native alias preparation is included in this complete production image. Source stamp reported by the healthy server is the full tested commit.

## Actual image smoke

The container ran as UID1001:GID1001 with read-only root filesystem, network none, memory2 GiB/one CPU, no published ports or persistent volumes, and only declared /paperclip and /tmp tmpfs. Scheduler and telemetry were disabled. Authentication used newly generated synthetic credentials solely in the disposable container state.

Health returned200. Synthetic signup returned200, a real authenticated session was established, and first-admin bootstrap claim returned200. Empty Bearer returned401 for both the existing intake endpoint and a missing path, confirming that401 alone does not prove route presence. With the real fixture session, invalid intake body returned400 while the missing path returned404.

No valid intake was submitted. Business acceptance, task execution, external adapters, Telegram and production continuity are not attested by this probe.

## Resources and cleanup

The builder used verified6 GiB memory/two CPUs and a1800-second timeout, with a40 GiB entry threshold and18 GiB disk watchdog. Initial free space was116402466816 bytes; minimum observed free space was93834776576 bytes. The resource limit which stopped the server build was not encountered on this hosted runner.

The dedicated builder container/cache volume and temporary source context were removed. The smoke container and its tmpfs state were removed. The final cleanup removed the exact candidate image after the smoke; intermediate build/smoke records say retained only because the later cleanup step had not yet run. ci-cleanup.json is the final state.

The declared GitHub artifact files were copied to this canonical evidence directory via a dedicated temporary server directory which was removed. Raw log/diff bytes are preserved and hash-covered; whitespace lint excludes only those raw artifacts. All JSON relationships, lock hashes, image IDs, source stamps, HTTP outcomes and cleanup flags were checked together in this activity.

## Practical next step

No deployable copy of the tested image remains: it was deliberately removed on the disposable runner and no image archive/registry was published. Producing a transferable image artifact from the same image ID after its own successful smoke is the next necessary step before server availability. A future image must be identified by its own source, captured lock and image ID; this PASS must not be transferred to another build implicitly. Base tags and global CLI latest dependencies remain mutable official inputs.

This evidence is ready for independent review. It is not pushed automatically as a receipt-only commit, because pull-request path filters evaluate the PR diff and may trigger another image build.
