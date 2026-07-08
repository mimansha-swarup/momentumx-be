import { asyncHandler } from "../middleware/async_handler.js";
class UserController {
    constructor(service) {
        // Body is validated + normalized by `validate(onboardingSchema)` at the route
        // (required fields, URL formats, trimming, unknown-key stripping) — the
        // controller stays thin and trusts req.body.
        this.saveOnboarding = asyncHandler(async (req, res) => {
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
