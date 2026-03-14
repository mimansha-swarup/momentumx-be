import { NextFunction, Request, Response } from "express";
import UserService from "../service/user.service.js";

class UserController {
  private service: UserService;

  constructor(service: UserService) {
    this.service = service;
  }

  saveOnboarding = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { brandName, niche, targetAudience, userName } = req.body;

      const missing: string[] = [];
      if (!brandName) missing.push("brandName");
      if (!niche) missing.push("niche");
      if (!targetAudience) missing.push("targetAudience");
      if (!userName) missing.push("userName");

      if (missing.length) {
        return res.sendError({
          message: `Missing required fields: ${missing.join(", ")}`,
          statusCode: 400,
        });
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
    } catch (e) {
      next(e);
    }
  };

  getProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = await this.service.getProfile(req.userId);

      res.sendSuccess({
        message: "Fetched onboarding data successfully",
        data: { ...(payload ?? {}) },
      });
    } catch (e) {
      next(e);
    }
  };

  updateProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = await this.service.updateProfile(req.userId, req.body);

      res.sendSuccess({
        message: "Profile updated successfully",
        data: { payload },
      });
    } catch (e) {
      next(e);
    }
  };
}

export default UserController;
