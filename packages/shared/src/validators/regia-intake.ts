import { z } from "zod";

const nonSensitiveText = (max: number) => z.string().trim().min(1).max(max).superRefine((value, ctx) => {
  if (/\b(password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|bearer|private[_ -]?key|cookie)\b\s*[:=]/i.test(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Sensitive credentials are not allowed in Regia intake context" });
  }
});

export const regiaIntakeRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(3).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  objective: nonSensitiveText(4_000),
  binding: z.object({
    projectId: z.string().uuid(),
    projectWorkspaceId: z.string().uuid(),
    environmentId: z.string().uuid(),
    credentialSecretRef: z.object({
      type: z.literal("secret_ref"),
      secretId: z.string().uuid(),
      version: z.union([z.literal("latest"), z.number().int().positive()]).default("latest"),
    }).strict(),
  }).strict(),
  constraints: z.array(nonSensitiveText(1_000)).max(50).default([]),
  budgetEnvelope: z.object({
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    maxAmountCents: z.number().int().nonnegative().max(2_147_483_647),
    period: z.enum(["one_time", "monthly", "quarterly", "annual"]).default("one_time"),
    notes: nonSensitiveText(1_000).optional(),
  }).strict().optional(),
  kpis: z.array(z.object({
    name: nonSensitiveText(160),
    target: nonSensitiveText(500),
    unit: nonSensitiveText(80).optional(),
  }).strict()).max(50).default([]),
  gates: z.array(z.object({
    name: nonSensitiveText(160),
    condition: nonSensitiveText(1_000).optional(),
    requiresBoardApproval: z.boolean().default(true),
  }).strict()).max(50).default([]),
}).strict();

export type RegiaIntakeRequest = z.infer<typeof regiaIntakeRequestSchema>;

export interface RegiaIntakeResponse {
  companyId: string;
  goalId: string;
  projectId: string;
  rootTaskId: string;
  regiaAgentId: string;
  reviewPolicy: "not_creator";
  created: boolean;
  executionAuthorized: false;
  receipt: { activityId: string; action: "regia.intake.accepted" };
}
