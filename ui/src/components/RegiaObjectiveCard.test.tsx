// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Project, RegiaIntakeResponse } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { RegiaObjectiveCard } from "./RegiaObjectiveCard";

const mockEnvironmentList = vi.hoisted(() => vi.fn());
const mockEnvironmentSecretRefs = vi.hoisted(() => vi.fn());
const mockProjectWorkspaces = vi.hoisted(() => vi.fn());
const mockAccept = vi.hoisted(() => vi.fn());
const mockApprovalsList = vi.hoisted(() => vi.fn());
const mockApprove = vi.hoisted(() => vi.fn());
const mockReject = vi.hoisted(() => vi.fn());

vi.mock("../api/environments", () => ({
  environmentsApi: {
    list: mockEnvironmentList,
    secretRefs: mockEnvironmentSecretRefs,
  },
}));

vi.mock("../api/regiaIntake", () => ({
  regiaIntakeApi: { accept: mockAccept },
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    list: mockApprovalsList,
    approve: mockApprove,
    reject: mockReject,
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { listWorkspaces: mockProjectWorkspaces },
}));

vi.mock("../lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const ENVIRONMENT_ID = "55555555-5555-4555-8555-555555555555";
const SECRET_ID = "66666666-6666-4666-8666-666666666666";
const GOAL_ID = "77777777-7777-4777-8777-777777777777";
const ROOT_TASK_ID = "88888888-8888-4888-8888-888888888888";
const ACTIVITY_ID = "99999999-9999-4999-8999-999999999999";
const APPROVAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function regiaAgent(): Agent {
  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "Regia",
    role: "executive",
    title: "Fleet Director",
    status: "idle",
    reportsTo: null,
    defaultEnvironmentId: ENVIRONMENT_ID,
    metadata: { catalogRoleKey: "fleet_director" },
  } as unknown as Agent;
}

function readyProject(): Project {
  return {
    id: PROJECT_ID,
    companyId: COMPANY_ID,
    urlKey: "portal360",
    name: "Portal360",
    archivedAt: null,
    workspaces: [],
    primaryWorkspace: null,
    executionWorkspacePolicy: {
      enabled: true,
      environmentId: ENVIRONMENT_ID,
      defaultProjectWorkspaceId: WORKSPACE_ID,
    },
  } as unknown as Project;
}

function readyWorkspace() {
  return {
    id: WORKSPACE_ID,
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    name: "Corsia canonica",
    sourceType: "git_repo",
    isPrimary: true,
  };
}

