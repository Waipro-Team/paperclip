import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { regiaIntakeRequestSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { regiaIntakeService } from "../services/regia-intake.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function regiaIntakeRoutes(db: Db) {
  const router = Router();
  const service = regiaIntakeService(db);

  router.post("/companies/:companyId/regia/intake", validate(regiaIntakeRequestSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") throw new Error("Board actor must resolve to a user");
    const result = await service.accept(companyId, req.body, { actorType: "user", actorId: actor.actorId });
    res.status(result.created ? 201 : 200).json(result);
  });

  return router;
}
