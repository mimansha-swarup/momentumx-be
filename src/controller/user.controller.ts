import { Request, Response } from "express";
import UserService from "../service/user.service.js";
import { asyncHandler } from "../middleware/async_handler.js";

class UserController {
  private service: UserService;

  constructor(service: UserService) {
    this.service = service;
  }

  // Body is validated + normalized by `validate(onboardingSchema)` at the route
  // (required fields, URL formats, trimming, unknown-key stripping) — the
  // controller stays thin and trusts req.body.
  saveOnboarding = asyncHandler(async (req: Request, res: Response) => {
    const payload = await this.service.createOnboardingData(
      req.userId,
      req.body
    );
    const isWebsiteParsed = !!payload?.websiteContent;
    res.sendSuccess({
      warning: !isWebsiteParsed ? "Website content is not parsed" : "",
      message: "Onboarded successfully",
      data: { payload },
    });
  });

  // Body validated by `validate(prefillSchema)` — channelUrl is a valid YouTube
  // channel URL. Returns inferred suggestions (not persisted).
  prefill = asyncHandler(async (req: Request, res: Response) => {
    const data = await this.service.prefillFromChannel(req.body.channelUrl);
    res.sendSuccess({
      message: "Prefill suggestions generated",
      data,
    });
  });

  getProfile = asyncHandler(async (req: Request, res: Response) => {
    const payload = await this.service.getProfile(req.userId);

    res.sendSuccess({
      message: "Fetched onboarding data successfully",
      data: { ...(payload ?? {}) },
    });
  });

  updateProfile = asyncHandler(async (req: Request, res: Response) => {
    const payload = await this.service.updateProfile(req.userId, req.body);

    res.sendSuccess({
      message: "Profile updated successfully",
      data: { payload },
    });
  });
}

export default UserController;
