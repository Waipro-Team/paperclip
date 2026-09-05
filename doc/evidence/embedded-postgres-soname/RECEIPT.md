# Embedded PostgreSQL: preparazione nel layer Docker

Stato: CANDIDATO, verifica del 5 settembre 2026. Nessun deploy o restart.

Il candidato Paperclip reconcile ora contiene i due hunks funzionali del hotfix
`76aa8fe97f19c70adf97b05a65d10baa86afc764`: Dockerfile prepara gli alias SONAME
prima del cambio UID runtime; il test nativo copre il riuso dopo chmod della
cartella. Il commento Docker e' stato chiarito in review per descrivere il helper,
non un loader failure non provato. Non e' stato unito l'intero branch live, e non sono state modificate
funzioni di intake, dati, configurazione o canali.

## Fonte e ownership

- Candidato canonico server: `/root/work/paperclip-portal360-reconcile-20260902`,
  branch `codex/portal360-reconcile-20260902`, baseline
  `20def6f275c8239aaca67c1e4bdb5b6209be058e`. Worktree clean prima della claim.
- Fonte hotfix: `/root/work/paperclip-agent-avatar-hotfix-e137`, branch
  `hotfix/agent-profile-avatar-e137-20260904`, HEAD `76aa8fe97f19c70adf97b05a65d10baa86afc764`.
- Entrambi i repository hanno upstream `paperclipai/paperclip` e remote di lavoro
  `Waipro-Team/paperclip`. Il secondo percorso non e' stato modificato.
- [Claim](CLAIM.json) riporta hash iniziali e autorizzazione corrente. Entrambi
  i file sono stati verificati di nuovo immediatamente prima di git apply.
- Helper `packages/db/src/embedded-postgres-native.ts` e
  `scripts/docker-entrypoint.sh` identici fra candidato e fonte hotfix, invariati.

## Prova sintetica effettiva

[verify-runtime.py](verify-runtime.py) usa l'immagine pre-hotfix gia' disponibile
sul server, verifica il suo ID e genera una fixture derivata con l'esatto RUN
estratto dal Dockerfile candidato. Verifica anche che l'helper contenuto nella
base abbia lo stesso hash di quello del candidato. Non e' una build integrale
del nuovo Paperclip: prova il layer modificato e l'effetto sul helper reale.

La fixture esegue soltanto il helper e `postgres --version`. Nessun server
Paperclip, processo DB, initdb o migrazione viene avviato. Nessun volume viene
montato; il root filesystem e' read-only, l'UID e' 1001, la rete e' none, tutte
le capability vengono rimosse. Limiti runtime: mezzo core, memoria 256 MiB,
64 processi. Il build derivato non installa pacchetti e usa la base locale.

| Osservazione nella fixture | Prima del layer | Dopo il layer |
| --- | --- | --- |
| Scrittura in /app | EROFS | EROFS |
| Alias libcrypto.so.1 e libssl.so.1 | Assenti | Presenti |
| prepareEmbeddedPostgresNativeRuntime | Fallisce EROFS | Risolve correttamente |
| postgres --version | Uscita corretta | Uscita corretta |

Il difetto riprodotto e' il tentativo di preparare alias sul filesystem
immutabile. Non si afferma che il binario PostgreSQL non caricasse prima:
il suo comando versione riusciva gia'. L'asserzione iniziale che ipotizzava
un loader failure e' stata rimossa dopo questa evidenza; il risultato iniziale
e' conservato in [fixture-initial.json](fixture-initial.json).

Il test chmod eseguito come root da solo non dimostra negazione dei permessi:
la prova container UID 1001/read-only chiude specificamente quel limite.
[fixture-result.json](fixture-result.json) contiene il confronto e verifica
che non restino container fixture o l'immagine temporanea. Le directory
server temporanee di build vengono rimosse automaticamente; nessun artefatto
persistente sul Mac. Nessun volume fixture creato.

Un primo tentativo di build usando l'ID immagine direttamente in FROM e'
fallito per risoluzione metadata come nome registry: [log](fixture-build-initial.txt).
Il runner corretto usa il tag locale dopo confronto dell'ID e pull=false;
la prova completata e' in [fixture-build.txt](fixture-build.txt).

## Test e limiti di consegna

- Suite pertinente eseguita nel candidato: 16 test passati su tre file
  (native PostgreSQL, entrypoint privilege, Docker build stamp).
- Comando: `./node_modules/.bin/vitest run packages/db/src/embedded-postgres-native.test.ts server/src/__tests__/docker-entrypoint.test.ts server/src/__tests__/docker-build-stamp.test.ts`.
- `node scripts/check-docker-deps-stage.mjs`: PASS; `git diff --check`: PASS.
- La suite usa fixture temporanee e stub; la prova Docker usa runtime isolato.
  Nessun accesso a DB live o provider.
- Revisione indipendente adversarial_reviewer: PASS sul diff, ricevuta e hash;
  suite pertinente 16/16 ripetuta dal reviewer.
- Non eseguiti build integrale immagine candidata, suite completa Paperclip,
  typecheck/build monorepo o smoke intake. Questa ricevuta chiude il difetto
  tecnico riprodotto nel layer, non certifica da sola l'intero candidato
  distribuibile o il funzionamento di intake sul runtime live.

Il prossimo gate e' includere questa modifica nella validazione complessiva
del candidato Paperclip, con revisione indipendente del diff e della ricevuta,
prima di qualsiasi promozione runtime autorizzata.
