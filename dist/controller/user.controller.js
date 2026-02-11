class UserController {
    constructor(service) {
        this.saveOnboarding = async (req, res, next) => {
            try {
                const payload = await this.service.createOnboardingData(req.userId, req.body);
                const iSWebsiteParsed = !!payload?.websiteContent;
                res.sendSuccess({
                    warning: !iSWebsiteParsed ? " Website content is not parsed" : "",
                    message: "Onboarded  successfully",
                    data: { payload },
                });
            }
            catch (e) {
                next(e);
            }
        };
        this.getProfile = async (req, res, next) => {
            try {
                const payload = await this.service.getProfile(req.userId);
                res.sendSuccess({
                    message: "Fetched onboarding data successfully",
                    data: { ...(payload ?? {}) },
                });
            }
            catch (e) {
                next(e);
            }
        };
        this.updateProfile = (req, res, next) => {
            try {
                const payload = this.service.updateProfile(req.userId, req.body);
                res.sendSuccess({
                    message: "Profile updated successfully",
                    data: { payload },
                });
            }
            catch (e) {
                next(e);
            }
        };
        this.service = service;
    }
}
export default UserController;
