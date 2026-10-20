import { HttpError, ServiceUnavailable } from "../utlils/errors.js";
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
            // Saved artifacts own accounting atomically. A failed lock release must not
            // hide saved output. Stateless paid output instead requires accounting to
            // succeed before it is returned, since there is no saved artifact to recover.
            try {
                const settled = await this.billing.settle(charge, false);
                if (!settled) {
                    if (charge?.debited && !charge.outputPersisted)
                        throw ServiceUnavailable("Generation could not be completed. Please try again.");
                    console.error(JSON.stringify({ event: "generation_settle_superseded", kind: spec.kind, projectId: spec.projectId, userId: spec.actor.userId }));
                }
            }
            catch (error) {
                console.error(JSON.stringify({ event: "generation_release_failed", kind: spec.kind, message: error?.message }));
                if (charge?.debited && !charge.outputPersisted)
                    throw ServiceUnavailable("Generation could not be completed. Please try again.");
            }
            return out;
        };
    }
}
export default StepRunner;
