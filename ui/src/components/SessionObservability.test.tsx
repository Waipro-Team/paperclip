// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionObservabilityResponse } from "@paperclipai/shared";
import { SessionObservability } from "./SessionObservability";

const mockGet = vi.hoisted(() => vi.fn());

vi.mock("../api/sessionObservability", () => ({
  sessionObservabilityApi: { get: mockGet },
}));

vi.mock("../lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <QueryClientProvider client={queryClient}>
      <SessionObservability companyId="company-tec" />
    </QueryClientProvider>,
  );
  return container;
}

describe("SessionObservability", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  afterEach(() => {
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
  });

  it("renders agent nodes and the owner to receipt chain without sensitive content", async () => {
    const response: SessionObservabilityResponse = {
      generatedAt: "2026-09-01T12:10:00.000Z",
      sourceTables: [
        "agents",
        "heartbeat_runs",
        "heartbeat_run_events",
        "activity_log",
        "issues",
        "issue_relations",
        "issue_comments",
        "issue_thread_interactions",
        "execution_workspaces",
        "project_workspaces",
      ],
      privacy: {
        contentIncluded: false,
        humanIdentityIncluded: false,
        secretsIncluded: false,
      },
      nodes: [{
        agent: { id: "giorgia", name: "Giorgia MrPhone", role: "customer_manager", title: "MrPhone" },
        status: "running",
        phase: "executing",
        owner: { kind: "agent", agentId: "giorgia", label: "Giorgia MrPhone" },
        issue: { id: "issue-42", identifier: "MRP-42", status: "in_progress" },
        lane: {
          workspaceId: "workspace-42",
          name: "Corsia MrPhone",
          strategy: "git_worktree",
          branch: "candidate/mrphone-onboarding",
        },
        blocker: { state: "clear", issueIdentifier: "MRP-42", blockerCount: 0 },
        lastEvent: {
          id: "event-91",
          source: "heartbeat_event",
          action: "tool.completed",
          entityType: "heartbeat_run",
          entityId: "run-1",
          occurredAt: "2026-09-01T12:08:00.000Z",
        },
        handoff: {
          kind: "comment",
          from: { id: "chiara", name: "Chiara TEC" },
          receiptId: "comment-1",
          receiptState: "received",
          runId: "run-1",
          occurredAt: "2026-09-01T12:05:00.000Z",
        },
        lastReceipt: {
          id: "comment-1",
          source: "comment",
          from: { id: "chiara", name: "Chiara TEC" },
          to: { id: "giorgia", name: "Giorgia MrPhone" },
          issue: { id: "issue-42", identifier: "MRP-42", status: "in_progress" },
          state: "received",
          runId: "run-1",
          createdAt: "2026-09-01T12:05:00.000Z",
          acknowledgedAt: null,
        },
        updatedAt: "2026-09-01T12:08:00.000Z",
      }],
      messages: [{
        id: "comment-1",
        source: "comment",
        from: { id: "chiara", name: "Chiara TEC" },
        to: { id: "giorgia", name: "Giorgia MrPhone" },
        issue: { id: "issue-42", identifier: "MRP-42", status: "in_progress" },
        state: "received",
        runId: "run-1",
        createdAt: "2026-09-01T12:05:00.000Z",
        acknowledgedAt: null,
      }],
    };
    mockGet.mockResolvedValue({
      ...response,
      prompt: "PRIVATE PROMPT",
      email: "private@example.test",
    });

    const panel = renderPanel();

    await vi.waitFor(() => {
      expect(panel.querySelector('[data-testid="session-node-Giorgia MrPhone"]')).not.toBeNull();
    });
    const text = panel.textContent ?? "";
    expect(text).toContain("Giorgia MrPhone");
    expect(text).toContain("Chiara TEC");
    expect(text).toContain("Owner");
    expect(text).toContain("Fase");
    expect(text).toContain("Blocco");
    expect(text).toContain("Ricevuta");
    expect(text).toContain("Corsia MrPhone");
    expect(text).toContain("candidate/mrphone-onboarding");
    expect(text).toContain("Messaggi tra agenti con ricevuta");
    expect(text).not.toContain("PRIVATE PROMPT");
    expect(text).not.toContain("private@example.test");
  });
});
