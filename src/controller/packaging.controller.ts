import { NextFunction, Request, Response } from "express";
import PackagingService from "../service/packaging.service.js";

class PackagingController {
  private service: PackagingService;

  constructor(service: PackagingService) {
    this.service = service;
  }

  generateTitle = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { script } = req.body;
      if (!script) {
        return res.sendError({ message: "Script is required", statusCode: 400 });
      }
      const data = await this.service.generateTitle(script);
      res.sendSuccess({
        message: "Title generated successfully",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  generateDescription = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { script, title } = req.body;
      if (!script) {
        return res.sendError({ message: "Script is required", statusCode: 400 });
      }
      if (!title) {
        return res.sendError({ message: "Title is required", statusCode: 400 });
      }
      const data = await this.service.generateDescription(script, title);
      res.sendSuccess({
        message: "Description generated successfully",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  generateThumbnail = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { script, title } = req.body;
      if (!script) {
        return res.sendError({ message: "Script is required", statusCode: 400 });
      }
      if (!title) {
        return res.sendError({ message: "Title is required", statusCode: 400 });
      }
      const data = await this.service.generateThumbnail(script, title);
      res.sendSuccess({
        message: "Thumbnail instructions generated successfully",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  generateHooks = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { script } = req.body;
      if (!script) {
        return res.sendError({ message: "Script is required", statusCode: 400 });
      }
      const data = await this.service.generateHooks(script);
      res.sendSuccess({
        message: "Hooks generated successfully",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  generateShorts = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { script, duration } = req.body;
      if (!script) {
        return res.sendError({ message: "Script is required", statusCode: 400 });
      }
      if (!duration) {
        return res.sendError({ message: "Duration is required", statusCode: 400 });
      }
      const data = await this.service.generateShorts(script, duration);
      res.sendSuccess({
        message: "Shorts script generated successfully",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  save = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.savePackaging(req.userId, req.body);
      res.sendSuccess({
        message: "Packaging saved successfully",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  getPackaging = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { packagingId } = req.params;
      const data = await this.service.getPackaging(packagingId);
      if (!data) {
        return res.sendError({ message: "Packaging not found", statusCode: 404 });
      }
      res.sendSuccess({
        message: "Packaging retrieved successfully",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  getPackagingByUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getPackagingByUser(req.userId);
      res.sendSuccess({
        message: "Packaging list retrieved successfully",
        data,
      });
    } catch (error) {
      next(error);
    }
  };
}

export default PackagingController;
