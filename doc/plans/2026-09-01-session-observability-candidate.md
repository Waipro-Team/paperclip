# Session observability candidate receipt

Date: 2026-09-01

Status: candidate only; not deployed or connected to a live service.

## Git receipt

- Canonical source checkout: `/root/work/paperclip-repair360-fleet`
- Base commit: `bfc8b1e72295eff28d5ba0703def7a19d02694c6`
- Isolated candidate worktree: `/root/work/paperclip-session-observability-20260901`
- Candidate branch: `candidate/session-observability-20260901`
- Verified implementation commit: `601e9e40d019fa44436b16b4f3634fb234ad796e`

## Delivered surface

- `GET /api/companies/:companyId/session-observability`, guarded by the existing
  company authorization middleware.
- `Team / Agents / Sessioni` at `/agents/sessions`, implemented with existing
  Paperclip cards, badges, tabs, buttons, typography, colors, and spacing tokens.
- Agent/session nodes expose running, idle, blocked, and error state; current
  task; operational owner; phase; blocker state; workspace lane/worktree branch;
  last event; context handoff; and latest message receipt.
- Comment and interaction receipts support direct agent-to-agent handoff without
  adding a chat system, event bus, queue, or writable transport.
- The targeted fixtures cover a Chiara TEC to Giorgia MrPhone handoff and the
  owner to phase to blocker to receipt chain.

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
customer-message content. Human user IDs are not returned. The endpoint is
read-only and creates no new persistence or delivery semantics.

## Verification receipt

- Targeted Vitest: 3 files, 5 tests passed.
- TypeScript: shared, server, and UI passed (`tsc --noEmit` / `tsc -b`).
- UI production build: passed.
- `git diff --cached --check`: passed before the implementation commit.
- Design token gate: the new surface has no findings. The repository-wide
  command remains red because the base commit already contains 16 findings in
  `ui/src/pages/TeamCatalog.tsx` (6 color, 9 arbitrary-value, 1 raw-font-size).
- The standard server typecheck wrapper cannot build its Rust runner on this
  host because `cargo` is absent; after building the existing plugin SDK
  prerequisites, direct server `tsc --noEmit` passed.

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

No migration, write path, queue, OAuth/WABA setting, token, or external message
was introduced. Roll back by removing the candidate build (or reverting the
receipt commit and implementation commit `601e9e40d`) and returning to base
`bfc8b1e72`. The API route and UI tab disappear together; no data repair or
message replay is required. Client query caches refresh every 10 seconds and can
also be cleared during staging rollback.
