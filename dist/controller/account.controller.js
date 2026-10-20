import { publicAccount } from "../utlils/public-response.js";
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
        this.bootstrap = asyncHandler(async (req, res) => {
            // Bootstrap can ADOPT an existing membership — including one where the
            // caller is a viewer in a channel someone else owns — so it withholds the
            // roster exactly like `getById` below.
            const account = await this.service.bootstrapAccount(req.userId);
            res.sendSuccess({
                message: "Channel ready",
                data: { account: this.projectAccount(account, req.userId) },
            });
        });
        /**
         * Empty body by design — see AccountService.createAccount.
         *
         * Projected the same way `bootstrap` and `getById` are. This one mints a
         * brand-new channel where the caller is its sole member, so there is no
         * roster to leak — it is a consistency fix, not a leak fix: these three
         * endpoints all return `{ account }` meaning "here is your channel," and
         * three different shapes for that is worse than any one of them. This DOES
         * change the response shape callers see from `POST /v1/accounts` (adds
         * `role`/`isBillingOwner`/`memberCount`, drops `members`/`memberUids`/
         * `ownerUids`/`billingOwnerUid`) — a visible frontend contract change.
         */
        this.create = asyncHandler(async (req, res) => {
            const account = await this.service.createAccount(req.userId);
            res.sendSuccess({
                statusCode: 201,
                message: "Channel created successfully",
                data: { account: this.projectAccount(account, req.userId) },
            });
        });
        this.getById = asyncHandler(async (req, res) => {
            const account = await this.service.getAccount(req.userId, req.params.id);
            res.sendSuccess({
                message: "Channel retrieved successfully",
                data: { account: this.projectAccount(account, req.userId) },
            });
        });
        this.update = asyncHandler(async (req, res) => {
            const account = await this.service.updateAccount(req.userId, req.params.id, req.body);
            res.sendSuccess({ message: "Channel updated successfully", data: { account: this.projectAccount(account, req.userId) } });
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
    /**
     * Strip the membership roster out of an account before it leaves the API.
     *
     * The raw document is a membership roster: `members`, `memberUids`,
     * `ownerUids` and `billingOwnerUid` name every member's uid and role plus the
     * payer's uid. `GET /v1/accounts/:id/members` is `requireRole("owner")` AND
     * re-checks ownership inside its own transaction — shipping the roster here
     * handed every one of those fields to any member, viewers included, and the
     * owner gate on `/members` withheld only the display names and emails that
     * endpoint adds on top.
     *
     * The caller still learns their OWN role and whether they pay, which is what
     * the settings screen renders.
     */
    projectAccount(account, userId) {
        const { members, memberUids, billingOwnerUid } = account;
        return {
            ...publicAccount(account),
            role: members?.[userId]?.role ?? null,
            isBillingOwner: billingOwnerUid === userId,
            memberCount: memberUids?.length ?? 0,
        };
    }
}
export default AccountController;
