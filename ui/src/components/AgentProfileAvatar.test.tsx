// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { AgentProfileAvatar, agentProfilePhotoUrl } from "./AgentProfileAvatar";

describe("agentProfilePhotoUrl", () => {
  it("builds the authenticated asset-content path from imported profile metadata", () => {
    expect(agentProfilePhotoUrl({ profilePhotoAssetId: " asset/id " })).toBe(
      "/api/assets/asset%2Fid/content",
    );
  });

  it("ignores missing, non-string, and blank profile-photo metadata", () => {
    expect(agentProfilePhotoUrl(null)).toBeNull();
    expect(agentProfilePhotoUrl({ profilePhotoAssetId: 42 })).toBeNull();
    expect(agentProfilePhotoUrl({ profilePhotoAssetId: "  " })).toBeNull();
  });
});

describe("AgentProfileAvatar", () => {
  const agent = {
    name: "Aurora",
    icon: "sparkles",
    metadata: null,
  } satisfies Pick<Agent, "name" | "icon" | "metadata">;

  it("keeps the agent icon as the native fallback when no portrait is linked", () => {
    const html = renderToStaticMarkup(<AgentProfileAvatar agent={agent} />);

    expect(html).toContain('data-profile-photo="fallback"');
    expect(html).toContain('aria-label="Aurora profile icon"');
    expect(html).toContain("<svg");
  });

  it("marks the avatar as asset-backed when a portrait is linked", () => {
    const html = renderToStaticMarkup(
      <AgentProfileAvatar agent={{ ...agent, metadata: { profilePhotoAssetId: "portrait-id" } }} />,
    );

    expect(html).toContain('data-profile-photo="asset"');
  });
});
