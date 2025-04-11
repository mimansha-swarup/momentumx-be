import { Router } from "express";
import UserController from "../../controller/user.controller";
import UserService from "../../service/user.service";
import UserRepository from "../../repository/user.repository";
import { authMiddleware } from "../../middleware/auth";

const router = Router();

const userRepository = new UserRepository();
const userService = new UserService(userRepository);
const userController = new UserController(userService);

router.use(authMiddleware)
router.patch(
  "/onboarding",
  userController.saveOnboarding
);

router.get(
  "/profile",
  userController.getProfile
);

router.patch(
  "/profile",
  userController.updateProfile
);

export default router;
