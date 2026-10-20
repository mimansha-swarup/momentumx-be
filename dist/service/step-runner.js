import { HttpError } from "../utlils/errors.js";
class StepRunner {
    // Narrowed to the two methods this actually calls. Nothing here needs the whole
    // repository, and the wide type is what forced every test double to be laundered
    // through `as unknown as BillingRepository` — a cast that hid a `reserve` returning
    // 3 of CreditReservation's 10 required fields.
    constructor(billing) {
        this.billing = billing;
        this.run = async (spec, generate) => {
            const charge = await this.billing.reserve(spec);
            let out;
            try {
                out = await generate(charge);
            }
            catch (error) {
                try {
                    // Releases the reservation. There is nothing to refund — `reserve` takes
                    // no money — so the honest thing to tell the caller is that they were
                    // not charged, which is now true of every failed run.
                    const released = await this.billing.settle(charge, true);
                    if (charge?.debited && released) {
                        if (!(error instanceof HttpError))
                            error = new HttpError("Generation failed. Please try again.", 503);
                        error.detail = { ...(typeof error.detail === "object" ? error.detail : {}), charged: false };
                    }
                }
                catch (refundError) {
                    console.error(JSON.stringify({ event: "generation_refund_failed", kind: spec.kind, message: refundError?.message }));
                }
                console.error(JSON.stringify({ event: "generation_failed", kind: spec.kind, projectId: spec.projectId, userId: spec.actor.userId, message: error?.message }));
                throw error;
            }
            // Content is saved, so THIS is where the credits are taken. A failure here
            // leaves the user with content they were not charged for — a far smaller
            // window than the old debit-up-front shape, which risked the opposite, and
            // the friendlier direction to err in.
            // `false` here (not a rejection) means this run was superseded and moved no
            // money — with the Fix 1 guard in place the save above is already refused
            // for a debited charge, so this is defence in depth, not the primary guard.
            await this.billing.settle(charge, false)
                .then(settled => { if (!settled)
                console.error(JSON.stringify({ event: "generation_settle_superseded", kind: spec.kind, projectId: spec.projectId, userId: spec.actor.userId })); })
                .catch(error => console.error(JSON.stringify({ event: "generation_release_failed", kind: spec.kind, message: error?.message })));
            return out;
        };
    }
}
export default StepRunner;
