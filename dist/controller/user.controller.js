import { asyncHandler } from "../middleware/async_handler.js";
import { BadRequest } from "../utlils/errors.js";
class UserController {
    constructor(service) {
        this.saveOnboarding = asyncHandler(async (req, res) => {
            const { brandName, niche, targetAudience, userName } = req.body;
            const missing = [];
            if (!brandName)
                missing.push("brandName");
            if (!niche)
                missing.push("niche");
            if (!targetAudience)
                missing.push("targetAudience");
            if (!userName)
                missing.push("userName");
            if (missing.length) {
                throw BadRequest(`Missing required fields: ${missing.join(", ")}`);
            }
            // Optional video format (phases 1C decision) — defaults to talking_head
            // downstream; only validate when the client sends it.
            const { format } = req.body;
            if (format !== undefined && format !== "talking_head" && format !== "faceless") {
                throw BadRequest('format must be "talking_head" or "faceless"');
            }
            const payload = await this.service.createOnboardingData(req.userId, req.body);
            const isWebsiteParsed = !!payload?.websiteContent;
            res.sendSuccess({
                warning: !isWebsiteParsed ? "Website content is not parsed" : "",
                message: "Onboarded successfully",
                data: { payload },
            });
        });
        this.getProfile = asyncHandler(async (req, res) => {
            const payload = await this.service.getProfile(req.userId);
            res.sendSuccess({
                message: "Fetched onboarding data successfully",
                data: { ...(payload ?? {}) },
            });
        });
        this.updateProfile = asyncHandler(async (req, res) => {
            const payload = await this.service.updateProfile(req.userId, req.body);
            res.sendSuccess({
                message: "Profile updated successfully",
                data: { payload },
            });
        });
        this.service = service;
    }
}
export default UserController;
