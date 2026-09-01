import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  issueThreadInteractions,
  projectWorkspaces,
} from "@paperclipai/db";
import type {
  SessionAgentRef,
  SessionEventReceipt,
  SessionHandoffRef,
  SessionMessageReceipt,
  SessionObservabilityNode,
  SessionObservabilityPhase,
  SessionObservabilityResponse,
  SessionObservabilityStatus,
  SessionReceiptState,
} from "@paperclipai/shared";
import { and, desc, eq, gte, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";

const CURRENT_ISSUE_STATUS = "in_progress" as const;
const HIDDEN_AGENT_STATUSES = ["terminated", "pending_approval"] as const;
const LIVE_RUN_STATUSES = new Set(["queued", "scheduled_retry", "running"]);
const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
const POSITIVE_INTERACTION_STATUSES = new Set(["accepted", "answered"]);
const NEGATIVE_INTERACTION_STATUSES = new Set(["rejected", "cancelled", "expired", "failed"]);
const PUBLIC_HEARTBEAT_EVENT_TYPES = new Set([
  "adapter.invoke",
  "delegation.completed",
  "delegation.started",
  "delegation.updated",
  "done",
  "error",
  "harness.diagnostic",
  "item.completed",
  "item.started",
  "lifecycle",
  "output",
  "plan.updated",
  "provider.notice.recorded",
  "research.completed",
  "research.progressed",
  "research.started",
  "run.phase.timing",
  "run.result.proposed",
  "run.startup.step",
  "run.terminal",
  "runtime.diagnostic",
  "runtime_request.cancelled",
  "runtime_request.created",
  "runtime_request.expired",
  "runtime_request.resolved",
  "session.resumed",
  "session.started",
  "status",
  "tool.completed",
  "tool.execution.completed",
  "tool.execution.progressed",
  "tool.execution.started",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.started",
]);
const PUBLIC_ACTIVITY_ACTIONS = new Set([
  "agent.created",
  "agent.updated",
  "agent.status_updated",
  "issue.assigned",
  "issue.created",
  "issue.status_updated",
  "issue.updated",
]);
const PUBLIC_ACTIVITY_ENTITY_TYPES = new Set(["agent", "issue"]);
const MAX_AGENT_ROWS = 500;
const MAX_ISSUE_ROWS = 1_000;
const MAX_SOURCE_ROWS = 2_000;
const MAX_MESSAGE_ROWS = 200;
const MAX_RELATION_ROWS = 2_000;
const MAX_MESSAGE_RECEIPTS = 24;
const RECENT_SOURCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

type AgentRow = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  updatedAt: Date;
};

