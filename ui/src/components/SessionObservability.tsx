import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  SessionMessageReceipt,
  SessionObservabilityNode,
  SessionObservabilityPhase,
  SessionObservabilityStatus,
  SessionReceiptState,
} from "@paperclipai/shared";
import { Activity, GitBranch, MessageSquare, RefreshCw, ShieldCheck, UsersRound } from "lucide-react";
import { sessionObservabilityApi } from "../api/sessionObservability";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { Link } from "../lib/router";
import { EmptyState } from "./EmptyState";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

const STATUS_LABELS: Record<SessionObservabilityStatus, string> = {
  running: "In esecuzione",
  idle: "In attesa",
  blocked: "Bloccato",
  error: "Errore",
};

const PHASE_LABELS: Record<SessionObservabilityPhase, string> = {
  queued: "In coda",
  executing: "Esecuzione",
  waiting: "In attesa",
  review: "Revisione",
  blocked: "Blocco",
  error: "Errore",
  idle: "Disponibile",
};

const RECEIPT_LABELS: Record<SessionReceiptState, string> = {
  recorded: "Registrata",
  queued: "In consegna",
  received: "Ricevuta",
  acknowledged: "Confermata",
  failed: "Fallita",
};

function compactId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function eventLabel(value: string): string {
  return value.replace(/[._-]+/g, " ");
}

function ReceiptBadge({ receipt }: { receipt: SessionMessageReceipt | null }) {
  if (!receipt) return <span className="text-muted-foreground">Nessuna</span>;
  return <StatusBadge status={receipt.state} label={RECEIPT_LABELS[receipt.state]} />;
}

function NodeCard({ node }: { node: SessionObservabilityNode }) {
  return (
    <Card className="gap-4 py-4" data-testid={`session-node-${node.agent.name}`}>
      <CardHeader className="gap-3 px-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{node.agent.name}</CardTitle>
            <CardDescription className="mt-1 truncate">
              {node.agent.title ?? node.agent.role}
            </CardDescription>
          </div>
          <StatusBadge status={node.status} label={STATUS_LABELS[node.status]} />
        </div>
        {node.issue ? (
          <Link
            to={`/issues/${node.issue.id}`}
            className="font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            {node.issue.identifier ?? compactId(node.issue.id)} · {eventLabel(node.issue.status)}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">Nessun task operativo</span>
        )}
      </CardHeader>

      <CardContent className="space-y-4 px-4">
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt className="text-muted-foreground">Owner</dt>
            <dd className="mt-1 font-medium">{node.owner.label}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Fase</dt>
            <dd className="mt-1 font-medium">{PHASE_LABELS[node.phase]}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Blocco</dt>
            <dd className="mt-1">
              {node.blocker.state === "blocked" ? (
                <StatusBadge
                  status="blocked"
                  label={node.blocker.blockerCount > 0 ? `${node.blocker.blockerCount} dipendenze` : "Task bloccato"}
                />
              ) : (
                <span className="font-medium">Libero</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Ricevuta</dt>
            <dd className="mt-1"><ReceiptBadge receipt={node.lastReceipt} /></dd>
          </div>
        </dl>

        <div className="space-y-2 border-t border-border pt-3 text-xs">
          <div className="flex items-start gap-2">
            <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-muted-foreground">Corsia / worktree</div>
              <div className="truncate font-medium">
                {node.lane ? node.lane.name : "Corsia condivisa"}
              </div>
              {node.lane?.branch ? (
                <div className="truncate font-mono text-muted-foreground">{node.lane.branch}</div>
              ) : null}
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-muted-foreground">Ultimo evento</div>
              {node.lastEvent ? (
                <div className="truncate">
                  <span className="font-medium">{eventLabel(node.lastEvent.action)}</span>
                  <span className="text-muted-foreground"> · {relativeTime(node.lastEvent.occurredAt)}</span>
                  <span className="ml-1 font-mono text-muted-foreground">#{compactId(node.lastEvent.id)}</span>
                </div>
              ) : (
                <div className="font-medium">Nessun evento</div>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2">
            <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-muted-foreground">Handoff contesto</div>
              {node.handoff ? (
                <div className="truncate">
                  <span className="font-medium">{eventLabel(node.handoff.kind)}</span>
                  {node.handoff.from ? <span> da {node.handoff.from.name}</span> : null}
                  {node.handoff.receiptId ? (
                    <span className="ml-1 font-mono text-muted-foreground">#{compactId(node.handoff.receiptId)}</span>
                  ) : null}
                </div>
              ) : (
                <div className="font-medium">Nessun handoff</div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MessageReceiptRow({ receipt }: { receipt: SessionMessageReceipt }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">
          {receipt.from.name} → {receipt.to.name}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{receipt.source === "comment" ? "Commento task" : "Interazione task"}</span>
          <Link to={`/issues/${receipt.issue.id}`} className="font-mono hover:text-foreground">
            {receipt.issue.identifier ?? compactId(receipt.issue.id)}
          </Link>
          <span>{relativeTime(receipt.createdAt)}</span>
          <span className="font-mono">#{compactId(receipt.id)}</span>
        </div>
      </div>
      <StatusBadge status={receipt.state} label={RECEIPT_LABELS[receipt.state]} />
    </div>
  );
}

export function SessionObservability({ companyId }: { companyId: string }) {
  const query = useQuery({
    queryKey: queryKeys.agents.sessionObservability(companyId),
    queryFn: () => sessionObservabilityApi.get(companyId),
    refetchInterval: 10_000,
  });

  const counts = useMemo(() => {
    const result: Record<SessionObservabilityStatus, number> = {
      running: 0,
      idle: 0,
      blocked: 0,
      error: 0,
    };
    for (const node of query.data?.nodes ?? []) result[node.status] += 1;
    return result;
  }, [query.data?.nodes]);

  if (query.isLoading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Caricamento sessioni Paperclip…</div>;
  }

  if (query.error) {
    return (
      <div className="space-y-3 py-8 text-center">
        <p className="text-sm text-destructive">{query.error.message}</p>
        <Button size="sm" variant="outline" onClick={() => query.refetch()}>Riprova</Button>
      </div>
    );
  }

  const data = query.data;
  if (!data || data.nodes.length === 0) {
    return <EmptyState icon={UsersRound} message="Nessuna sessione agente disponibile." />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            Regia sessioni Paperclip
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Solo metadati operativi: contenuti, prompt, identità umane e segreti restano esclusi.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => query.refetch()}
        >
          <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
          Aggiorna
        </Button>
      </div>

      <div className="flex flex-wrap gap-2" aria-label="Riepilogo stati sessione">
        {(Object.keys(counts) as SessionObservabilityStatus[]).map((status) => (
          <StatusBadge key={status} status={status} label={`${STATUS_LABELS[status]} ${counts[status]}`} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {data.nodes.map((node) => <NodeCard key={node.agent.id} node={node} />)}
      </div>

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Messaggi tra agenti con ricevuta</CardTitle>
          <CardDescription>
            Le righe derivano da commenti e interazioni Paperclip; il contenuto non viene letto né restituito.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {data.messages.length > 0 ? (
            data.messages.map((receipt) => <MessageReceiptRow key={`${receipt.source}-${receipt.id}`} receipt={receipt} />)
          ) : (
            <p className="py-4 text-sm text-muted-foreground">Nessun passaggio tra agenti registrato.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
