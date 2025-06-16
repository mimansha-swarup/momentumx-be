import { NextFunction, Request, Response } from "express";
import UserService from "../service/user.service.js";

class UserController {
  private service: UserService;

  constructor(service: UserService) {
    this.service = service;
  }

  saveOnboarding = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = await this.service.createOnboardingData(
        req.userId,
        req.body
      );
      const iSWebsiteParsed = !!payload?.websiteContent 
      res.sendSuccess({
        warning: !iSWebsiteParsed ? " Website content is not parsed": "",
        message:"Onboarded  successfully" ,
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

  updateProfile = (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = this.service.updateProfile(req.userId, req.body);

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
