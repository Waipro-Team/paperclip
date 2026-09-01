# Session observability candidate receipt

Date: 2026-09-01

Status: candidate only; not deployed or connected to a live service.

## Git receipt

- Canonical source checkout: `/root/work/paperclip-repair360-fleet`
- Base commit: `bfc8b1e72295eff28d5ba0703def7a19d02694c6`
- Isolated candidate worktree: `/root/work/paperclip-session-observability-20260901`
- Candidate branch: `candidate/session-observability-20260901`
- Verified implementation commit: `601e9e40d019fa44436b16b4f3634fb234ad796e`
- Independent-judge hardening commit: `55ba850f50f372f1d2f8213a94c5ce862ba6cf32`
- Final-review blocker fix commit: `dbc88278a59b3b79ca88817f7ac57f0109c0e9f3`
- Active-run retention fix commit: `a875a6a5890032b5b7b3da75a87bfaf5c12efa49`
- Cross-query transition race fix commit: `e3034b7774f1de3b925733da47e882e9ee225649`

## Delivered surface

- `GET /api/companies/:companyId/session-observability` is board/operator-only,
  then guarded by company tenancy plus the existing `company_scope:read`
  policy. Standard agent keys, task-bridge keys, and low-trust agent JWTs are
  denied before the policy or graph query; authorized human board users are
  allowed.
- `Team / Agents / Sessioni` at `/agents/sessions`, implemented with existing
  Paperclip cards, badges, tabs, buttons, typography, colors, and spacing tokens.
- Agent/session nodes expose running, idle, blocked, and error state; current
  task; operational owner; phase; blocker state; workspace lane/worktree branch;
  last event; context handoff; and latest message receipt.
- Comment and interaction receipts support direct agent-to-agent handoff without
  adding a chat system, event bus, queue, or writable transport.
- The targeted fixtures cover a Chiara TEC to Giorgia MrPhone handoff and the
  owner to phase to blocker to receipt chain.
- A node's current task is selected only from `in_progress` issues. `todo` and
  `backlog` are never used as a fallback current task.
- Active heartbeat runs (`running`, `queued`, and `scheduled_retry`) are read
  independently from the 30-day historical window, merged with recent runs,
  and deduplicated by run ID. An active run therefore remains visible after it
  crosses the historical cutoff.
- If a run changes state between the active and recent queries, duplicate IDs
  now retain the row with the newest `updated_at`/`created_at` snapshot. A
  newer terminal observation therefore replaces a stale active observation
  within the same poll.
- Each node exposes the agent's cumulative model cost from the existing
  company-scoped `agent_runtime_state.total_cost_cents` record. The source is
  bounded by the agent cap, defaults to zero when absent, and never crosses a
  company boundary.
- A stale 401/403 response now triggers exactly one shared access-recovery pass
  (session/company/access invalidation and refetch), then renders an explicit
  retry action. It does not mutate memberships, broaden permissions, or loop.
- Current-task selection treats `in_progress`, `blocked`, `in_review`, and
  `todo` as current (never `backlog`), each mapped to its own phase, so a
  blocked or in-review agent stays visible to the operator instead of
  collapsing to idle. Decision made explicitly during the merge with the
  independent session-observability hardening line (2 Sep 2026): operator
  visibility into blocked/in-review work outweighs the narrower
  in-progress-only definition that line used.

## Data and privacy contract

The read model derives from existing Paperclip records only: `agents`,
`heartbeat_runs`, `heartbeat_run_events`, `activity_log`, `issues`,
`issue_relations`, `issue_comments`, `issue_thread_interactions`,
`execution_workspaces`, and `project_workspaces`.

Queries select operational identifiers, states, timestamps, agent names/roles,
task identifiers, workspace names/strategies/branches, and whether an assignment
belongs to the board. They do not select or return comment bodies, interaction
presentation/payloads, heartbeat context content, prompts, logs, result/error
bodies, workspace paths/URLs, emails, phone numbers, tokens, secrets, or
customer-message content. Human user IDs are not returned. Activity-log actions
and entity types cross closed output allowlists; unknown values collapse to
`activity.event` and `entity`, and raw activity `entityId` is neither selected
nor returned. The endpoint is read-only and creates no new persistence or
delivery semantics.

Heartbeat event types cross a closed output allowlist; unknown or content-like
values collapse to `run.event`. Comment recipients come only from an actual
receiving run, while interaction recipients come from persisted addressee,
resolver, or receiving-run evidence. Reassignment is never used as receipt proof.

## Verification receipt

- Targeted observability Vitest: 3 files, 15 tests passed (8 service, 6 route,
  1 UI).
- Active-run follow-up: 15 relevant server tests passed (8 service, 6 route,
  and 1 PostgreSQL query regression). The PostgreSQL regression ran in an
  isolated non-root container and seeded `running`, `queued`, and
  `scheduled_retry` rows 45 days old, newer terminal history for the same
  agents, and an active row in a different company. All three target-company
  agents remained visible with the expected phases, while the other-company
  agent was absent.
- Cross-query transition follow-up: 15 direct server tests passed and the new
  focused regression proves both input orders select the newer terminal row
  for a duplicate run ID. Direct server TypeScript `--noEmit` and
  `git diff --check` passed. The PostgreSQL query shape is unchanged by this
  in-memory merge correction; the prior non-root PostgreSQL regression remains
  the query-level proof.
