import { describe, expect, it } from "vitest";
import { assembleSessionObservability } from "../services/session-observability.js";

const at = (value: string) => new Date(value);

type ObservabilityInput = Parameters<typeof assembleSessionObservability>[0];

function baseInput(overrides: Partial<ObservabilityInput> = {}): ObservabilityInput {
  return {
    now: at("2026-09-01T12:10:00.000Z"),
    agentRows: [],
    runRows: [],
    issueRows: [],
    relationRows: [],
    activityRows: [],
    heartbeatEventRows: [],
    commentRows: [],
    interactionRows: [],
    ...overrides,
  };
}

function testAgent(id: string): ObservabilityInput["agentRows"][number] {
  return {
    id,
    name: id,
    role: "engineer",
    title: null,
    status: "idle",
    updatedAt: at("2026-09-01T12:00:00.000Z"),
  };
}

function testIssue(
  id: string,
  status: string,
  assigneeAgentId: string,
  updatedAt: string,
): ObservabilityInput["issueRows"][number] {
  return {
    id,
    identifier: id.toUpperCase(),
    status,
    assigneeAgentId,
    assigneeUserId: null,
    createdByAgentId: null,
    executionWorkspaceId: null,
    executionWorkspaceName: null,
    executionWorkspaceStrategy: null,
    executionWorkspaceBranch: null,
    projectWorkspaceId: null,
    projectWorkspaceName: null,
    projectWorkspaceRef: null,
    updatedAt: at(updatedAt),
  };
}

