import { asyncHandler } from "../middleware/async_handler.js";
import { ownerOf } from "../utlils/content.js";
class BillingController {
    constructor(repo) {
        this.repo = repo;
        this.getBalance = asyncHandler(async (req, res) => {
            res.sendSuccess({
                message: "Credit balance",
                data: await this.repo.getBalance(ownerOf(req)),
            });
        });
    }
}
export default BillingController;
