import { describe, expect, it, vi } from "vitest";
import { enforceRegiaIntakeHeartbeatExecutionBinding } from "../services/heartbeat.ts";

describe("heartbeat Regia execution binding", () => {
  it("authorizes Regia only after the exact company binding guard succeeds", async () => {
    const assertBinding = vi.fn().mockResolvedValue(undefined);

    await expect(enforceRegiaIntakeHeartbeatExecutionBinding({} as never, {
      companyId: "company-1",
      originKind: "regia_intake",
      issueId: "issue-1",
      selectedEnvironmentId: "environment-1",
    }, { assertBinding })).resolves.toBe(true);

    expect(assertBinding).toHaveBeenCalledOnce();
    expect(assertBinding).toHaveBeenCalledWith(expect.anything(), {
      companyId: "company-1",
      issueId: "issue-1",
      selectedEnvironmentId: "environment-1",
      assertCompanyBinding: true,
    });
  });

  it("stops before lease, wake, or provider dispatch when the guard rejects", async () => {
    const assertBinding = vi.fn().mockRejectedValue(new Error("binding rejected"));
    const acquireLease = vi.fn();
    const wake = vi.fn();
    const dispatchProvider = vi.fn();

    await expect((async () => {
      const asserted = await enforceRegiaIntakeHeartbeatExecutionBinding({} as never, {
        companyId: "company-1",
        originKind: "regia_intake",
        issueId: "issue-1",
        selectedEnvironmentId: "environment-1",
      }, { assertBinding });
      await acquireLease({ assertCompanyBinding: asserted });
      await wake();
      await dispatchProvider();
    })()).rejects.toThrow("binding rejected");

    expect(acquireLease).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(dispatchProvider).not.toHaveBeenCalled();
  });

  it("leaves non-Regia execution unchanged and does not invoke the guard", async () => {
    const assertBinding = vi.fn();

    await expect(enforceRegiaIntakeHeartbeatExecutionBinding({} as never, {
      companyId: "company-1",
      originKind: "manual",
      issueId: "issue-1",
      selectedEnvironmentId: "environment-1",
    }, { assertBinding })).resolves.toBe(false);

    expect(assertBinding).not.toHaveBeenCalled();
  });
});
