import { asyncHandler } from "../middleware/async_handler.js";
class AccountController {
    constructor(service) {
        this.service = service;
        /**
         * The switcher's list, plus which channel a fresh tab should open in.
         *
         * `activeAccountId` comes from the SERVER's `lastActiveAccountId`, not from the
         * request: a tab opened cold has no header to send, and guessing the first row
         * would drop the user into a different channel than the one they left.
         */
        this.list = asyncHandler(async (req, res) => {
            const accounts = await this.service.listAccounts(req.userId);
            const activeAccountId = await this.service.resolveActiveAccountId(req.userId, accounts);
            res.sendSuccess({
                message: "Channels retrieved successfully",
                data: { accounts, activeAccountId },
            });
        });
        // Empty body by design — see AccountService.createAccount.
        this.create = asyncHandler(async (req, res) => {
            const account = await this.service.createAccount(req.userId);
            res.sendSuccess({
                statusCode: 201,
                message: "Channel created successfully",
                data: { account },
            });
        });
        this.getById = asyncHandler(async (req, res) => {
            const account = await this.service.getAccount(req.userId, req.params.id);
            res.sendSuccess({ message: "Channel retrieved successfully", data: { account } });
        });
        this.update = asyncHandler(async (req, res) => {
            const account = await this.service.updateAccount(req.userId, req.params.id, req.body);
            res.sendSuccess({ message: "Channel updated successfully", data: { account } });
        });
        this.activate = asyncHandler(async (req, res) => {
            await this.service.activateAccount(req.userId, req.params.id);
            res.sendSuccess({ statusCode: 204 });
        });
        this.remove = asyncHandler(async (req, res) => {
            await this.service.deleteAccount(req.userId, req.params.id);
            res.sendSuccess({ message: "Channel deleted successfully" });
        });
    }
}
export default AccountController;
