export type SessionObservabilityStatus = "running" | "idle" | "blocked" | "error";

export type SessionObservabilityPhase =
  | "queued"
  | "executing"
  | "waiting"
  | "review"
  | "blocked"
  | "error"
  | "idle";

export type SessionReceiptState =
  | "recorded"
  | "queued"
  | "received"
  | "acknowledged"
  | "failed";

export interface SessionAgentRef {
  id: string;
  name: string;
}

export interface SessionOwnerRef {
  kind: "agent" | "board";
  agentId: string | null;
  label: string;
}

export interface SessionIssueRef {
  id: string;
  identifier: string | null;
  status: string;
}

export interface SessionLaneRef {
  workspaceId: string;
  name: string;
  strategy: string;
  branch: string | null;
}

export interface SessionEventReceipt {
  id: string;
  source: "activity" | "heartbeat_event";
  action: string;
  entityType: string;
  /** Raw activity entity identifiers are intentionally never exposed. */
  entityId: string | null;
  occurredAt: Date | string;
}

export interface SessionBlockerRef {
  state: "clear" | "blocked";
  issueIdentifier: string | null;
  blockerCount: number;
}

export interface SessionCostRef {
  /** Cumulative billed cost recorded by Paperclip for this agent. */
  totalCostCents: number;
}

export interface SessionMessageReceipt {
  id: string;
  source: "comment" | "interaction";
  from: SessionAgentRef;
  /** Null when no persisted addressee, resolver, or receiving run proves the recipient. */
  to: SessionAgentRef | null;
  issue: SessionIssueRef;
  state: SessionReceiptState;
  runId: string | null;
  createdAt: Date | string;
  acknowledgedAt: Date | string | null;
}

export interface SessionHandoffRef {
  kind: "assignment" | "comment" | "interaction" | "continuation" | "retry";
  from: SessionAgentRef | null;
  receiptId: string | null;
  receiptState: SessionReceiptState | null;
  runId: string | null;
  occurredAt: Date | string | null;
}

export interface SessionObservabilityNode {
  agent: SessionAgentRef & {
    role: string;
    title: string | null;
  };
  status: SessionObservabilityStatus;
  phase: SessionObservabilityPhase;
  owner: SessionOwnerRef;
  issue: SessionIssueRef | null;
  lane: SessionLaneRef | null;
  blocker: SessionBlockerRef;
  cost: SessionCostRef;
  lastEvent: SessionEventReceipt | null;
  handoff: SessionHandoffRef | null;
  lastReceipt: SessionMessageReceipt | null;
  updatedAt: Date | string;
}

export interface SessionObservabilityResponse {
  generatedAt: Date | string;
  sourceTables: readonly [
    "agents",
    "agent_runtime_state",
    "heartbeat_runs",
    "heartbeat_run_events",
    "activity_log",
    "issues",
    "issue_relations",
    "issue_comments",
    "issue_thread_interactions",
    "execution_workspaces",
    "project_workspaces",
  ];
  privacy: {
    contentIncluded: false;
    humanIdentityIncluded: false;
    secretsIncluded: false;
  };
  nodes: SessionObservabilityNode[];
  messages: SessionMessageReceipt[];
}
