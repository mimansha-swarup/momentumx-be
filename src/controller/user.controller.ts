import { Request, Response } from "express";
import UserService from "../service/user.service.js";
import { asyncHandler } from "../middleware/async_handler.js";
import { BadRequest } from "../utlils/errors.js";

class UserController {
  private service: UserService;

  constructor(service: UserService) {
    this.service = service;
  }

  saveOnboarding = asyncHandler(async (req: Request, res: Response) => {
    const { brandName, niche, targetAudience, userName } = req.body;

    const missing: string[] = [];
    if (!brandName) missing.push("brandName");
    if (!niche) missing.push("niche");
    if (!targetAudience) missing.push("targetAudience");
    if (!userName) missing.push("userName");

    if (missing.length) {
      throw BadRequest(`Missing required fields: ${missing.join(", ")}`);
    }

    // Optional video format (phases 1C decision) — defaults to talking_head
    // downstream; only validate when the client sends it.
    const { format } = req.body;
    if (format !== undefined && format !== "talking_head" && format !== "faceless") {
      throw BadRequest('format must be "talking_head" or "faceless"');
    }

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
