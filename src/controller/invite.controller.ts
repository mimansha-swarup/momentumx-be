import { Request, Response } from "express";
import SharingRepository from "../repository/sharing.repository.js";
import AccountService from "../service/account.service.js";
import { asyncHandler } from "../middleware/async_handler.js";

class InviteController {
  constructor(private repo: SharingRepository, private accounts: AccountService) {}

  // Public bearer-secret preview: masked email only. No account context exists before joining.
  preview = asyncHandler(async (req: Request, res: Response) => {
    res.sendSuccess({ data: await this.repo.preview(req.params.token) });
  });

  pending = asyncHandler(async (req: Request, res: Response) => {
    res.sendSuccess({ data: { invites: await this.repo.pending(req.userEmail, req.emailVerified) } });
  });

  accept = asyncHandler(async (req: Request, res: Response) => {
    const id = await this.repo.accept(req.params.token, req.userId, req.userEmail, req.emailVerified);
    const account = (await this.accounts.listAccounts(req.userId)).find((account) => account.id === id);
    res.sendSuccess({ data: { account } });
  });
}

export default InviteController;
