import { asyncHandler } from "../middleware/async_handler.js";
class UserController {
    constructor(service) {
        // Body is validated + normalized by `validate(onboardingSchema)` at the route
        // (required fields, URL formats, trimming, unknown-key stripping) — the
        // controller stays thin and trusts req.body.
        this.saveOnboarding = asyncHandler(async (req, res) => {
            // Fast save — persists the provided fields only. Enrichment (channel titles,
            // website content, competitors) runs separately via refresh-context, which the
            // FE fires in the background, so there is no website-parsed status to report here.
            const payload = await this.service.createOnboardingData(req.userId, req.body);
            res.sendSuccess({
                message: "Onboarded successfully",
                data: { payload },
            });
        });
        // Body validated by `validate(prefillSchema)` — channelUrl is a valid YouTube
        // channel URL. Returns inferred suggestions (not persisted).
        this.prefill = asyncHandler(async (req, res) => {
            const data = await this.service.prefillFromChannel(req.body.channelUrl);
            res.sendSuccess({
                message: "Prefill suggestions generated",
                data,
            });
        });
        // Re-pull channel/website enrichment from the stored inputs (no body).
        this.refreshContext = asyncHandler(async (req, res) => {
            const payload = await this.service.refreshContext(req.userId);
            res.sendSuccess({
                message: "Context refreshed successfully",
                data: { ...payload },
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
