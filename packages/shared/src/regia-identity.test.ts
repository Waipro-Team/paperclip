import { describe, expect, it } from "vitest";
import { isRegiaRootCatalogRoleKey } from "./constants.js";

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
});