function testRun(input: {
  id: string;
  agentId: string;
  status: string;
  contextIssueId?: string | null;
  contextCommentId?: string | null;
  contextInteractionId?: string | null;
  updatedAt?: string;
}): ObservabilityInput["runRows"][number] {
  const updatedAt = at(input.updatedAt ?? "2026-09-01T12:05:00.000Z");
  return {
    id: input.id,
    agentId: input.agentId,
    status: input.status,
    retryOfRunId: null,
    continuationAttempt: 0,
    contextIssueId: input.contextIssueId ?? null,
    contextCommentId: input.contextCommentId ?? null,
    contextInteractionId: input.contextInteractionId ?? null,
    startedAt: updatedAt,
    finishedAt: input.status === "running" ? null : updatedAt,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("session observability read model", () => {
  it("projects Chiara TEC and Giorgia MrPhone without content or human identity fields", () => {
    const input: Parameters<typeof assembleSessionObservability>[0] = {
      now: at("2026-09-01T12:10:00.000Z"),
      agentRows: [
        {
          id: "agent-chiara",
          name: "Chiara TEC",
          role: "customer_manager",
          title: "TEC",
          status: "idle",
          updatedAt: at("2026-09-01T12:02:00.000Z"),
        },
        {
          id: "agent-giorgia",
          name: "Giorgia MrPhone",
          role: "customer_manager",
          title: "MrPhone",
          status: "running",
          updatedAt: at("2026-09-01T12:03:00.000Z"),
        },
      ],
      runRows: [
        {
          id: "run-giorgia",
          agentId: "agent-giorgia",
          status: "running",
          retryOfRunId: null,
          continuationAttempt: 0,
          contextIssueId: "issue-mrphone",
          contextCommentId: "comment-handoff",
          contextInteractionId: null,
          startedAt: at("2026-09-01T12:05:00.000Z"),
          finishedAt: null,
          createdAt: at("2026-09-01T12:05:00.000Z"),
          updatedAt: at("2026-09-01T12:07:00.000Z"),
        },
      ],
      issueRows: [
        {
          id: "issue-mrphone",
          identifier: "MRP-42",
          status: "in_progress",
          assigneeAgentId: "agent-giorgia",
          assigneeUserId: null,
          createdByAgentId: "agent-chiara",
          executionWorkspaceId: "workspace-mrphone",
          executionWorkspaceName: "Corsia MrPhone",
          executionWorkspaceStrategy: "git_worktree",
          executionWorkspaceBranch: "candidate/mrphone-onboarding",
          projectWorkspaceId: null,
          projectWorkspaceName: null,
          projectWorkspaceRef: null,
          updatedAt: at("2026-09-01T12:06:00.000Z"),
        },
        {
          id: "issue-tec",
          identifier: "TEC-7",
          status: "blocked",
          assigneeAgentId: "agent-chiara",
          assigneeUserId: null,
          createdByAgentId: null,
          executionWorkspaceId: null,
          executionWorkspaceName: null,
          executionWorkspaceStrategy: null,
          executionWorkspaceBranch: null,
          projectWorkspaceId: null,
          projectWorkspaceName: null,
          projectWorkspaceRef: null,
          updatedAt: at("2026-09-01T12:04:00.000Z"),
        },
      ],
      relationRows: [{ blockerIssueId: "issue-mrphone", blockedIssueId: "issue-tec" }],
      activityRows: [
        {
          id: "activity-giorgia",
          agentId: "agent-giorgia",
          action: "issue.updated",
          entityType: "issue",
          entityId: "issue-mrphone",
          createdAt: at("2026-09-01T12:07:30.000Z"),
        },
      ],
      heartbeatEventRows: [
        {
          id: 91,
          runId: "run-giorgia",
          agentId: "agent-giorgia",
          eventType: "tool.completed",
          createdAt: at("2026-09-01T12:08:00.000Z"),
        },
      ],
      commentRows: [
        {
          id: "comment-handoff",
          issueId: "issue-mrphone",
          issueIdentifier: "MRP-42",
          issueStatus: "in_progress",
          authorAgentId: "agent-chiara",
          createdAt: at("2026-09-01T12:04:30.000Z"),
          body: "PRIVATE CUSTOMER CONTENT MUST NOT LEAK",
        } as Parameters<typeof assembleSessionObservability>[0]["commentRows"][number],
      ],
      interactionRows: [],
    };

    const result = assembleSessionObservability(input);

    expect(result.nodes.map((node) => node.agent.name)).toEqual([
      "Giorgia MrPhone",
      "Chiara TEC",
    ]);
    expect(result.nodes[0]).toMatchObject({
      status: "running",
      phase: "executing",
      owner: { label: "Giorgia MrPhone" },
      issue: { identifier: "MRP-42" },
      lane: { name: "Corsia MrPhone", branch: "candidate/mrphone-onboarding" },
      handoff: {
        kind: "comment",
        from: { name: "Chiara TEC" },
        receiptId: "comment-handoff",
        receiptState: "received",
      },
    });
    expect(result.nodes[1]).toMatchObject({
      status: "blocked",
      phase: "blocked",
      blocker: { state: "blocked", blockerCount: 1 },
    });
    expect(result.messages[0]).toMatchObject({
      from: { name: "Chiara TEC" },
      to: { name: "Giorgia MrPhone" },
      state: "received",
      runId: "run-giorgia",
    });
    expect(result.privacy).toEqual({
      contentIncluded: false,
      humanIdentityIncluded: false,
      secretsIncluded: false,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE CUSTOMER CONTENT");
    expect(JSON.stringify(result)).not.toContain("responsibleUserId");
  });

  it("maps terminal failures to error and successful delivery to an acknowledged receipt", () => {
    const input: Parameters<typeof assembleSessionObservability>[0] = {
      now: at("2026-09-01T12:10:00.000Z"),
      agentRows: [
        {
          id: "sender",
          name: "Sender",
          role: "manager",
          title: null,
          status: "idle",
          updatedAt: at("2026-09-01T12:00:00.000Z"),
        },
        {
          id: "receiver",
          name: "Receiver",
          role: "engineer",
          title: null,
          status: "idle",
          updatedAt: at("2026-09-01T12:00:00.000Z"),
        },
      ],
      runRows: [
        {
          id: "failed-run",
          agentId: "sender",
          status: "failed",
          retryOfRunId: null,
          continuationAttempt: 0,
          contextIssueId: null,
          contextCommentId: null,
          contextInteractionId: null,
          startedAt: at("2026-09-01T12:01:00.000Z"),
          finishedAt: at("2026-09-01T12:02:00.000Z"),
          createdAt: at("2026-09-01T12:01:00.000Z"),
          updatedAt: at("2026-09-01T12:02:00.000Z"),
        },
        {
          id: "receipt-run",
          agentId: "receiver",
          status: "succeeded",
          retryOfRunId: null,
          continuationAttempt: 0,
          contextIssueId: "issue-1",
          contextCommentId: "comment-1",
          contextInteractionId: null,
          startedAt: at("2026-09-01T12:03:00.000Z"),
          finishedAt: at("2026-09-01T12:04:00.000Z"),
          createdAt: at("2026-09-01T12:03:00.000Z"),
          updatedAt: at("2026-09-01T12:04:00.000Z"),
        },
      ],
      issueRows: [],
      relationRows: [],
      activityRows: [],
      heartbeatEventRows: [],
      commentRows: [{
        id: "comment-1",
        issueId: "issue-1",
        issueIdentifier: "PAP-1",
        issueStatus: "done",
        authorAgentId: "sender",
        createdAt: at("2026-09-01T12:02:30.000Z"),
      }],
      interactionRows: [],
    };

    const result = assembleSessionObservability(input);

    expect(result.nodes.find((node) => node.agent.id === "sender")?.status).toBe("error");
    expect(result.messages[0]).toMatchObject({ state: "acknowledged", runId: "receipt-run" });
  });

  it("never acknowledges rejected, cancelled, expired, or failed interactions", () => {
    const terminalAt = at("2026-09-01T12:06:00.000Z");
    const statuses = ["accepted", "answered", "rejected", "cancelled", "expired", "failed"] as const;
    const result = assembleSessionObservability(baseInput({
      agentRows: [testAgent("sender"), testAgent("receiver")],
      interactionRows: statuses.map((status, index) => ({
        id: `interaction-${status}`,
        issueId: "issue-1",
        issueIdentifier: "PAP-1",
        issueStatus: "in_progress",
        createdByAgentId: "sender",
        addresseeAgentId: "receiver",
        resolvedByAgentId: "receiver",
        resolvedByRunId: `run-${status}`,
        status,
        resolvedAt: terminalAt,
        createdAt: at(`2026-09-01T12:0${index}:00.000Z`),
      })),
    }));
    const receipts = new Map(result.messages.map((receipt) => [receipt.id, receipt]));

    for (const status of ["accepted", "answered"]) {
      expect(receipts.get(`interaction-${status}`)).toMatchObject({
        state: "acknowledged",
        acknowledgedAt: terminalAt,
      });
    }
    for (const status of ["rejected", "cancelled", "expired", "failed"]) {
      expect(receipts.get(`interaction-${status}`)).toMatchObject({
        state: "failed",
        acknowledgedAt: null,
      });
    }
  });

  it("uses receiving-run evidence for comments and leaves reassigned recipients unresolved", () => {
    const result = assembleSessionObservability(baseInput({
      agentRows: [testAgent("sender"), testAgent("original-receiver"), testAgent("current-assignee")],
      runRows: [testRun({
        id: "actual-receiving-run",
        agentId: "original-receiver",
        status: "succeeded",
        contextCommentId: "comment-with-evidence",
      })],
      issueRows: [testIssue("issue-1", "in_progress", "current-assignee", "2026-09-01T12:09:00.000Z")],
      commentRows: [
        {
          id: "comment-with-evidence",
          issueId: "issue-1",
          issueIdentifier: "PAP-1",
          issueStatus: "in_progress",
          authorAgentId: "sender",
          createdAt: at("2026-09-01T12:04:00.000Z"),
        },
        {
          id: "comment-after-reassignment",
          issueId: "issue-1",
          issueIdentifier: "PAP-1",
          issueStatus: "in_progress",
          authorAgentId: "sender",
          createdAt: at("2026-09-01T12:08:00.000Z"),
        },
      ],
    }));
    const receipts = new Map(result.messages.map((receipt) => [receipt.id, receipt]));

    expect(receipts.get("comment-with-evidence")).toMatchObject({
      to: { id: "original-receiver" },
      state: "acknowledged",
      runId: "actual-receiving-run",
    });
    expect(receipts.get("comment-after-reassignment")).toMatchObject({
      to: null,
      state: "recorded",
      runId: null,
      acknowledgedAt: null,
    });
  });

  it("selects active work deterministically ahead of newer backlog and queued work", () => {
    const result = assembleSessionObservability(baseInput({
      agentRows: [testAgent("assigned-agent"), testAgent("running-agent")],
      runRows: [
        testRun({
          id: "newer-queued-run",
          agentId: "running-agent",
          status: "queued",
          contextIssueId: "queued-backlog",
          updatedAt: "2026-09-01T12:09:00.000Z",
        }),
        testRun({
          id: "older-running-run",
          agentId: "running-agent",
          status: "running",
          contextIssueId: "running-progress",
          updatedAt: "2026-09-01T12:05:00.000Z",
        }),
      ],
      issueRows: [
        testIssue("new-backlog", "backlog", "assigned-agent", "2026-09-01T12:09:00.000Z"),
        testIssue("old-progress", "in_progress", "assigned-agent", "2026-09-01T12:01:00.000Z"),
        testIssue("queued-backlog", "backlog", "running-agent", "2026-09-01T12:09:00.000Z"),
        testIssue("running-progress", "in_progress", "running-agent", "2026-09-01T12:01:00.000Z"),
      ],
    }));

    expect(result.nodes.find((node) => node.agent.id === "assigned-agent")?.issue?.id).toBe("old-progress");
    expect(result.nodes.find((node) => node.agent.id === "running-agent")).toMatchObject({
      status: "running",
      phase: "executing",
      issue: { id: "running-progress" },
    });
  });

  it("replaces arbitrary heartbeat event types with a closed public label", () => {
    const sensitiveEventType = "prompt=/root/customer/acme token=TOKEN_LIKE_SENTINEL";
    const result = assembleSessionObservability(baseInput({
      agentRows: [testAgent("agent-1")],
      heartbeatEventRows: [{
        id: 1,
        runId: "run-1",
        agentId: "agent-1",
        eventType: sensitiveEventType,
        createdAt: at("2026-09-01T12:08:00.000Z"),
      }],
    }));
    const serialized = JSON.stringify(result);

    expect(result.nodes[0]?.lastEvent?.action).toBe("run.event");
    expect(serialized).not.toContain("TOKEN_LIKE_SENTINEL");
    expect(serialized).not.toContain("/root/customer/acme");
    expect(serialized).not.toContain("prompt=");
  });

  it("assembles high-volume bounded receipts within the polling budget", () => {
    const sourceCount = 12_000;
    const startedAt = performance.now();
    const result = assembleSessionObservability(baseInput({
      agentRows: [testAgent("sender")],
      heartbeatEventRows: Array.from({ length: sourceCount }, (_, index) => ({
        id: index + 1,
        runId: `run-${index}`,
        agentId: "sender",
        eventType: `prompt-token-${index}/private/path`,
        createdAt: at("2026-09-01T12:08:00.000Z"),
      })),
      commentRows: Array.from({ length: sourceCount }, (_, index) => ({
        id: `comment-${index}`,
        issueId: "issue-1",
        issueIdentifier: "PAP-1",
        issueStatus: "in_progress",
        authorAgentId: "sender",
        createdAt: at("2026-09-01T12:08:00.000Z"),
      })),
    }));
    const elapsedMs = performance.now() - startedAt;

    expect(result.messages).toHaveLength(24);
    expect(result.nodes[0]?.lastEvent?.action).toBe("run.event");
    expect(JSON.stringify(result)).not.toContain("prompt-token-");
    expect(elapsedMs).toBeLessThan(1_500);
  });
});
