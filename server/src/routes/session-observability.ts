import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sessionObservabilityService } from "../services/session-observability.js";
import { assertCompanyAccess } from "./authz.js";

export function sessionObservabilityRoutes(db: Db) {
  const router = Router();
  const service = sessionObservabilityService(db);

  router.get("/companies/:companyId/session-observability", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.read(companyId));
  });

  return router;
}
