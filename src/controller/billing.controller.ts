import { Request, Response } from "express";
import BillingRepository from "../repository/billing.repository.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { ownerOf } from "../utlils/content.js";

class BillingController {
  constructor(private repo: BillingRepository) {}

  getBalance = asyncHandler(async (req: Request, res: Response) => {
    res.sendSuccess({
      message: "Credit balance",
      data: await this.repo.getBalance(ownerOf(req)),
    });
  });
}

export default BillingController;
