# Preflight Telegram: prova integrata del candidato

6 settembre 2026, Europe/Rome. Stato CANDIDATE. Test autore Codex: **6/6 PASS,
zero skip**, eseguiti come `claw360` (UID10001), 17,616 secondi. TypeScript server:
PASS, 13,874 secondi sullo stesso SHA del test.

Paperclip base `9ac50ed69eaf90dd3358e57aeaf4c61d63c294f8`; Portal base
`402135ee6f58769309ee8db3116e5ad7fef308b5`. Le modifiche API/receiver degli
autori concorrenti sono incluse nella prova e identificate per SHA in
[telegram-wire-manifest.json](telegram-wire-manifest.json).

Il client Python importa realmente il receiver Portal e usa urllib su una
socket TCP loopback. Express usa i veri actorMiddleware, authRoutes,
boardMutationGuard e regiaIntakeRoutes; validatori, servizio e PostgreSQL
embedded sono reali. Il backend autentica chiavi sintetiche della fixture,
hashate nel database effimero. Il board ha una sola company, ruolo member
e nessun privilegio instance_admin; la chiave agente ha il responsabile
esplicito richiesto dal middleware.

| Caso | Risposta HTTP osservata | Risultato receiver |
| --- | --- | --- |
| Board e binding corretti | session 200, preflight 200 | exit0, fabbry_preflight_ok |
| Endpoint preflight assente | session 200, preflight 404 | startup bloccato |
| Company estranea | session 200, preflight 403 | startup bloccato |
| Regia di altra company | session 200, preflight 422 | startup bloccato |
| Credenziale agente valida | session 401 | startup bloccato, nessun preflight |
| Board user atteso diverso | session 200 | startup bloccato, nessun preflight |

In ogni caso restano a zero issue, goal, approval, activity/receipt, wake,
lease e run. L'autenticazione può aggiornare lastUsedAt: il positivo verifica
questa scrittura reale, quindi la prova non afferma assenza universale di
scritture DB. Il servizio preflight usa una transazione repeatable-read,
read-only. Il journal non viene aperto, lo stato receiver non viene creato
e polling/intake non partono. Le osservazioni effettive sono in
[telegram-wire-observations.json](telegram-wire-observations.json), estratte
dal [log finale](telegram-wire-tests.log).

Il solo override della porta avviene nel costruttore HttpClients del
subprocess di test, dopo la validazione della configurazione. Il valore
predefinito sorgente resta http://127.0.0.1:3100; la fixture ascolta una porta
effimera differente e un controllo socket ammette soltanto quell'indirizzo.
La porta live3100 non viene contattata. Python usa -I e -B, ambiente minimo,
nessun file auth, nessuna credenziale reale. I riferimenti secret sono risolti
da una funzione sintetica interna al test. Telegram getMe è sintetico e
compare soltanto nel positivo; getUpdates e sendMessage non sono invocati.
La prova non attesta Telegram live, approvazione, dispatch o modello.

Riproduzione dal server repair360, con entrambi i checkout candidati:

```sh
cd /root/work/paperclip-portal360-reconcile-20260902/server
runuser -u claw360 -- env PAPERCLIP_PORTAL_RECEIVER_ROOT=/root/work/portal360-ferrari-universal-control-20260904 pnpm exec vitest run --config vitest.config.ts --cache=false --configLoader runner src/__tests__/telegram-intake-wire.test.ts
runuser -u claw360 -- pnpm exec tsc --noEmit -p tsconfig.json
```

Il test è esplicitamente opt-in perché richiede il checkout Portal. Senza
PAPERCLIP_PORTAL_RECEIVER_ROOT dichiara skip; quando abilitato, un ambiente
PostgreSQL non supportato o root causa FAIL. La prova registrata qui ha
zero skip e UID10001. Socket, subprocess, database e directory temporanee
della fixture sono stati chiusi/rimossi; nessun residuo del prefisso
paperclip-telegram-wire-* in /tmp al controllo finale.

Il [primo run](telegram-wire-first-run.json) conserva il fallimento iniziale
del solo harness: req.path letto dopo il mount risultava relativo al router;
la chiave agente senza responsibleUserId veniva correttamente rifiutata dal
middleware con audit. Corretto il test usando originalUrl catturato prima
dei router e una credenziale agente completa. Nessuna modifica API o
receiver per forzare il verde. Il log storico del primo run resta separato.

Unico sorgente scritto da questo incarico:
server/src/__tests__/telegram-intake-wire.test.ts,
SHA256 `47d847ae23b71ccfc089ae9ba7c4a2b29c78b2cc5b31012af5e8fcab9dd18735`.
Nessun commit, push, deploy o modifica live. Review indipendente richiesta
alla regia sul candidato congelato; il suo verdetto viene registrato separatamente.
