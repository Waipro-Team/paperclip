import type { ComponentProps } from "react";
import type { Agent } from "@paperclipai/shared";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { AgentIcon } from "./AgentIconPicker";

type AgentProfileVisual = Pick<Agent, "name" | "icon" | "metadata">;

export function agentProfilePhotoUrl(metadata: Agent["metadata"]): string | null {
  const assetId = metadata?.profilePhotoAssetId;
  if (typeof assetId !== "string") return null;
  const normalizedAssetId = assetId.trim();
  if (!normalizedAssetId) return null;
  return `/api/assets/${encodeURIComponent(normalizedAssetId)}/content`;
}

interface AgentProfileAvatarProps {
  agent: AgentProfileVisual;
  size?: ComponentProps<typeof Avatar>["size"];
  shape?: ComponentProps<typeof Avatar>["shape"];
  className?: string;
  iconClassName?: string;
}

/** Native agent portrait backed by a company-scoped Paperclip asset. */
export function AgentProfileAvatar({
  agent,
  size = "sm",
  shape = "circle",
  className,
  iconClassName,
}: AgentProfileAvatarProps) {
  const photoUrl = agentProfilePhotoUrl(agent.metadata);

  return (
    <Avatar
      size={size}
      shape={shape}
      className={cn("bg-muted", className)}
      data-profile-photo={photoUrl ? "asset" : "fallback"}
    >
      {photoUrl ? <AvatarImage src={photoUrl} alt={agent.name} /> : null}
      <AvatarFallback aria-label={`${agent.name} profile icon`}>
        <AgentIcon icon={agent.icon} className={cn("h-3 w-3", iconClassName)} />
      </AvatarFallback>
    </Avatar>
  );
}
