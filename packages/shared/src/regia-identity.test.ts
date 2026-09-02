import { describe, expect, it } from "vitest";
import { isRegiaRootCatalogRoleKey, REGIA_ROOT_CATALOG_ROLE_KEYS } from "./constants.js";

describe("isRegiaRootCatalogRoleKey", () => {
  it("accepts only the explicit canonical Regia root catalog keys", () => {
    expect(isRegiaRootCatalogRoleKey("director_pmo_control_room")).toBe(true);
    expect(isRegiaRootCatalogRoleKey("fleet_director")).toBe(true);

    for (const value of [
      null,
      undefined,
      "pmo",
      "director pmo control room",
      "Director_PMO_Control_Room",
      "director_pmo_control_room_legacy",
      { roleClass: "pmo" },
    ]) {
      expect(isRegiaRootCatalogRoleKey(value)).toBe(false);
    }
  });

  it("keeps the canonical role-key tuple immutable at runtime", () => {
    expect(Object.isFrozen(REGIA_ROOT_CATALOG_ROLE_KEYS)).toBe(true);

    const mutableAlias = REGIA_ROOT_CATALOG_ROLE_KEYS as unknown as string[];
    expect(() => mutableAlias.push("attacker_role")).toThrow(TypeError);
    expect(REGIA_ROOT_CATALOG_ROLE_KEYS).toEqual([
      "director_pmo_control_room",
      "fleet_director",
    ]);
    expect(isRegiaRootCatalogRoleKey("attacker_role")).toBe(false);
  });
});
