import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  regiaIntakeRequestSchema,
  regiaIntakePreflightRequestSchema,
  type RegiaIntakePreflightResponse,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { regiaIntakeService } from "../services/regia-intake.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function intakePrincipal(req: Request, companyId: string): RegiaIntakePreflightResponse["actor"] {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  const { userId, source } = req.actor;
  if (!userId?.trim() || userId.trim() === "board" ||
    !source || !["local_implicit", "session", "board_key", "cloud_tenant"].includes(source)) {
    throw forbidden("Regia intake requires an identified board user");
  }
  return {
    userId,
    source: source as RegiaIntakePreflightResponse["actor"]["source"],
    companyIds: [...(req.actor.companyIds ?? [])],
    isInstanceAdmin: req.actor.isInstanceAdmin === true,
  };
}

export function regiaIntakeRoutes(db: Db) {
  const router = Router();
  const service = regiaIntakeService(db);

  router.post("/companies/:companyId/regia/intake", validate(regiaIntakeRequestSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = intakePrincipal(req, companyId);
    const result = await service.accept(companyId, req.body, { actorType: "user", actorId: actor.userId });
    res.status(result.created ? 201 : 200).json(result);
  });

  router.post("/companies/:companyId/regia/intake/preflight",
    validate(regiaIntakePreflightRequestSchema), async (req, res) => {
      const companyId = req.params.companyId as string;
      const actor = intakePrincipal(req, companyId);
      const binding = await service.preflight(companyId, req.body);
      const result: RegiaIntakePreflightResponse = {
        schemaVersion: 1,
        capability: "regia_intake_preflight_v1",
        companyId,
        binding,
        actor,
        executionAuthorized: false,
        intakeAvailable: true,
      };
      res.json(result);
    });

  return router;
}