- Migration regressions: 26 tests passed (25 safety + 1 snapshot drift). The
  migration safety check passed with no new unsuppressed finding. The two new
  index statements carry an explicit maintenance-gate suppression because the
  repository migration runner wraps each migration file in a transaction and
  therefore cannot execute `CREATE INDEX CONCURRENTLY`.
- Supertest exercised the real route gate for an authorized user/admin and
  standard, task-bridge, low-trust, and cross-company denial paths; denied
  callers never reached policy evaluation or the graph service.
- TypeScript: shared, DB, direct server, and UI passed (`tsc --noEmit` / `tsc -b`).
  The server package wrapper could not run on this host because `cargo` is not
  installed; direct server TypeScript passed and this is not reported as a full
  server package build.
- After the active-run follow-up, direct server TypeScript passed again both
  with `--noEmit` and with emitted output. The package wrapper still stops in
  the unchanged runner prerequisite because `cargo` is not installed.
- UI production build: passed.
- Final control-room hardening (session-observability + cost/access-recovery
  line): 23 focused tests passed and 3 PostgreSQL integration tests passed in
  an isolated non-root container on that line alone. These tests cover
  company-scoped cost mapping and one-shot 401/403 recovery without permission
  expansion or retry loops. This predates the merge with the independent
  session-observability hardening line below and has not been re-run against
  the combined candidate.
- `git diff --check`: passed before both candidate commits.
- Volume evidence: the read-model test processed 12,000 heartbeat events plus
  12,000 comment rows in 28 ms on this host, returned the 24-receipt cap, and
  proved prompt/token/path-like event types absent from serialized output.
- Query bounds: 500 agents, 1,000 in-progress issues, up to 2,000 active plus
  2,000 recent heartbeat rows before ID deduplication, 2,000 activity/event/relation
  rows, 200 comment/interaction rows, and 24 returned receipts. The 30-day
  window still bounds historical heartbeat rows and all high-frequency
  activity/event/message sources; active heartbeat rows bypass only that time
  cutoff and retain the existing company/status and company/created-at index
  predicates.
- Migration `0234_sleepy_sentry.sql` adds `(company_id, created_at DESC)` indexes
  for `issue_comments` and `issue_thread_interactions`; the existing heartbeat
  index covers the new run lookback.
- PostgreSQL 16 proof used isolated disposable tables with 200,000 rows each and
  the exact query ordering/predicates. `EXPLAIN (ANALYZE, BUFFERS)` selected the
  expected bitmap index for all three sources. Execution time was 9.998 ms for
  comments, 9.329 ms for interactions, and 7.181 ms for heartbeat runs. The
  proof container was removed after the run; production data was not touched.
- Polling uses the existing cross-tab leader/cache coordinator, pauses in hidden
  tabs, slows when unfocused, and retries non-authorization errors twice with
  bounded exponential backoff. A 401/403 disables interval polling; successful
  access recovery performs exactly one explicit session-query refetch, and a
  persistent denial remains stopped until the operator selects `Riprova`.
- Cost rows are selected only for the already bounded, visible agent IDs. This
  keeps company scope and the 500-row bound aligned even when agent status and
  runtime-state orderings differ at the boundary.
- Design token gate, pre-merge status on each independent line: the
  cost/access-recovery line reported all four repository-wide gates passing;
  the independent session-observability hardening line reported zero
  candidate-introduced findings but a pre-existing red repository-wide result
  (16 findings in `ui/src/pages/TeamCatalog.tsx`, unrelated to this feature).
  **Neither status has been re-verified against this merged candidate — treat
  the token gate and full test suite as NOT_DEMONSTRATED until rerun on the
  combined tree.**

## Canary plan

1. Build only from the candidate SHA and publish it to an isolated, non-customer
   staging target; do not repoint the live Paperclip container.
2. Seed a staging company with existing issue/comment/interaction/heartbeat rows
   representing Chiara TEC and Giorgia MrPhone. Do not copy production content.
3. Call the endpoint as an authorized board actor and confirm company isolation,
   bounded response size, the four status mappings, and all privacy booleans set
   to `false`.
4. Open `/agents/sessions` and verify the owner → phase → blocker → receipt chain,
   refresh behavior, empty/error states, and that no body/prompt/human identifier
   appears in the browser response or rendered DOM.
5. Observe endpoint latency and error rate under staging data volume before any
   promotion. Promotion requires an explicit separate approval and a clean
   repository-wide token-gate decision.

## Rollback plan

No write path, queue, OAuth/WABA setting, token, or external message was
introduced. From the final receipt HEAD, remove the complete candidate —
including every implementation and receipt commit — with:

```sh
git revert --no-commit $(git rev-list --first-parent bfc8b1e72..HEAD)
git commit -m "revert: remove session observability candidate"
```

This returns behavior to base `bfc8b1e72` while preserving an auditable revert.
Migration `0234_sleepy_sentry.sql` contains indexes only, so rollback drops no
business data; the reverse migration drops only those two indexes. The API route
and UI tab disappear together. In staging, invalidate the session-observability
query cache (or reload after the candidate is removed) so a leader-broadcast
snapshot is not displayed after rollback. No deploy or live configuration change
was performed during candidate verification.
