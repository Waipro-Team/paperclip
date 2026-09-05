# Paperclip server-team candidate — 2026-09-05

Base: `706e2d42fb2f26aa73f346e23c0365950ff6d686`.
Repository: Waipro-Team/paperclip, branch `codex/portal360-reconcile-20260902`.
Portal companion source: `5c421698e665aafe8d4cd3e3e334566d8a710245` in Repair360/portal360.
This increment is a source candidate. It does not activate a live agent.

## Changes and independent reviews

The OpenClaw adapter rejects effective model/provider/session overrides before
opening its WebSocket. It requires an agent-scoped session key. A config.get
snapshot cannot prove the effective native CLI/plugin boundary, so execution
and the environment test fail closed for stock OpenClaw. There is no adapter
flag that turns a claimed sandbox into a trusted execution boundary.
The targeted adapter and WebSocket checks passed: 78 tests, adapter typecheck
and build. Author: Codex executor_guard. Independent reviewer: Codex
import_client, PASS. This is not a Marco/Claude or CodeRabbit review.

The board-only issue inventory uses an explicit complete envelope and includes
hidden, harness and terminal issues. It requires company_scope:read and denies
filters. A read-only repeatable-read transaction obtains each page and its
count. The Portal client compares two bounded complete scans and refuses the
legacy list response. Its installation ledger is reserved before a POST.
The first independent review found a duplicate when a hidden issue existed
and the ledger was new. The corrected client recovered the existing issue
with zero POST requests and one row. The second review passed.
Author: Codex import_client. Reviewer: distinct Codex executor_guard.
Validation: 11 inventory route tests and 23 ordinary GET regressions passed
with real embedded PostgreSQL under claw360. The companion Portal checks
passed 41 targeted Python tests and the full 581-test Portal suite.

The Rust runner preserves unread stdout before it publishes process exit.
A detached writer that prevents EOF causes an explicit error after shutdown
grace instead of an unbounded wait. The timing-sensitive existing Codex test
now uses a bounded wait and a valid event order. Author: Codex paperclip_ci.
The first independent review found the detached-writer hang. The second
review passed after the deadline fix and its OS regression. Reviewer: Codex
import_client. See ../ci-rust-20260905 for exact source hashes, 222 passing
release tests and 200 passing contention repetitions. These checks used
Rust 1.97.1. No assertion about completion authority was removed.

## Whole-repository verification

checks.json records the three required commands and exact exit codes.
pnpm -r typecheck and pnpm build passed. The root pnpm test:run invocation
failed in two pre-existing adapter-utils EACCES tests. It cannot be reported
as a full PASS. Some PostgreSQL tests skip when run as root; the 34 changed
API/regression cases above were separately exercised under claw360.
The two permission tests passed under claw360 (UID10001): 2 selected tests,
zero failures. See ../test-environment-20260905/claw360-t18-t19.json and its
log for the exact public Vitest API harness. No source, configuration or ACL
was changed. The root invocation still stopped before later adapter projects
and the serialized server suites; those results remain unverified by that run.
The full test.log is retained on the canonical server; only a compact summary
and failure excerpt belong in Git. Build and typecheck logs are retained here.

## Remaining operational gates

The native OCI fixture on Agency has its own HOME and a pinned image. It does
not yet supply the trusted boundary needed by this adapter. Real native login,
egress constraints, gateway binding, live issue import, Telegram owner/backend
binding, bounded concurrency and cost, authentic Marco review, and the complete
server-only result/review/recovery cycle remain open.
No production deployment, migration, merge or live roster change is part of
this increment. The previous source image and its CI results do not prove
this new source candidate. Remote CI must be tied to its new commit.
