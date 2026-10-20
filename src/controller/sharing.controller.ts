import { Request, Response } from "express";
import SharingRepository from "../repository/sharing.repository.js";
import { asyncHandler } from "../middleware/async_handler.js";

/** Thin wrapper over SharingRepository for the owner-gated member/invite routes. */
class SharingController {
  constructor(private repo: SharingRepository) {}

  members = asyncHandler(async (req: Request, res: Response) => {
    res.sendSuccess({ data: await this.repo.members(req.params.id, req.userId) });
  });

  listInvites = asyncHandler(async (req: Request, res: Response) => {
    res.sendSuccess({ data: { invites: await this.repo.list(req.params.id, req.userId) } });
  });

  createInvite = asyncHandler(async (req: Request, res: Response) => {
    res.sendSuccess({
      statusCode: 201,
      data: await this.repo.create(req.params.id, req.userId, req.body.email, req.body.role),
    });
  });

  revokeInvite = asyncHandler(async (req: Request, res: Response) => {
    await this.repo.revoke(req.params.id, req.userId, req.params.token);
    res.sendSuccess({});
  });

  changeRole = asyncHandler(async (req: Request, res: Response) => {
    await this.repo.change(req.params.id, req.userId, req.params.uid, req.body.role);
    res.sendSuccess({});
  });

  removeMember = asyncHandler(async (req: Request, res: Response) => {
    await this.repo.change(req.params.id, req.userId, req.params.uid, null);
    res.sendSuccess({});
  });

  leave = asyncHandler(async (req: Request, res: Response) => {
    await this.repo.change(req.params.id, req.userId, req.userId, null);
    res.sendSuccess({});
  });

  transferOwnership = asyncHandler(async (req: Request, res: Response) => {
    await this.repo.change(req.params.id, req.userId, req.body.userId, "owner", true);
    res.sendSuccess({});
  });
}

export default SharingController;
