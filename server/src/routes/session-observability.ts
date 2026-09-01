import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import {
  authorizationDeniedDetails,
  authorizationService,
} from "../services/authorization.js";
import { sessionObservabilityService } from "../services/session-observability.js";
import { assertCompanyAccess } from "./authz.js";

export function sessionObservabilityRoutes(db: Db) {
  const router = Router();
  const service = sessionObservabilityService(db);
  const access = authorizationService(db);

  router.get("/companies/:companyId/session-observability", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
    res.json(await service.read(companyId));
  });

  return router;
}
