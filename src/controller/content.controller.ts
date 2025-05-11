import { NextFunction, Request, Response } from "express";
import ContentService from "../service/content.service";
import { formatGeneratedScript, formatGeneratedTitle } from "../utlils/content";
import { firebase } from "../config/firebase";

class ContentController {
  private service: ContentService;

  constructor(service: ContentService) {
    this.service = service;
  }

  retrieveTopics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { limit = 10, cursor, filters = {} } = req.body;

      const data = await this.service.getPaginatedUsersTopics({
        userId: req.userId,
        limit,
        cursor,
        filters,
      });

      res.sendSuccess({
        message: "successfully retrieved topics",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  retrieveScripts = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getUsersScript(req.userId);
      res.sendSuccess({
        message: "successfully retrieved scripts",
        data,
      });
    } catch (error) {
      next(error);
    }
  };


  generateTopics = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.query.token || "";
      if (!token) {
        return res.sendError({ message: "Unauthorized" });
      }

      const decodedToken = await firebase.auth().verifyIdToken(token as string);
      const uid = decodedToken.uid;

      const data = await this.service.generateTopics(uid, res);
      const modifiedData = (data || [])?.map((record) =>
        formatGeneratedTitle(record, uid)
      );

      if (!modifiedData?.length) {
        throw new Error("Unable to generate at the moment");
      }
      this.service.saveBatchTopics(modifiedData);
    } catch (e) {
      next(e);
    }
  };

  generateScript = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.query.token || "";
      const scriptId = req.params.scriptId;
      if (!token) {
        return res.sendError({ message: "Unauthorized" });
      }

      const decodedToken = await firebase.auth().verifyIdToken(token as string);
      const uid = decodedToken.uid;
      await this.service.generateScripts(uid, scriptId, res);
    } catch (error) {
      next(error);
    }
  };

  
  // retrieveScriptById = async (
  //   req: Request,
  //   res: Response,
  //   next: NextFunction) =>{
  //   try {
  //     const data = await this.service.getScriptById(req.userId, req.params.id);
  //     res.sendSuccess({
  //       message: "successfully retrieved script",
  //       data,
  //     });
  //   } catch (error) {
  //     next(error);
  //   }
  // };
}

export default ContentController;
