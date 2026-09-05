import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/index.js";
import {
  githubProjectReconciliationRequestSchema,
  githubProjectReconciliationService,
} from "../services/github-project-reconciliation.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Board-only, company-scoped import gate for the canonical REGIA360 GitHub
 * Project V2. The request contract is intentionally closed: no issue body,
 * comments, arbitrary metadata or credentials can enter this route.
 */
export function githubProjectReconciliationRoutes(db: Db) {
  const router = Router();
  const service = githubProjectReconciliationService(db);

  router.post(
    "/companies/:companyId/github-project-v2-reconciliation",
    validate(githubProjectReconciliationRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const result = await service.reconcile(companyId, req.body, getActorInfo(req));
      res.status(200).json(result);
    },
  );

  return router;
}
