import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  accessRecoveryAttemptKey,
  ApiError,
  recoverableAccessStatus,
  recoverAccessQueries,
  shouldStartAutomaticAccessRecovery,
} from "./client";
import { queryKeys } from "@/lib/queryKeys";

function recoveryClient() {
  return {
    invalidateQueries: vi.fn(async () => undefined),
  } as unknown as Pick<QueryClient, "invalidateQueries">;
}

describe("access recovery", () => {
  it("recognizes only authorization failures and provides a stable no-loop key", () => {
    const denied = new ApiError("denied", 403, null);
    expect(recoverableAccessStatus(denied)).toBe(403);
    expect(accessRecoveryAttemptKey(denied, "company-1")).toBe("company-1:403");
    expect(accessRecoveryAttemptKey(denied, "company-1")).toBe("company-1:403");
    expect(accessRecoveryAttemptKey(new ApiError("missing", 404, null), "company-1")).toBeNull();
    expect(accessRecoveryAttemptKey(new Error("offline"), "company-1")).toBeNull();
    expect(shouldStartAutomaticAccessRecovery(null, denied, "company-1")).toBe(true);
    expect(shouldStartAutomaticAccessRecovery("company-1:403", denied, "company-1")).toBe(false);
    expect(
      shouldStartAutomaticAccessRecovery(
        "company-1:403",
        new ApiError("signed out", 401, null),
        "company-1",
      ),
    ).toBe(true);
  });

  it("refreshes session, board access and companies in order for a 401", async () => {
    const client = recoveryClient();
    await recoverAccessQueries(client, { status: 401, companyId: "company-1" });

    expect(client.invalidateQueries).toHaveBeenCalledTimes(3);
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: queryKeys.auth.session,
      refetchType: "active",
    });
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: queryKeys.access.currentBoardAccess,
      refetchType: "active",
    });
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(3, {
      queryKey: queryKeys.companies.all,
      refetchType: "active",
    });
  });

  it("retries active company-scoped data once after a 403 without changing access", async () => {
    const client = recoveryClient();
    await recoverAccessQueries(client, { status: 403, companyId: "company-1" });

    expect(client.invalidateQueries).toHaveBeenCalledTimes(4);
    const fourthCall = vi.mocked(client.invalidateQueries).mock.calls[3]?.[0];
    expect(fourthCall?.refetchType).toBe("active");
    expect(fourthCall?.predicate?.({ queryKey: ["dashboard", "company-1"] } as never)).toBe(true);
    expect(fourthCall?.predicate?.({ queryKey: ["dashboard", "company-2"] } as never)).toBe(false);
  });
});
