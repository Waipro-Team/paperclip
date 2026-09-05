import { z } from "zod";
import type { ApprovalStatus } from "../constants.js";

const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const regiaIntakeBindingSchema = z.object({
  regiaAgentId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectWorkspaceId: z.string().uuid(),
  environmentId: z.string().uuid(),
  credentialSecretRef: z.object({
    type: z.literal("secret_ref"),
    secretId: z.string().uuid(),
    version: z.union([z.literal("latest"), z.number().int().positive()]).default("latest"),
  }).strict(),
}).strict();

export const regiaIntakePreflightRequestSchema = z.object({
  binding: regiaIntakeBindingSchema,
}).strict();

export const regiaIntakeRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(3).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  objective: boundedText(4_000),
  binding: regiaIntakeBindingSchema,
  constraints: z.array(boundedText(1_000)).max(50).default([]),
  budgetEnvelope: z.object({
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    maxAmountCents: z.number().int().nonnegative().max(2_147_483_647),
    period: z.enum(["one_time", "monthly", "quarterly", "annual"]).default("one_time"),
    notes: boundedText(1_000).optional(),
  }).strict().optional(),
  kpis: z.array(z.object({
    name: boundedText(160),
    target: boundedText(500),
    unit: boundedText(80).optional(),
  }).strict()).max(50).default([]),
  gates: z.array(z.object({
    name: boundedText(160),
    condition: boundedText(1_000).optional(),
    requiresBoardApproval: z.boolean().default(true),
  }).strict()).max(50).default([]),
}).strict();

export type RegiaIntakeBinding = z.infer<typeof regiaIntakeBindingSchema>;
export type RegiaIntakePreflightRequest = z.infer<typeof regiaIntakePreflightRequestSchema>;
export interface RegiaIntakePreflightResponse {
  schemaVersion: 1;
  capability: "regia_intake_preflight_v1";
  companyId: string;
  binding: RegiaIntakeBinding;
  actor: {
    userId: string;
    source: "local_implicit" | "session" | "board_key" | "cloud_tenant";
    companyIds: string[];
    isInstanceAdmin: boolean;
  };
  executionAuthorized: false;
  intakeAvailable: true;
}

export type RegiaIntakeRequest = z.infer<typeof regiaIntakeRequestSchema>;

export interface RegiaIntakeResponse {
  companyId: string;
  goalId: string;
  projectId: string;
  rootTaskId: string;
  regiaAgentId: string;
  reviewPolicy: "not_creator";
  created: boolean;
  executionAuthorized: boolean;
  policyConfigured: boolean;
  blockingGate: "policy_configuration_required" | null;
  approvalId: string;
  approvalStatus: ApprovalStatus;
  receipt: { kind: "intake"; activityId: string; action: "regia.intake.accepted" };
}
