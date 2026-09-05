# Match preprocessing container to the disposable context owner

The real hosted run33950620767 at source ee0138a6245b8edcf04f878d14e524cad68035a9 passed checkout, guards, capacity and Docker tooling, then failed before the image build: root inside a container with all capabilities dropped could not traverse the hosted runner-owned0700 context. The canonical server run used root-owned temporary context and had not exposed this portability defect.

The only runner change sets numeric UID:GID to the executing host user and keeps HOME=/tmp and COREPACK_HOME=/tmp/corepack inside the disposable container. No chmod, extra capabilities, host cache/credential mount or source checkout mutation. pnpm can write the owned archive context and its temporary home/cache; the invariant check still rejects any archive-file delta other than pnpm-lock.yaml.

A tiny real Docker regression on the canonical server used only a synthetic context owned by UID1001 with mode0700, network none, readonly image filesystem,128 MiB memory and one quarter CPU:
- UID0 with cap-drop ALL: expected EACCES and exit42.
- UID1001 with cap-drop ALL: read package.json, write synthetic lock in context and write both temporary Corepack/pnpm cache locations succeeded.
- Both named fixture containers and the temporary context were removed. No registry, pnpm install, app server, model task or production state was used in this regression.

The failed hosted run artifact is preserved here. Its runner had117625860096 bytes free after SDK cleanup and15735615488 bytes available memory; capacity is demonstrated, not inferred from the server. The failed preprocessing container was removed, the image step and smoke were skipped, and cleanup/evidence upload succeeded.

Python syntax and Git diff whitespace checks passed. The new hosted run remains necessary to attest actual package-manager preprocessing and the complete image/smoke. Historical manifests describe their original committed snapshots; this scoped manifest records the intentional preprocessing runner delta.
