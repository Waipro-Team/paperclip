import { describe, expect, it } from "vitest";
import { assembleSessionObservability } from "../services/session-observability.js";

const at = (value: string) => new Date(value);

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
          recipientAgentId: "agent-giorgia",
          createdByRunId: "run-chiara",
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
        recipientAgentId: "receiver",
        createdByRunId: "source-run",
        createdAt: at("2026-09-01T12:02:30.000Z"),
      }],
      interactionRows: [],
    };

    const result = assembleSessionObservability(input);

    expect(result.nodes.find((node) => node.agent.id === "sender")?.status).toBe("error");
    expect(result.messages[0]).toMatchObject({ state: "acknowledged", runId: "receipt-run" });
  });
});
