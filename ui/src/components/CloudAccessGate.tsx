import { useEffect, useRef } from "react";
import { Navigate, Outlet, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import {
  accessRecoveryAttemptKey,
  ApiError,
  recoverableAccessStatus,
  recoverAccessQueries,
  shouldStartAutomaticAccessRecovery,
} from "@/api/client";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { BootstrapPendingPage } from "@/components/BootstrapPendingPage";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { Card } from "@/components/ui/card";

function NoBoardAccessPage() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">No organization access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account is signed in, but it does not have an active organization membership or instance-admin access on
          this Paperclip instance.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Use an organization invite or sign in with an account that already belongs to this org.
        </p>
      </Card>
    </div>
  );
}

export function CloudAccessGate() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const isBootstrapPending = isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data,
    retry: false,
  });
  const boardAccessRecovery = useMutation({
    mutationFn: async (status: 401 | 403) => {
      await recoverAccessQueries(queryClient, { status });
    },
  });
  const automaticRecoveryKeyRef = useRef<string | null>(null);
  const boardAccessRecoveryKey = accessRecoveryAttemptKey(boardAccessQuery.error);

  useEffect(() => {
    if (!boardAccessRecoveryKey) {
      automaticRecoveryKeyRef.current = null;
      return;
    }
    if (!shouldStartAutomaticAccessRecovery(automaticRecoveryKeyRef.current, boardAccessQuery.error)) return;
    automaticRecoveryKeyRef.current = boardAccessRecoveryKey;
    const status = recoverableAccessStatus(boardAccessQuery.error);
    if (status !== null) boardAccessRecovery.mutate(status);
  }, [boardAccessQuery.error, boardAccessRecovery.mutate, boardAccessRecoveryKey]);

  const claimMutation = useMutation({
    mutationFn: () => accessApi.claimBootstrapAdmin(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    },
  });

  if (
    healthQuery.isLoading ||
    (isAuthenticatedMode && sessionQuery.isLoading) ||
    (isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data && boardAccessQuery.isLoading)
  ) {
    return <PaperclipLoading />;
  }

  if (boardAccessRecoveryKey && boardAccessRecovery.isPending) {
    return <PaperclipLoading />;
  }

  if (healthQuery.error || (boardAccessQuery.error && !boardAccessRecoveryKey)) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error
          ? healthQuery.error.message
          : boardAccessQuery.error instanceof Error
            ? boardAccessQuery.error.message
            : "Failed to load app state"}
      </div>
    );
  }

  if (boardAccessRecoveryKey) {
    const status = recoverableAccessStatus(boardAccessQuery.error);
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">
            {status === 401 ? "Your session needs to be refreshed" : "Organization access changed"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Paperclip could not refresh your current access automatically. Retry safely; this does not change any
            membership or permission.
          </p>
          <button
            type="button"
            className="mt-4 text-sm font-medium underline underline-offset-2"
            disabled={boardAccessRecovery.isPending || status === null}
            onClick={() => {
              if (status !== null) boardAccessRecovery.mutate(status);
            }}
          >
            {boardAccessRecovery.isPending ? "Refreshing…" : "Refresh access"}
          </button>
        </Card>
      </div>
    );
  }

  if (isBootstrapPending) {
    const health = healthQuery.data;
    if (!health) {
      return <PaperclipLoading />;
    }
    const claimError = claimMutation.error instanceof ApiError
      ? { status: claimMutation.error.status, message: claimMutation.error.message }
      : claimMutation.error instanceof Error
        ? { message: claimMutation.error.message }
        : null;
    return (
      <BootstrapPendingPage
        claimAvailable={health.deploymentExposure === "private"}
        hasActiveInvite={health.bootstrapInviteActive}
        session={sessionQuery.data}
        claimState={claimMutation.isSuccess ? "success" : claimMutation.isPending ? "claiming" : "idle"}
        claimError={claimError}
        onClaim={() => claimMutation.mutate()}
      />
    );
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  if (
    isAuthenticatedMode &&
    sessionQuery.data &&
    !boardAccessQuery.data?.isInstanceAdmin &&
    (boardAccessQuery.data?.companyIds.length ?? 0) === 0
  ) {
    return <NoBoardAccessPage />;
  }

  return <Outlet />;
}
