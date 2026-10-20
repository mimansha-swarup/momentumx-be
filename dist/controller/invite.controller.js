import { asyncHandler } from "../middleware/async_handler.js";
class InviteController {
    constructor(repo, accounts) {
        this.repo = repo;
        this.accounts = accounts;
        // Public bearer-secret preview: masked email only. No account context exists before joining.
        this.preview = asyncHandler(async (req, res) => {
            res.sendSuccess({ data: await this.repo.preview(req.params.token) });
        });
        this.pending = asyncHandler(async (req, res) => {
            res.sendSuccess({ data: { invites: await this.repo.pending(req.userEmail, req.emailVerified) } });
        });
        this.accept = asyncHandler(async (req, res) => {
            const id = await this.repo.accept(req.params.token, req.userId, req.userEmail, req.emailVerified);
            const account = (await this.accounts.listAccounts(req.userId)).find((account) => account.id === id);
            res.sendSuccess({ data: { account } });
        });
    }
}
export default InviteController;
