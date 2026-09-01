import type { SessionObservabilityResponse } from "@paperclipai/shared";
import { api } from "./client";

export const sessionObservabilityApi = {
  get: (companyId: string) =>
    api.get<SessionObservabilityResponse>(`/companies/${companyId}/session-observability`),
};
