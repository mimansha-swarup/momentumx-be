import { asyncHandler } from "../middleware/async_handler.js";
/** Thin wrapper over SharingRepository for the owner-gated member/invite routes. */
class SharingController {
    constructor(repo) {
        this.repo = repo;
        this.members = asyncHandler(async (req, res) => {
            res.sendSuccess({ data: await this.repo.members(req.params.id, req.userId) });
        });
        this.listInvites = asyncHandler(async (req, res) => {
            res.sendSuccess({ data: { invites: await this.repo.list(req.params.id, req.userId) } });
        });
        this.createInvite = asyncHandler(async (req, res) => {
            res.sendSuccess({
                statusCode: 201,
                data: await this.repo.create(req.params.id, req.userId, req.body.email, req.body.role),
            });
        });
        this.revokeInvite = asyncHandler(async (req, res) => {
            await this.repo.revoke(req.params.id, req.userId, req.params.token);
            res.sendSuccess({});
        });
        this.changeRole = asyncHandler(async (req, res) => {
            await this.repo.change(req.params.id, req.userId, req.params.uid, req.body.role);
            res.sendSuccess({});
        });
        this.removeMember = asyncHandler(async (req, res) => {
            await this.repo.change(req.params.id, req.userId, req.params.uid, null);
            res.sendSuccess({});
        });
        this.leave = asyncHandler(async (req, res) => {
            await this.repo.change(req.params.id, req.userId, req.userId, null);
            res.sendSuccess({});
        });
        this.transferOwnership = asyncHandler(async (req, res) => {
            await this.repo.change(req.params.id, req.userId, req.body.userId, "owner", true);
            res.sendSuccess({});
        });
    }
}
export default SharingController;
