# Intake: preflight autenticazione e build

CANDIDATO, 5 settembre 2026. Baseline e3eab571283f620d40992fbeaad11668f6bf12f6,
branch codex/portal360-reconcile-20260902 nel canonico server Paperclip reconcile.

## Prova API sintetica

Il nuovo test `server/src/__tests__/regia-intake-preflight.test.ts` monta Express,
actorMiddleware, boardMutationGuard e regiaIntakeRoutes reali. Il database usa
uno stub e il servizio intake una risposta sintetica: nessun task, modello,
credenziale reale, DB live o provider. Il contesto board e' fornito dalla fixture
resolveSession; non e' prova del login reale o del deploy della route.

- Bearer vuoto: HTTP 401 su intake presente e su percorso inesistente. Quindi
  una risposta 401 da sola non dimostra che l'API esista dietro l'autenticazione.
- Sessione board sintetica del tenant corretto e Origin attendibile: intake
  risponde HTTP 201 con executionAuthorized=false e policy_configuration_required;
  il percorso inesistente risponde HTTP 404. Il servizio viene chiamato solo
  dal percorso corretto.
- Anonimo o Origin estranea: HTTP 403; il servizio non viene chiamato.

Suite eseguita: 19 test passati, zero falliti, su quattro file. Comando:

```sh
PAPERCLIP_TELEMETRY_DISABLED=1 ./node_modules/.bin/vitest run server/src/__tests__/regia-intake-preflight.test.ts server/src/__tests__/regia-intake-route.test.ts server/src/__tests__/heartbeat-regia-execution-binding.test.ts server/src/__tests__/board-mutation-guard.test.ts
```

Revisione indipendente adversarial_reviewer: PASS, suite 19/19 ripetuta e
diff-check verificato.

Questa suite non avvia il server Paperclip completo e non certifica la route
nell'immagine integrata. La prova distingue esplicitamente stato HTTP, presenza
della route e autorizzazione all'esecuzione.

## Preflight risorse prima della build

Osservazione server in questa attivita': filesystem circa 387 GiB, circa 30 GiB
liberi, utilizzo 93%; RAM disponibile circa 11 GiB e swap assente. Il riepilogo
Docker dichiara volumi 40.85 GB, immagini 63.83 GB e cache build 4.904 GB.
Questi numeri descrivono risorse esistenti; "reclaimable" non significa che
l'agente sia autorizzato a cancellarle. Nessun prune o rimozione storica.

Il Dockerfile ufficiale usa target production, toolchain Rust, installazione
pnpm frozen, build UI/plugin/server e layer CLI. Il builder predefinito docker
non fornisce qui un limite verificato sulle risorse di build. Un tentativo
successivo e' autorizzato soltanto con builder fixture separato, limiti reali
6 GiB e due CPU, watchdog prima di scendere sotto 15 GiB liberi e timeout
esplicito. Rimuovere solo builder e cache fixture di proprieta' provata.

Il dist server presente reca build-info c1bde60c6, e da quel commit cambia anche
scripts/prepare-bundled-package.mjs. Non viene rinominato o presentato come
build integrale del candidato attuale. Le prove hotfix nel
[precedente fascicolo](../embedded-postgres-soname/RECEIPT.md) verificano il solo
layer e il helper, non una nuova immagine completa.

Al momento di questa ricevuta la build integrale e lo smoke sull'immagine non
sono ancora eseguiti. Il loro esito deve avere una ricevuta separata riferita
allo specifico commit e all'ID immagine. Nessuna promozione runtime effettuata.