type RunRow = {
  id: string;
  agentId: string;
  status: string;
  retryOfRunId: string | null;
  continuationAttempt: number;
  contextIssueId: string | null;
  contextCommentId: string | null;
  contextInteractionId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type IssueRow = {
  id: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByAgentId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspaceName: string | null;
  executionWorkspaceStrategy: string | null;
  executionWorkspaceBranch: string | null;
  projectWorkspaceId: string | null;
  projectWorkspaceName: string | null;
  projectWorkspaceRef: string | null;
  updatedAt: Date;
};

type CommentRow = {
  id: string;
  issueId: string;
  issueIdentifier: string | null;
  issueStatus: string;
  authorAgentId: string;
  createdAt: Date;
};

type InteractionRow = {
  id: string;
  issueId: string;
  issueIdentifier: string | null;
  issueStatus: string;
  createdByAgentId: string;
  addresseeAgentId: string | null;
  resolvedByAgentId: string | null;
  resolvedByRunId: string | null;
  status: string;
  resolvedAt: Date | null;
  createdAt: Date;
};

function timeOf(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function agentRef(row: AgentRow): SessionAgentRef {
  return { id: row.id, name: row.name };
}

function receiptStateForRun(run: RunRow | undefined): SessionReceiptState {
  if (!run) return "recorded";
  if (run.status === "queued" || run.status === "scheduled_retry") return "queued";
  if (run.status === "running") return "received";
  if (run.status === "succeeded") return "acknowledged";
  return "failed";
}

function receiptStateForInteraction(status: string, run: RunRow | undefined): SessionReceiptState {
  if (status === "pending") return receiptStateForRun(run);
  if (POSITIVE_INTERACTION_STATUSES.has(status)) return "acknowledged";
  if (NEGATIVE_INTERACTION_STATUSES.has(status)) return "failed";
  return "recorded";
}

export function sanitizeSessionHeartbeatEventType(eventType: string): string {
  return PUBLIC_HEARTBEAT_EVENT_TYPES.has(eventType) ? eventType : "run.event";
}

export function sanitizeSessionActivityAction(action: string): string {
  return PUBLIC_ACTIVITY_ACTIONS.has(action) ? action : "activity.event";
}

export function sanitizeSessionActivityEntityType(entityType: string): string {
  return PUBLIC_ACTIVITY_ENTITY_TYPES.has(entityType) ? entityType : "entity";
}

function isNewerRun(candidate: RunRow, current: RunRow | undefined): boolean {
  if (!current) return true;
  return timeOf(candidate.updatedAt) > timeOf(current.updatedAt)
    || (timeOf(candidate.updatedAt) === timeOf(current.updatedAt)
      && (timeOf(candidate.createdAt) > timeOf(current.createdAt)
        || (timeOf(candidate.createdAt) === timeOf(current.createdAt)
          && candidate.id.localeCompare(current.id) < 0)));
}

function liveRunRank(status: string): number {
  if (status === "running") return 0;
  if (status === "queued") return 1;
  return 2;
}

function isPreferredLiveRun(candidate: RunRow, current: RunRow | undefined): boolean {
  if (!current) return true;
  return liveRunRank(candidate.status) < liveRunRank(current.status)
    || (liveRunRank(candidate.status) === liveRunRank(current.status) && isNewerRun(candidate, current));
}

const ISSUE_ACTIVITY_RANK: Record<string, number> = {
  in_progress: 0,
  blocked: 1,
  in_review: 2,
  todo: 3,
  backlog: 4,
};

function isPreferredAssignedIssue(candidate: IssueRow, current: IssueRow | undefined): boolean {
  if (!current) return true;
  const candidateRank = ISSUE_ACTIVITY_RANK[candidate.status] ?? Number.MAX_SAFE_INTEGER;
  const currentRank = ISSUE_ACTIVITY_RANK[current.status] ?? Number.MAX_SAFE_INTEGER;
  return candidateRank < currentRank
    || (candidateRank === currentRank
      && (timeOf(candidate.updatedAt) > timeOf(current.updatedAt)
        || (timeOf(candidate.updatedAt) === timeOf(current.updatedAt)
          && candidate.id.localeCompare(current.id) < 0)));
}

function phaseForNode(input: {
  liveRun?: RunRow;
  latestRun?: RunRow;
  issue?: IssueRow;
  blockerCount: number;
  agentStatus: string;
}): SessionObservabilityPhase {
  if (input.liveRun?.status === "running") return "executing";
  if (input.liveRun) return "queued";
  if (input.issue?.status === "blocked" || input.blockerCount > 0) return "blocked";
  if (input.agentStatus === "error" || (input.latestRun && FAILED_RUN_STATUSES.has(input.latestRun.status))) {
    return "error";
  }
  if (input.issue?.status === "in_review") return "review";
  if (input.issue?.status === "todo" || input.issue?.status === "backlog") return "queued";
  if (input.issue?.status === "in_progress" || input.agentStatus === "paused") return "waiting";
  return "idle";
}

function statusForNode(input: {
  liveRun?: RunRow;
  latestRun?: RunRow;
  issue?: IssueRow;
  blockerCount: number;
  agentStatus: string;
}): SessionObservabilityStatus {
  if (input.liveRun) return "running";
  if (input.issue?.status === "blocked" || input.blockerCount > 0) return "blocked";
  if (input.agentStatus === "error" || (input.latestRun && FAILED_RUN_STATUSES.has(input.latestRun.status))) {
    return "error";
  }
  return "idle";
}

function laneForIssue(issue: IssueRow | undefined) {
  if (!issue) return null;
  if (issue.executionWorkspaceId && issue.executionWorkspaceName && issue.executionWorkspaceStrategy) {
    return {
      workspaceId: issue.executionWorkspaceId,
      name: issue.executionWorkspaceName,
      strategy: issue.executionWorkspaceStrategy,
      branch: issue.executionWorkspaceBranch,
    };
  }
  if (issue.projectWorkspaceId && issue.projectWorkspaceName) {
    return {
      workspaceId: issue.projectWorkspaceId,
      name: issue.projectWorkspaceName,
      strategy: "project_workspace",
      branch: issue.projectWorkspaceRef,
    };
  }
  return null;
}

function pickLatestEvent(
  activity: SessionEventReceipt | undefined,
  heartbeatEvent: SessionEventReceipt | undefined,
): SessionEventReceipt | null {
  if (!activity) return heartbeatEvent ?? null;
  if (!heartbeatEvent) return activity;
  return timeOf(activity.occurredAt) >= timeOf(heartbeatEvent.occurredAt) ? activity : heartbeatEvent;
}

export function assembleSessionObservability(input: {
  agentRows: AgentRow[];
  runRows: RunRow[];
  issueRows: IssueRow[];
  relationRows: Array<{ blockerIssueId: string; blockedIssueId: string }>;
  activityRows: Array<{
    id: string;
    agentId: string;
    action: string;
    entityType: string;
    createdAt: Date;
  }>;
  heartbeatEventRows: Array<{
    id: number;
    runId: string;
    agentId: string;
    eventType: string;
    createdAt: Date;
  }>;
  commentRows: CommentRow[];
  interactionRows: InteractionRow[];
  now?: Date;
}): SessionObservabilityResponse {
  const generatedAt = input.now ?? new Date();
  const agentsById = new Map(input.agentRows.map((row) => [row.id, row]));
  const currentIssueRows = input.issueRows.filter((row) => row.status === CURRENT_ISSUE_STATUS);
  const issuesById = new Map(currentIssueRows.map((row) => [row.id, row]));
  const latestRunByAgent = new Map<string, RunRow>();
  const liveRunByAgent = new Map<string, RunRow>();
  const runByCommentId = new Map<string, RunRow>();
  const runByInteractionId = new Map<string, RunRow>();

  for (const run of input.runRows) {
    if (isNewerRun(run, latestRunByAgent.get(run.agentId))) {
      latestRunByAgent.set(run.agentId, run);
    }
    if (LIVE_RUN_STATUSES.has(run.status) && isPreferredLiveRun(run, liveRunByAgent.get(run.agentId))) {
      liveRunByAgent.set(run.agentId, run);
    }
    if (run.contextCommentId && isNewerRun(run, runByCommentId.get(run.contextCommentId))) {
      runByCommentId.set(run.contextCommentId, run);
    }
    if (run.contextInteractionId && isNewerRun(run, runByInteractionId.get(run.contextInteractionId))) {
      runByInteractionId.set(run.contextInteractionId, run);
    }
  }

  const assignedIssueByAgent = new Map<string, IssueRow>();
  for (const issue of currentIssueRows) {
    if (issue.assigneeAgentId && isPreferredAssignedIssue(issue, assignedIssueByAgent.get(issue.assigneeAgentId))) {
      assignedIssueByAgent.set(issue.assigneeAgentId, issue);
    }
  }

  const blockerCountByIssue = new Map<string, number>();
  for (const relation of input.relationRows) {
    blockerCountByIssue.set(
      relation.blockedIssueId,
      (blockerCountByIssue.get(relation.blockedIssueId) ?? 0) + 1,
    );
  }

  const messages: SessionMessageReceipt[] = [];
  for (const comment of input.commentRows) {
    const from = agentsById.get(comment.authorAgentId);
    if (!from) continue;
    const receivingRun = runByCommentId.get(comment.id);
    const recipient = receivingRun ? agentsById.get(receivingRun.agentId) : undefined;
    if (recipient?.id === from.id) continue;
    const state = recipient ? receiptStateForRun(receivingRun) : "recorded";
    messages.push({
      id: comment.id,
      source: "comment",
      from: agentRef(from),
      to: recipient ? agentRef(recipient) : null,
      issue: {
        id: comment.issueId,
        identifier: comment.issueIdentifier,
        status: comment.issueStatus,
      },
      state,
      runId: receivingRun?.id ?? null,
      createdAt: comment.createdAt,
      acknowledgedAt: state === "acknowledged"
        ? receivingRun?.finishedAt ?? receivingRun?.updatedAt ?? null
        : null,
    });
  }

  for (const interaction of input.interactionRows) {
    const from = agentsById.get(interaction.createdByAgentId);
    if (!from) continue;
    const receivingRun = runByInteractionId.get(interaction.id);
    const recipientId = interaction.addresseeAgentId
      ?? interaction.resolvedByAgentId
      ?? receivingRun?.agentId;
    const recipient = recipientId ? agentsById.get(recipientId) : undefined;
    if (recipient?.id === from.id) continue;
    const state = receiptStateForInteraction(interaction.status, receivingRun);
    messages.push({
      id: interaction.id,
      source: "interaction",
      from: agentRef(from),
      to: recipient ? agentRef(recipient) : null,
      issue: {
        id: interaction.issueId,
        identifier: interaction.issueIdentifier,
        status: interaction.issueStatus,
      },
      state,
      runId: interaction.status === "pending"
        ? receivingRun?.id ?? null
        : interaction.resolvedByRunId ?? null,
      createdAt: interaction.createdAt,
      acknowledgedAt: state === "acknowledged" ? interaction.resolvedAt : null,
    });
  }

  messages.sort((left, right) => timeOf(right.createdAt) - timeOf(left.createdAt));
  const boundedMessages = messages.slice(0, MAX_MESSAGE_RECEIPTS);
  const receiptById = new Map(messages.map((receipt) => [receipt.id, receipt]));
  const lastReceiptByAgent = new Map<string, SessionMessageReceipt>();
  for (const receipt of messages) {
    if (!lastReceiptByAgent.has(receipt.from.id)) lastReceiptByAgent.set(receipt.from.id, receipt);
    if (receipt.to && !lastReceiptByAgent.has(receipt.to.id)) lastReceiptByAgent.set(receipt.to.id, receipt);
  }

  const lastActivityByAgent = new Map<string, SessionEventReceipt>();
  for (const row of input.activityRows) {
    if (lastActivityByAgent.has(row.agentId)) continue;
    lastActivityByAgent.set(row.agentId, {
      id: row.id,
      source: "activity",
      action: sanitizeSessionActivityAction(row.action),
      entityType: sanitizeSessionActivityEntityType(row.entityType),
      entityId: null,
      occurredAt: row.createdAt,
    });
  }

  const lastHeartbeatEventByAgent = new Map<string, SessionEventReceipt>();
  for (const row of input.heartbeatEventRows) {
    if (lastHeartbeatEventByAgent.has(row.agentId)) continue;
    lastHeartbeatEventByAgent.set(row.agentId, {
      id: String(row.id),
      source: "heartbeat_event",
      action: sanitizeSessionHeartbeatEventType(row.eventType),
      entityType: "heartbeat_run",
      entityId: row.runId,
      occurredAt: row.createdAt,
    });
  }

  const nodes: SessionObservabilityNode[] = input.agentRows
    .filter((agent) => agent.status !== "terminated" && agent.status !== "pending_approval")
    .map((agent) => {
      const liveRun = liveRunByAgent.get(agent.id);
      const latestRun = latestRunByAgent.get(agent.id);
      const issue = (liveRun?.contextIssueId ? issuesById.get(liveRun.contextIssueId) : undefined)
        ?? assignedIssueByAgent.get(agent.id);
      const blockerCount = issue ? blockerCountByIssue.get(issue.id) ?? 0 : 0;
      const status = statusForNode({ liveRun, latestRun, issue, blockerCount, agentStatus: agent.status });
      const phase = phaseForNode({ liveRun, latestRun, issue, blockerCount, agentStatus: agent.status });
      const currentRun = liveRun ?? latestRun;
      let handoff: SessionHandoffRef | null = null;

      if (currentRun?.contextCommentId) {
        const receipt = receiptById.get(currentRun.contextCommentId);
        handoff = {
          kind: "comment",
          from: receipt?.from ?? null,
          receiptId: currentRun.contextCommentId,
          receiptState: receipt?.state ?? null,
          runId: currentRun.id,
          occurredAt: receipt?.createdAt ?? currentRun.createdAt,
        };
      } else if (currentRun?.contextInteractionId) {
        const receipt = receiptById.get(currentRun.contextInteractionId);
        handoff = {
          kind: "interaction",
          from: receipt?.from ?? null,
          receiptId: currentRun.contextInteractionId,
          receiptState: receipt?.state ?? null,
          runId: currentRun.id,
          occurredAt: receipt?.createdAt ?? currentRun.createdAt,
        };
      } else if (currentRun?.retryOfRunId) {
        handoff = {
          kind: currentRun.continuationAttempt > 0 ? "continuation" : "retry",
          from: null,
          receiptId: currentRun.retryOfRunId,
          receiptState: currentRun.status === "succeeded" ? "acknowledged" : receiptStateForRun(currentRun),
          runId: currentRun.id,
          occurredAt: currentRun.createdAt,
        };
      } else if (issue?.createdByAgentId && issue.createdByAgentId !== agent.id) {
        const from = agentsById.get(issue.createdByAgentId);
        handoff = {
          kind: "assignment",
          from: from ? agentRef(from) : null,
          receiptId: issue.id,
          receiptState: liveRun ? receiptStateForRun(liveRun) : "recorded",
          runId: liveRun?.id ?? null,
          occurredAt: issue.updatedAt,
        };
      }

      const lastEvent = pickLatestEvent(
        lastActivityByAgent.get(agent.id),
        lastHeartbeatEventByAgent.get(agent.id),
      );
      const updatedAt = [
        agent.updatedAt,
        latestRun?.updatedAt,
        issue?.updatedAt,
        lastEvent?.occurredAt,
      ].reduce<Date | string>((latest, value) => (
        value && timeOf(value) > timeOf(latest) ? value : latest
      ), agent.updatedAt);

      return {
        agent: {
          ...agentRef(agent),
          role: agent.role,
          title: agent.title,
        },
        status,
        phase,
        owner: issue?.assigneeAgentId
          ? {
              kind: "agent" as const,
              agentId: issue.assigneeAgentId,
              label: agentsById.get(issue.assigneeAgentId)?.name ?? agent.name,
            }
          : issue?.assigneeUserId
            ? { kind: "board" as const, agentId: null, label: "Board" }
            : { kind: "agent" as const, agentId: agent.id, label: agent.name },
        issue: issue
          ? { id: issue.id, identifier: issue.identifier, status: issue.status }
          : null,
        lane: laneForIssue(issue),
        blocker: {
          state: issue?.status === "blocked" || blockerCount > 0
            ? "blocked" as const
            : "clear" as const,
          issueIdentifier: issue?.identifier ?? null,
          blockerCount,
        },
        lastEvent,
        handoff,
        lastReceipt: lastReceiptByAgent.get(agent.id) ?? null,
        updatedAt,
      };
    })
    .sort((left, right) => {
      const rank: Record<SessionObservabilityStatus, number> = {
        running: 0,
        blocked: 1,
        error: 2,
        idle: 3,
      };
      return rank[left.status] - rank[right.status]
        || timeOf(right.updatedAt) - timeOf(left.updatedAt)
        || left.agent.name.localeCompare(right.agent.name);
    });

  return {
    generatedAt,
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
    nodes,
    messages: boundedMessages,
  };
}

export function sessionObservabilityService(db: Db) {
  async function read(companyId: string): Promise<SessionObservabilityResponse> {
    const runContextIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const runContextCommentId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`;
    const runContextInteractionId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'interactionId'`;

    const recentCutoff = new Date(Date.now() - RECENT_SOURCE_WINDOW_MS);
    const [agentRows, runRows, issueRows, activityRows, heartbeatEventRows, commentRows, interactionRows] = await Promise.all([
      db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          title: agents.title,
          status: agents.status,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .where(and(
          eq(agents.companyId, companyId),
          notInArray(agents.status, [...HIDDEN_AGENT_STATUSES]),
        ))
        .orderBy(agents.status, agents.id)
        .limit(MAX_AGENT_ROWS),
      db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          retryOfRunId: heartbeatRuns.retryOfRunId,
          continuationAttempt: heartbeatRuns.continuationAttempt,
          contextIssueId: runContextIssueId,
          contextCommentId: runContextCommentId,
          contextInteractionId: runContextInteractionId,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
          updatedAt: heartbeatRuns.updatedAt,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          gte(heartbeatRuns.createdAt, recentCutoff),
        ))
        .orderBy(desc(heartbeatRuns.createdAt), heartbeatRuns.id)
        .limit(MAX_SOURCE_ROWS),
      db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          createdByAgentId: issues.createdByAgentId,
          executionWorkspaceId: executionWorkspaces.id,
          executionWorkspaceName: executionWorkspaces.name,
          executionWorkspaceStrategy: executionWorkspaces.strategyType,
          executionWorkspaceBranch: executionWorkspaces.branchName,
          projectWorkspaceId: projectWorkspaces.id,
          projectWorkspaceName: projectWorkspaces.name,
          projectWorkspaceRef: projectWorkspaces.repoRef,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .leftJoin(
          executionWorkspaces,
          and(
            eq(executionWorkspaces.companyId, issues.companyId),
            eq(executionWorkspaces.id, issues.executionWorkspaceId),
          ),
        )
        .leftJoin(
          projectWorkspaces,
          and(
            eq(projectWorkspaces.companyId, issues.companyId),
            eq(projectWorkspaces.id, issues.projectWorkspaceId),
          ),
        )
        .where(and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          eq(issues.status, CURRENT_ISSUE_STATUS),
        ))
        .orderBy(desc(issues.updatedAt), issues.id)
        .limit(MAX_ISSUE_ROWS),
      db
        .select({
          id: activityLog.id,
          agentId: activityLog.agentId,
          action: activityLog.action,
          entityType: activityLog.entityType,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, companyId),
          isNotNull(activityLog.agentId),
          gte(activityLog.createdAt, recentCutoff),
        ))
        .orderBy(desc(activityLog.createdAt), activityLog.id)
        .limit(MAX_SOURCE_ROWS),
      db
        .select({
          id: heartbeatRunEvents.id,
          runId: heartbeatRunEvents.runId,
          agentId: heartbeatRunEvents.agentId,
          eventType: heartbeatRunEvents.eventType,
          createdAt: heartbeatRunEvents.createdAt,
        })
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.companyId, companyId),
          gte(heartbeatRunEvents.createdAt, recentCutoff),
        ))
        .orderBy(desc(heartbeatRunEvents.createdAt), desc(heartbeatRunEvents.id))
        .limit(MAX_SOURCE_ROWS),
      db
        .select({
          id: issueComments.id,
          issueId: issues.id,
          issueIdentifier: issues.identifier,
          issueStatus: issues.status,
          authorAgentId: issueComments.authorAgentId,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .innerJoin(issues, and(eq(issues.companyId, issueComments.companyId), eq(issues.id, issueComments.issueId)))
        .where(and(
          eq(issueComments.companyId, companyId),
          isNotNull(issueComments.authorAgentId),
          isNull(issueComments.deletedAt),
          gte(issueComments.createdAt, recentCutoff),
        ))
        .orderBy(desc(issueComments.createdAt), issueComments.id)
        .limit(MAX_MESSAGE_ROWS),
      db
        .select({
          id: issueThreadInteractions.id,
          issueId: issues.id,
          issueIdentifier: issues.identifier,
          issueStatus: issues.status,
          createdByAgentId: issueThreadInteractions.createdByAgentId,
          addresseeAgentId: issueThreadInteractions.addresseeAgentId,
          resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
          resolvedByRunId: issueThreadInteractions.resolvedByRunId,
          status: issueThreadInteractions.status,
          resolvedAt: issueThreadInteractions.resolvedAt,
          createdAt: issueThreadInteractions.createdAt,
        })
        .from(issueThreadInteractions)
        .innerJoin(
          issues,
          and(eq(issues.companyId, issueThreadInteractions.companyId), eq(issues.id, issueThreadInteractions.issueId)),
        )
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          isNotNull(issueThreadInteractions.createdByAgentId),
          gte(issueThreadInteractions.createdAt, recentCutoff),
        ))
        .orderBy(desc(issueThreadInteractions.createdAt), issueThreadInteractions.id)
        .limit(MAX_MESSAGE_ROWS),
    ]);

    const issueIds = issueRows.map((issue) => issue.id);
    const relationRows = issueIds.length === 0
      ? []
      : await db
        .select({
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, issueIds),
        ))
        .orderBy(issueRelations.relatedIssueId, issueRelations.issueId)
        .limit(MAX_RELATION_ROWS);

    return assembleSessionObservability({
      agentRows,
      runRows,
      issueRows,
      relationRows,
      activityRows: activityRows as Array<{
        id: string;
        agentId: string;
        action: string;
        entityType: string;
        createdAt: Date;
      }>,
      heartbeatEventRows,
      commentRows: commentRows as CommentRow[],
      interactionRows: interactionRows as InteractionRow[],
    });
  }

  return { read };
}
