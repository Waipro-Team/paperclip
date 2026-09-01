import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  regiaIntakeRequestSchema,
  type Agent,
  type Project,
  type ProjectWorkspace,
  type RegiaIntakeRequest,
  type RegiaIntakeResponse,
} from "@paperclipai/shared";
import { Flag, Link2, ShieldCheck } from "lucide-react";
import { ApiError } from "../api/client";
import { environmentsApi } from "../api/environments";
import { projectsApi } from "../api/projects";
import { regiaIntakeApi } from "../api/regiaIntake";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "../lib/router";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";

interface RegiaProjectCandidate {
  project: Project;
  environmentId: string;
  environmentName: string;
}

interface RegiaProjectBinding extends RegiaProjectCandidate {
  workspaceId: string;
  workspaceName: string;
}

function normalizedIdentity(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase("it-IT").replace(/[^a-z0-9]+/g, " ").trim() ?? "";
}

export function isRegiaCandidate(agent: Agent): boolean {
  const catalogRole = normalizedIdentity(
    typeof agent.metadata?.catalogRoleKey === "string" ? agent.metadata.catalogRoleKey : null,
  );
  const identities = [agent.name, agent.title].map(normalizedIdentity);
  const hasIdentity =
    normalizedIdentity(agent.role) === "ceo" ||
    normalizedIdentity(agent.role) === "executive" ||
    catalogRole === "fleet director" ||
    catalogRole === "director pmo control room" ||
    identities.includes("regia") ||
    identities.includes("fleet director") ||
    identities.includes("director pmo control room");
  return (
    agent.reportsTo === null &&
    hasIdentity &&
    (agent.status === "active" || agent.status === "idle" || agent.status === "running")
  );
}

export function regiaProjectCandidate(
  project: Project,
  environments: Awaited<ReturnType<typeof environmentsApi.list>>,
  regiaAgent: Agent,
): RegiaProjectCandidate | null {
  if (project.archivedAt) return null;
  const environmentId = project.executionWorkspacePolicy?.environmentId;
  if (!environmentId || regiaAgent.defaultEnvironmentId !== environmentId) return null;
  const environment = environments.find(
    (candidate) =>
      candidate.id === environmentId &&
      candidate.status === "active" &&
      candidate.driver === "sandbox",
  );
  if (!environment) return null;

  return {
    project,
    environmentId,
    environmentName: environment.name,
  };
}

export function regiaProjectBinding(
  candidate: RegiaProjectCandidate,
  workspaces: ProjectWorkspace[],
): RegiaProjectBinding | null {
  const preferredWorkspaceId = candidate.project.executionWorkspacePolicy?.defaultProjectWorkspaceId;
  const workspace =
    (preferredWorkspaceId
      ? workspaces.find((item) => item.id === preferredWorkspaceId)
      : null) ??
    workspaces.find((item) => item.isPrimary) ??
    (workspaces.length === 1 ? workspaces[0] : null);
  if (!workspace) return null;
  return {
    ...candidate,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  };
}

function createIdempotencyKey(): string {
  const suffix =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `board:regia:${suffix}`;
}

function safeMutationMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Non è stato possibile registrare l’obiettivo.";
  if (error.status === 401 || error.status === 403) {
    return "Non hai accesso alla Regia di questa organizzazione. Aggiorna l’accesso e riprova.";
  }
  if (error.status === 400) return "La richiesta non è valida. Controlla i campi e riprova.";
  if (error.status === 409) {
    return "Questo invio non può essere riutilizzato con dati diversi. Riprova come nuovo obiettivo.";
  }
  if (error.status === 422) return "La configurazione protetta della Regia è incompleta o non valida.";
  return "Non è stato possibile registrare l’obiettivo.";
}

function ResultChain({
  result,
  projectName,
}: {
  result: RegiaIntakeResponse;
  projectName: string | null;
}) {
  return (
    <div className="space-y-4" data-testid="regia-objective-result">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status="blocked" label="Bloccato: configurazione policy richiesta" />
        <span className="text-xs text-muted-foreground">
          {result.created ? "Obiettivo registrato" : "Obiettivo già registrato"}
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-3" aria-label="Catena operativa creata">
        <Link
          to={`/goals/${result.goalId}`}
          className="rounded-md border border-border px-3 py-2 no-underline transition-colors hover:bg-accent/50"
        >
          <span className="block text-xs text-muted-foreground">Goal</span>
          <span className="mt-1 block truncate text-xs text-foreground">Goal operativo</span>
        </Link>
        <Link
          to={`/projects/${result.projectId}`}
          className="rounded-md border border-border px-3 py-2 no-underline transition-colors hover:bg-accent/50"
        >
          <span className="block text-xs text-muted-foreground">Progetto</span>
          <span className="mt-1 block truncate text-xs text-foreground">{projectName ?? "Progetto"}</span>
        </Link>
        <Link
          to={`/issues/${result.rootTaskId}`}
          className="rounded-md border border-border px-3 py-2 no-underline transition-colors hover:bg-accent/50"
        >
          <span className="block text-xs text-muted-foreground">Root task</span>
          <span className="mt-1 block truncate text-xs text-foreground">Root task bloccato</span>
        </Link>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
          <span className="text-muted-foreground">Policy configurata</span>
          <strong className="mt-1 block font-medium">{result.policyConfigured ? "Sì" : "No"}</strong>
        </div>
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
          <span className="text-muted-foreground">Esecuzione autorizzata</span>
          <strong className="mt-1 block font-medium">{result.executionAuthorized ? "Sì" : "No"}</strong>
        </div>
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
          <span className="text-muted-foreground">Ricevuta</span>
          <strong className="mt-1 block font-medium">
            {result.receipt.kind === "intake" ? "Intake registrato" : "Non disponibile"}
          </strong>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Il root task è stato creato bloccato. Nessun agente o effetto cliente è stato avviato.
          </span>
        </div>
        <Button size="sm" variant="outline" asChild>
          <Link to={`/issues/${result.rootTaskId}`}>Apri root task</Link>
        </Button>
      </div>
    </div>
  );
}