function readyEnvironment() {
  return {
    id: ENVIRONMENT_ID,
    name: "Sandbox Regia",
    description: null,
    driver: "sandbox",
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function readySecretRef(secretId = SECRET_ID) {
  return {
    configPath: "env.REGIA_CREDENTIAL",
    secretId,
    name: "Credenziale Regia",
    status: "active",
    companyId: COMPANY_ID,
    companyName: "Core360",
  };
}

const response: RegiaIntakeResponse = {
  companyId: COMPANY_ID,
  goalId: GOAL_ID,
  projectId: PROJECT_ID,
  rootTaskId: ROOT_TASK_ID,
  regiaAgentId: AGENT_ID,
  reviewPolicy: "not_creator",
  created: true,
  executionAuthorized: false,
  policyConfigured: false,
  blockingGate: "policy_configuration_required",
  approvalId: APPROVAL_ID,
  approvalStatus: "pending",
  receipt: {
    kind: "intake",
    activityId: ACTIVITY_ID,
    action: "regia.intake.accepted",
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

async function waitForUi(assertion: () => void) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

async function renderCard(options: { agents?: Agent[]; projects?: Project[] } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient!}>
        <RegiaObjectiveCard
          companyId={COMPANY_ID}
          agents={options.agents ?? [regiaAgent()]}
          projects={options.projects ?? [readyProject()]}
        />
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => {
    expect(container!.textContent).not.toContain("Verifica configurazione Regia…");
  });
  return container;
}

async function setTextarea(value: string) {
  await act(async () => {
    const textarea = container!.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitButton() {
  return [...container!.querySelectorAll("button")].find(
    (button) => button.textContent === "Registra obiettivo bloccato",
  )!;
}

describe("RegiaObjectiveCard", () => {
  beforeEach(() => {
    mockEnvironmentList.mockReset();
    mockEnvironmentSecretRefs.mockReset();
    mockProjectWorkspaces.mockReset();
    mockAccept.mockReset();
    mockApprovalsList.mockReset();
    mockApprove.mockReset();
    mockReject.mockReset();
    mockEnvironmentList.mockResolvedValue([readyEnvironment()]);
    mockEnvironmentSecretRefs.mockResolvedValue({ refs: [readySecretRef()] });
    mockProjectWorkspaces.mockResolvedValue([readyWorkspace()]);
    mockAccept.mockResolvedValue(response);
    const pendingApproval = {
      id: APPROVAL_ID,
      companyId: COMPANY_ID,
      type: "regia_execution_policy",
      status: "pending",
      payload: {
        issueId: ROOT_TASK_ID,
        receiptActivityId: ACTIVITY_ID,
        requestFingerprint: "a".repeat(64),
        bindingDigest: "b".repeat(64),
        policyDigest: "c".repeat(64),
      },
      requestedByUserId: "cristian",
      requestedByAgentId: null,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockApprovalsList.mockResolvedValue([pendingApproval]);
    mockApprove.mockResolvedValue({ ...pendingApproval, status: "approved" });
    mockReject.mockResolvedValue({ ...pendingApproval, status: "rejected" });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    queryClient?.clear();
    container?.remove();
    root = null;
    queryClient = null;
    container = null;
    vi.clearAllMocks();
  });

  it("fails closed when the Regia identity or machine binding is unavailable", async () => {
    const panel = await renderCard({ agents: [] });

    expect(panel.textContent).toContain("Configurazione Regia non verificata");
    expect(panel.textContent).toContain("Serve un solo responsabile Regia attivo");
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it("does not post when the objective is empty", async () => {
    const panel = await renderCard();
    await waitForUi(() => expect(submitButton().disabled).toBe(false));

    await act(async () => submitButton().click());

    expect(panel.textContent).toContain("Scrivi l’obiettivo da affidare alla Regia.");
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it("rejects ambiguous authorized secret refs without exposing raw identifiers", async () => {
    mockEnvironmentSecretRefs.mockResolvedValue({
      refs: [
        readySecretRef(),
        readySecretRef("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      ],
    });
    const panel = await renderCard();

    await waitForUi(() => expect(panel.textContent).toContain("L’ambiente deve avere un solo secret_ref"));
    expect(submitButton().disabled).toBe(true);
    expect(panel.textContent).not.toContain(SECRET_ID);
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it("rejects the same secret bound at two config paths", async () => {
    mockEnvironmentSecretRefs.mockResolvedValue({
      refs: [
        readySecretRef(),
        { ...readySecretRef(), configPath: "gateway.headers.authorization" },
      ],
    });
    const panel = await renderCard();

    await waitForUi(() =>
      expect(panel.textContent).toContain("L’ambiente deve avere un solo secret_ref"),
    );
    expect(submitButton().disabled).toBe(true);
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it("shows a safe company-access error and never broadens permissions", async () => {
    mockAccept.mockRejectedValue(new ApiError("forbidden", 403, null));
    const panel = await renderCard();
    await waitForUi(() => expect(submitButton().disabled).toBe(false));
    await setTextarea("Porta Team e Regia a uno stato verificabile");

    await act(async () => submitButton().click());
    await waitForUi(() => {
      expect(panel.textContent).toContain("Non hai accesso alla Regia di questa organizzazione.");
    });

    expect(mockAccept).toHaveBeenCalledTimes(1);
    expect(panel.textContent).not.toContain("forbidden");
  });

  it("renders only the persisted intake chain and the blocked execution gate", async () => {
    const panel = await renderCard();
    await waitForUi(() => expect(submitButton().disabled).toBe(false));
    await setTextarea("Porta Team e Regia a uno stato verificabile");

    await act(async () => submitButton().click());
    await waitForUi(() =>
      expect(panel.querySelector('[data-testid="regia-objective-result"]')).not.toBeNull(),
    );

    expect(mockAccept).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        objective: "Porta Team e Regia a uno stato verificabile",
        binding: {
          regiaAgentId: AGENT_ID,
          projectId: PROJECT_ID,
          projectWorkspaceId: WORKSPACE_ID,
          environmentId: ENVIRONMENT_ID,
          credentialSecretRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
        },
      }),
    );
    expect(panel.textContent).toContain("In attesa di approvazione board");
    expect(panel.textContent).toContain("Policy configurata");
    expect(panel.textContent).toContain("Esecuzione autorizzata");
    expect(panel.textContent).toContain("Intake registrato");
    expect(panel.textContent).not.toContain("106");
    expect(panel.querySelector(`a[href="/goals/${GOAL_ID}"]`)).not.toBeNull();
    expect(panel.querySelector(`a[href="/projects/${PROJECT_ID}"]`)).not.toBeNull();
    expect(panel.querySelector(`a[href="/issues/${ROOT_TASK_ID}"]`)).not.toBeNull();
    expect(panel.textContent).toContain("Goal operativo");
    expect(panel.textContent).toContain("Portal360");
    expect(panel.textContent).toContain("Root task bloccato");
    expect(panel.textContent).not.toContain(GOAL_ID);
    expect(panel.textContent).not.toContain(PROJECT_ID);
    expect(panel.textContent).not.toContain(ROOT_TASK_ID);
    expect(panel.textContent).not.toContain(ACTIVITY_ID);
    expect(panel.textContent).not.toContain(APPROVAL_ID);
    expect(panel.textContent).not.toContain("requestFingerprint");
    expect(panel.textContent).not.toContain("bindingDigest");
    expect(mockProjectWorkspaces).toHaveBeenCalledWith(PROJECT_ID, COMPANY_ID);
  });

  it("lets the board approve the exact company-scoped Regia gate", async () => {
    const panel = await renderCard();
    await waitForUi(() => expect(submitButton().disabled).toBe(false));
    await setTextarea("Completa la Regia verificata");
    await act(async () => submitButton().click());
    await waitForUi(() => {
      expect(panel.textContent).toContain("In attesa di approvazione board");
      expect(panel.textContent).toContain("Approva esecuzione");
      const button = [...panel.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Approva esecuzione",
      );
      expect(button?.disabled).toBe(false);
    });

    const approveButton = [...panel.querySelectorAll("button")].find(
      (button) => button.textContent === "Approva esecuzione",
    )!;
    await act(async () => approveButton.click());
    await waitForUi(() => expect(panel.textContent).toContain("Approvata: esecuzione autorizzata"));

    expect(mockApprovalsList).toHaveBeenCalledWith(COMPANY_ID);
    expect(mockApprove).toHaveBeenCalledWith(APPROVAL_ID);
    expect(mockReject).not.toHaveBeenCalled();
    expect(panel.textContent).toContain("Root task autorizzato");
    expect(panel.textContent).not.toContain("Approva esecuzione");
  });

  it("keeps a rejected Regia gate visibly blocked", async () => {
    const panel = await renderCard();
    await waitForUi(() => expect(submitButton().disabled).toBe(false));
    await setTextarea("Completa la Regia verificata");
    await act(async () => submitButton().click());
    await waitForUi(() => {
      const button = [...panel.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Rifiuta",
      );
      expect(button?.disabled).toBe(false);
    });

    const rejectButton = [...panel.querySelectorAll("button")].find(
      (button) => button.textContent === "Rifiuta",
    )!;
    await act(async () => rejectButton.click());
    await waitForUi(() => expect(panel.textContent).toContain("Rifiutata: esecuzione bloccata"));

    expect(mockReject).toHaveBeenCalledWith(APPROVAL_ID);
    expect(panel.textContent).toContain("Root task bloccato");
    expect(panel.textContent).not.toContain("Approva esecuzione");
  });

  it("fails closed on a company-scope denial without exposing API or receipt details", async () => {
    mockApprovalsList.mockRejectedValue(new ApiError("foreign-company-secret", 403, {
      token: "must-not-render",
    }));
    const panel = await renderCard();
    await waitForUi(() => expect(submitButton().disabled).toBe(false));
    await setTextarea("Completa la Regia verificata");
    await act(async () => submitButton().click());
    await waitForUi(() => {
      expect(panel.textContent).toContain("Non hai accesso all’approvazione Regia di questa organizzazione.");
    });

    const approveButton = [...panel.querySelectorAll("button")].find(
      (button) => button.textContent === "Approva esecuzione",
    )!;
    expect(approveButton.disabled).toBe(true);
    expect(mockApprove).not.toHaveBeenCalled();
    expect(panel.textContent).not.toContain("foreign-company-secret");
    expect(panel.textContent).not.toContain("must-not-render");
    expect(panel.textContent).not.toContain(APPROVAL_ID);
    expect(panel.textContent).not.toContain(ACTIVITY_ID);
  });
});
