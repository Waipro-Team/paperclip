import type { RegiaIntakeRequest, RegiaIntakeResponse } from "@paperclipai/shared";
import { api } from "./client";

export const regiaIntakeApi = {
  accept: (companyId: string, request: RegiaIntakeRequest) =>
    api.post<RegiaIntakeResponse>(`/companies/${companyId}/regia/intake`, request),
};