export function RegiaObjectiveCard({
  companyId,
  projects,
  agents,
}: {
  companyId: string;
  projects: Project[] | undefined;
  agents: Agent[] | undefined;
}) {
  const queryClient = useQueryClient();
  const [objective, setObjective] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [result, setResult] = useState<RegiaIntakeResponse | null>(null);
  const idempotencyRef = useRef<{ signature: string; key: string } | null>(null);

  const environmentsQuery = useQuery({
    queryKey: queryKeys.environments.list(companyId),
    queryFn: () => environmentsApi.list(companyId),
  });
  const regiaCandidates = useMemo(() => (agents ?? []).filter(isRegiaCandidate), [agents]);
  const regiaAgent = regiaCandidates.length === 1 ? regiaCandidates[0]! : null;
  const candidates = useMemo(() => {
    if (!regiaAgent || !environmentsQuery.data) return [];
    return (projects ?? [])
      .map((project) => regiaProjectCandidate(project, environmentsQuery.data!, regiaAgent))
      .filter((value): value is RegiaProjectCandidate => value !== null);
  }, [environmentsQuery.data, projects, regiaAgent]);

  useEffect(() => {
    setObjective("");
    setSelectedProjectId("");
    setValidationMessage(null);
    setResult(null);
    idempotencyRef.current = null;
  }, [companyId]);

  useEffect(() => {
    if (candidates.length === 1 && !selectedProjectId) {
      setSelectedProjectId(candidates[0]!.project.id);
    }
  }, [candidates, selectedProjectId]);

  const selectedCandidate =
    candidates.find((candidate) => candidate.project.id === selectedProjectId) ?? null;
  const workspacesQuery = useQuery({
    queryKey: queryKeys.projects.workspaces(companyId, selectedProjectId || "none"),
    queryFn: () => projectsApi.listWorkspaces(selectedProjectId, companyId),
    enabled: !!selectedCandidate,
  });
  const selectedBinding = useMemo(
    () =>
      selectedCandidate && workspacesQuery.data
        ? regiaProjectBinding(selectedCandidate, workspacesQuery.data)
        : null,
    [selectedCandidate, workspacesQuery.data],
  );
  const secretRefsQuery = useQuery({
    queryKey: queryKeys.environments.secretRefs(selectedBinding?.environmentId ?? "none"),
    queryFn: () => environmentsApi.secretRefs(selectedBinding!.environmentId),
    enabled: !!selectedBinding,
  });
  const authorizedSecretRefs = useMemo(() => {
    const refs = (secretRefsQuery.data?.refs ?? []).filter(
      (ref) => ref.companyId === companyId && ref.status === "active",
    );
    return [
      ...new Map(refs.map((ref) => [`${ref.secretId}:${ref.configPath}`, ref])).values(),
    ];
  }, [companyId, secretRefsQuery.data?.refs]);
  const credentialRef = authorizedSecretRefs.length === 1 ? authorizedSecretRefs[0]! : null;

  const mutation = useMutation({
    mutationFn: (request: RegiaIntakeRequest) => regiaIntakeApi.accept(companyId, request),
    onSuccess: async (response) => {
      setResult(response);
      setValidationMessage(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(companyId) }),
      ]);
    },
  });

  const isLoading =
    projects === undefined ||
    agents === undefined ||
    environmentsQuery.isLoading ||
    (!!selectedCandidate && workspacesQuery.isLoading) ||
    (!!selectedBinding && secretRefsQuery.isLoading);
  const configurationReady =
    !!regiaAgent &&
    !!selectedBinding &&
    !!credentialRef &&
    !environmentsQuery.isError &&
    !workspacesQuery.isError &&
    !secretRefsQuery.isError;

  const submit = () => {
    const normalizedObjective = objective.trim();
    if (!normalizedObjective) {
      setValidationMessage("Scrivi l’obiettivo da affidare alla Regia.");
      return;
    }
    if (!configurationReady || !regiaAgent || !selectedBinding || !credentialRef) {
      setValidationMessage("La configurazione protetta della Regia non è verificata.");
      return;
    }
    const signature = [
      companyId,
      normalizedObjective,
      regiaAgent.id,
      selectedBinding.project.id,
      selectedBinding.workspaceId,
      selectedBinding.environmentId,
      credentialRef.secretId,
    ].join(":");
    if (idempotencyRef.current?.signature !== signature) {
      idempotencyRef.current = { signature, key: createIdempotencyKey() };
    }
    const parsed = regiaIntakeRequestSchema.safeParse({
      idempotencyKey: idempotencyRef.current.key,
      objective: normalizedObjective,
      binding: {
        regiaAgentId: regiaAgent.id,
        projectId: selectedBinding.project.id,
        projectWorkspaceId: selectedBinding.workspaceId,
        environmentId: selectedBinding.environmentId,
        credentialSecretRef: {
          type: "secret_ref",
          secretId: credentialRef.secretId,
          version: "latest",
        },
      },
    });
    if (!parsed.success) {
      setValidationMessage("La configurazione protetta della Regia non è valida.");
      return;
    }
    setValidationMessage(null);
    mutation.mutate(parsed.data);
  };

  return (
    <Card className="gap-4 py-5" data-testid="regia-objective-card">
      <CardHeader className="px-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-background">
            <Flag className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <CardTitle>Obiettivo operativo</CardTitle>
            <CardDescription className="mt-1">
              Registra la catena Goal → Progetto → Root task. Il task nasce bloccato e non avvia agenti.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        {result ? (
          <ResultChain
            result={result}
            projectName={projects?.find((project) => project.id === result.projectId)?.name ?? null}
          />
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Verifica configurazione Regia…</p>
        ) : !regiaAgent || candidates.length === 0 ? (
          <div className="space-y-3" data-testid="regia-objective-empty">
            <p className="text-sm font-medium">Configurazione Regia non verificata</p>
            <p className="text-sm text-muted-foreground">
              Serve un solo responsabile Regia attivo e un progetto con workspace e sandbox univoci.
            </p>
            <Button size="sm" variant="outline" asChild>
              <Link to="/org"><Link2 className="h-3.5 w-3.5" />Apri organizzazione</Link>
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="regia-objective">Obiettivo</Label>
              <Textarea
                id="regia-objective"
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="Descrivi il risultato verificabile da raggiungere…"
                maxLength={4_000}
                aria-invalid={validationMessage ? true : undefined}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="regia-project">Progetto</Label>
              <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                <SelectTrigger id="regia-project" aria-label="Progetto">
                  <SelectValue placeholder="Seleziona progetto" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.project.id} value={candidate.project.id}>
                      {candidate.project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedBinding ? (
              <div className="grid gap-2 text-xs sm:grid-cols-3" data-testid="regia-derived-binding">
                <div><span className="text-muted-foreground">Workspace</span><strong className="mt-1 block font-medium">{selectedBinding.workspaceName}</strong></div>
                <div><span className="text-muted-foreground">Ambiente</span><strong className="mt-1 block font-medium">{selectedBinding.environmentName}</strong></div>
                <div><span className="text-muted-foreground">Credenziale protetta</span><strong className="mt-1 block font-medium">{credentialRef?.name ?? "Non verificata"}</strong></div>
              </div>
            ) : null}

            {selectedCandidate && !workspacesQuery.isLoading && !selectedBinding ? (
              <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3" data-testid="regia-workspace-unverified">
                <p className="text-sm font-medium">Configurazione Regia non verificata</p>
                <p className="text-xs text-muted-foreground">
                  Il progetto deve avere un solo workspace autorizzato o un workspace primario esplicito.
                </p>
              </div>
            ) : null}

            {selectedBinding && !secretRefsQuery.isLoading && !credentialRef ? (
              <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3" data-testid="regia-binding-unverified">
                <p className="text-sm font-medium">Configurazione Regia non verificata</p>
                <p className="text-xs text-muted-foreground">
                  L’ambiente deve avere un solo secret_ref attivo e autorizzato per questa organizzazione.
                </p>
                <Button size="sm" variant="outline" asChild>
                  <Link to="/company/settings/environments">Configura ambiente</Link>
                </Button>
              </div>
            ) : null}

            {validationMessage ? (
              <p role="alert" className="text-sm text-destructive">{validationMessage}</p>
            ) : null}
            {mutation.error ? (
              <p role="alert" className="text-sm text-destructive">{safeMutationMessage(mutation.error)}</p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Nessuna esecuzione viene autorizzata da questo invio.
              </p>
              <Button type="submit" size="sm" disabled={mutation.isPending || !configurationReady}>
                {mutation.isPending ? "Registrazione…" : "Registra obiettivo bloccato"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
