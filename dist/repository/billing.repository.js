import { memberRole } from "../utlils/account-member.js";
import { randomUUID } from "node:crypto";
import { db, firebase } from "../config/firebase.js";
import { CREDIT_COSTS } from "../constants/credits.js";
import { KIND_STEP, REQUIRES, STEP_LOCK_MS, STEP_ORDER } from "../constants/pipeline.js";
import { AccountForbidden, BadRequest, Conflict, Gone, InsufficientCredits, NotFound, RoleForbidden, ServiceUnavailable, WrongAccount } from "../utlils/errors.js";
const month = () => new Date().toISOString().slice(0, 7);
/**
 * How old a persisted lock is.
 *
 * `startedAt` is written as a SERVER timestamp: it was `Date.now()` from whichever
 * instance took the lock, and every other instance compared it against its own
 * clock. A writer five minutes fast made its lock look young for eight minutes
 * after it died; a slow one let a successor take over early. Server-written means
 * a skewed writer can no longer poison the value for everyone else.
 *
 * Numbers are still accepted: locks written before this change stored epoch millis.
 */
const lockAge = (startedAt) => {
    const millis = typeof startedAt === "number"
        ? startedAt
        : startedAt?.toMillis?.() ?? 0;
    return Date.now() - millis;
};
const lockStamp = () => firebase.firestore.FieldValue.serverTimestamp();
const resetsAt = (period) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 1)).toISOString();
const DISABLED = /^(unlimited|none|off)$/i;
const consumedCredits = (value) => {
    const amount = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0)
        throw ServiceUnavailable("Stored credit consumption is invalid");
    return amount;
};
const freshBalance = (stored, period) => {
    /**
     * Explicit per-owner override, then a legacy manually provisioned allowance,
     * then the environment default.
     *
     * `??` and not `!== undefined`: an `allowanceOverride` of **null** is an
     * operator CLEARING the override in the console, not a value. Treating it as
     * one made `Number(null) === 0` pass the null check and then fail the type
     * check, throwing 503 — and because `getBalance` shares this function, even
     * `GET /v1/billing` 503'd, so no API could read or repair the document. The
     * obvious way to remove a quota locked the payer out instead.
     */
    const configured = stored?.allowanceOverride ??
        (stored?.allowanceSource !== "default" ? stored?.allowance : undefined) ??
        process.env.MONTHLY_CREDIT_ALLOWANCE;
    /**
     * Metering off is a real, supported mode, and ABSENT CONFIG IS ONE OF ITS FORMS.
     *
     * This block used to throw ServiceUnavailable when nothing was configured, on the
     * reasoning that a dropped env var is indistinguishable from a deliberate choice and
     * should fail closed. That reasoning is defensible — and it is not the decision on
     * record. `docs/multi-account/phase-08-credits-and-metering.md` (see "Implementation
     * decisions", and lines 39-40) states the chosen behaviour explicitly: "The user chose
     * enforcement disabled until configured", and "No configured allowance means
     * enabled:false, allowance:null, remaining:null: generation remains available".
     *
     * Throwing here took down every balance read, every generation, and free prefill —
     * for an unconfigured install, which is the DEFAULT state. The asymmetry the old
     * comment complained about is the documented intent: absent -> disabled, INVALID ->
     * fail closed. A missing value is still not silent; it is logged once below.
     */
    const disabled = configured === undefined ||
        (typeof configured === "string" && DISABLED.test(configured.trim()));
    if (configured === undefined) {
        console.warn(JSON.stringify({ event: "billing_allowance_unconfigured", effect: "enforcement_disabled" }));
    }
    // Visible, but never fatal. The original code REFUSED a null override, on the
    // reasoning that it must not silently become the default — a fair concern with
    // an unrecoverable cure. Logging keeps the concern and drops the lockout.
    if (stored?.allowanceOverride === null) {
        console.warn(JSON.stringify({ event: "billing_override_cleared", allowanceSource: stored?.allowanceSource ?? "default" }));
    }
    const allowance = disabled ? null : Number(configured);
    if (allowance !== null &&
        ((typeof configured !== "number" && typeof configured !== "string") ||
            (typeof configured === "string" && !/^\d+$/.test(configured.trim())) ||
            !Number.isSafeInteger(allowance) ||
            allowance < 0)) {
        throw ServiceUnavailable("Monthly credit allowance configuration is invalid");
    }
    // A numeric string is what a JSON or CSV import writes. `allowance` has always
    // accepted one; `consumed` refusing it meant a plausible operator write bricked
    // the payer on a field the code could simply have read.
    const rawConsumed = stored?.periodStart === period && stored.consumed !== undefined ? stored.consumed : 0;
    const consumed = consumedCredits(rawConsumed);
    const enabled = allowance !== null;
    return { enabled, allowance, allowanceSource: stored?.allowanceSource ?? (stored?.allowance != null ? "override" : "default"), consumed, periodStart: period };
};
const present = (balance) => ({
    ...balance,
    remaining: balance.allowance === null ? null : Math.max(0, balance.allowance - balance.consumed),
    resetsAt: resetsAt(balance.periodStart), costs: CREDIT_COSTS,
});
const assertAccount = (account, actor) => {
    if (!account || !memberRole(account.members, actor.userId))
        throw AccountForbidden();
    if (account.orphanedAt)
        throw AccountForbidden("Channel needs ownership recovery; contact support");
    if (account.deletedAt)
        throw Gone();
    return account;
};
class BillingRepository {
    constructor() {
        this.getBalance = async (actor) => db.runTransaction(async (txn) => {
            const account = assertAccount((await txn.get(db.collection("accounts" /* COLLECTIONS.ACCOUNTS */).doc(actor.accountId))).data(), actor);
            const ref = db.collection("billing" /* COLLECTIONS.BILLING */).doc(account.billingOwnerUid);
            const stored = (await txn.get(ref)).data();
            const balance = freshBalance(stored, month());
            if (!stored || stored.periodStart !== balance.periodStart)
                txn.set(ref, balance, { merge: true });
            return present(balance);
        });
        // Fail closed: generation persistence also needs Firestore. A debit outage
        // cannot safely be treated as permission to run the paid operation.
        this.reserve = async (spec) => {
            const cost = CREDIT_COSTS[spec.kind];
            /**
             * `prefill` used to return here, on the FIRST line — before the membership
             * check, the viewer check and the in-flight lock.
             *
             * It is free, and stays free: its cost is 0, so it passes the balance check
             * even for an exhausted payer. But free is not the same as ungoverned.
             * `POST /v1/user/onboarding/prefill` spends a YouTube `search.list` (~101 of
             * a 10k daily quota) plus a Gemini call, and with no lock it could be run in
             * parallel on a loop, against distinct URLs so the 6h cache never hit —
             * exhausting the product's whole daily quota for every channel. It now takes
             * the same per-account lock as any other generation, so one channel cannot
             * have more than one in flight.
             */
            const token = randomUUID();
            return db.runTransaction(async (txn) => {
                const accountRef = db.collection("accounts" /* COLLECTIONS.ACCOUNTS */).doc(spec.actor.accountId);
                const account = assertAccount((await txn.get(accountRef)).data(), spec.actor);
                if (memberRole(account.members, spec.actor.userId) === "viewer")
                    throw RoleForbidden();
                if (!spec.projectId) {
                    const accountLock = account.generationLocks?.[spec.kind];
                    if (accountLock && lockAge(accountLock.startedAt) < STEP_LOCK_MS)
                        throw Conflict("Generation already in progress");
                }
                const billingRef = db.collection("billing" /* COLLECTIONS.BILLING */).doc(account.billingOwnerUid);
                const stored = (await txn.get(billingRef)).data();
                const periodStart = month();
                const lockKey = `${spec.actor.accountId}_${spec.projectId ?? "account"}_${spec.kind}`;
                const active = stored?.generationLocks?.[lockKey];
                if (active && lockAge(active.startedAt) < STEP_LOCK_MS)
                    throw Conflict("Generation already in progress");
                const step = spec.mode === "regenerate" ? undefined : KIND_STEP[spec.kind];
                let project;
                const projectRef = spec.projectId ? db.collection("videoProjects" /* COLLECTIONS.VIDEO_PROJECTS */).doc(spec.projectId) : undefined;
                if (projectRef) {
                    project = (await txn.get(projectRef)).data();
                    if (!project || project.isDeleted)
                        throw NotFound("Video project not found");
                    if (project.accountId !== spec.actor.accountId) {
                        const owning = (await txn.get(db.collection("accounts" /* COLLECTIONS.ACCOUNTS */).doc(project.accountId))).data();
                        if (owning && !owning.deletedAt && !owning.orphanedAt && memberRole(owning.members, spec.actor.userId))
                            throw WrongAccount({ accountId: project.accountId, displayName: owning.displayName });
                        throw AccountForbidden();
                    }
                    const projectLock = project.generationLocks?.[spec.kind];
                    if (projectLock && lockAge(projectLock.startedAt) < STEP_LOCK_MS)
                        throw Conflict("Generation already in progress");
                    if (step)
                        for (const required of REQUIRES[step]) {
                            if (project.pipeline[required]?.status !== "completed")
                                throw BadRequest(`${required} must be completed before generating ${step}`);
                        }
                    // Close the read-before-lock replay race. The next request replays for free.
                    if (spec.mode !== "regenerate") {
                        const resourceId = spec.kind === "script" ? project.scriptId : spec.kind === "hooks" ? project.hooksId : null;
                        if (resourceId) {
                            const existing = await txn.get(db.collection(spec.kind === "script" ? "scripts" /* COLLECTIONS.SCRIPTS */ : "hooks" /* COLLECTIONS.HOOKS */).doc(resourceId));
                            if (existing.exists)
                                throw Conflict(`${spec.kind} already generated; reload to open it`);
                        }
                        /**
                         * The same replay guard for packaging items, which had none.
                         *
                         * Only `script` and `hooks` were covered, so a lost response on
                         * `generate-description` — the reply dropped, the item already saved —
                         * recharged 2 credits on retry and overwrote the same single field. The
                         * user paid twice for one artifact. Deliberate regeneration is a
                         * different route (`mode: "regenerate"`), so nothing legitimate is
                         * blocked; the packaging doc's id IS the project id, so this is a point
                         * read rather than a lookup.
                         */
                        if (["title", "description", "thumbnail", "shorts"].includes(spec.kind)) {
                            const pkg = (await txn.get(db.collection("packaging" /* COLLECTIONS.PACKAGING */).doc(spec.projectId))).data();
                            if (pkg?.itemStatuses?.[spec.kind] === "completed") {
                                throw Conflict(`${spec.kind} already generated; reload to open it`);
                            }
                        }
                    }
                }
                // Deliberately AFTER every authorization and precondition check.
                // `freshBalance` throws on a misconfigured allowance, and evaluating it
                // earlier meant a billing-config problem PRE-EMPTED a 403: reaching another
                // channel's project answered 503 "not configured" instead of refusing the
                // access. An authorization outcome must never depend on billing config.
                const balance = freshBalance(stored, periodStart);
                // `title` is its OWN pipeline step with its own price, so it gets its own
                // bucket. Folding it in with description/thumbnail/shorts meant
                // `usage/{month}.packaging` counted four different actions, and per-channel
                // usage could not be reconciled against what the user actually did.
                const counter = spec.kind === "script" ? "scripts" : ["description", "thumbnail", "shorts"].includes(spec.kind) ? "packaging" : spec.kind;
                // A takeover inherits the original rollback state, not the abandoned run's spinner.
                let prior = step && project
                    ? project.generationLocks?.[spec.kind]?.prior ?? project.pipeline[step] ?? { status: "not_started", startedAt: null, completedAt: null }
                    : undefined;
                const previousLock = project?.generationLocks?.[spec.kind];
                if (previousLock && !previousLock.prior && prior?.status === "in_progress" && project) {
                    // Older locks lack a snapshot. Keep saved choices; reset only abandoned work.
                    const resourceId = step === "script" ? project.scriptId : step === "hooks" ? project.hooksId : spec.projectId;
                    const collection = step === "script" ? "scripts" /* COLLECTIONS.SCRIPTS */ : step === "hooks" ? "hooks" /* COLLECTIONS.HOOKS */ : "packaging" /* COLLECTIONS.PACKAGING */;
                    const artifact = resourceId ? (await txn.get(db.collection(collection).doc(resourceId))).data() : undefined;
                    const hasOutput = step === "title" ? Boolean(artifact?.titles?.length) : Boolean(artifact);
                    if (!hasOutput)
                        prior = { ...prior, status: prior.staleReason ? "stale" : "not_started", startedAt: null, completedAt: null };
                }
                const debited = balance.enabled && cost > 0;
                /**
                 * Credits are RESERVED here and charged in `settle` once content exists.
                 *
                 * Debiting here instead was the shape that lost users' money. `settle` only
                 * ever runs in the same invocation, so anything that killed the process
                 * between the debit and the save — and on Vercel's default function budget,
                 * against a 120s model call, that is the ordinary case for idea generation —
                 * took the credits and produced nothing, with no path to get them back
                 * before the monthly reset. It also made every failure a REFUND, and a
                 * refund cannot tell "the model never answered" from "the script is saved
                 * and the second write failed", so a fully delivered script was handed back
                 * for free.
                 *
                 * A reservation has neither problem: a crash charges nothing, and only the
                 * success path moves money.
                 *
                 * Concurrency still cannot overspend, because a reservation counts against
                 * the balance exactly like a debit for as long as its lock is live. The
                 * receipt is keyed by token and the lock carries that same token, so
                 * liveness needs no second timestamp — and an abandoned reservation stops
                 * counting the moment its lock expires, which is also what lets a retry
                 * through.
                 */
                const live = new Set(Object.values(stored?.generationLocks ?? {})
                    .filter((lock) => lockAge(lock.startedAt) < STEP_LOCK_MS)
                    .map((lock) => lock.token));
                const pending = { ...(stored?.pendingCharges ?? {}) };
                // A reservation whose lock has expired is abandoned: it holds no money and
                // must not hold a slot either. This is what retires the old 256-receipt
                // ServiceUnavailable, which turned a crashed generation into a hard refusal
                // of ALL paid generation for that payer for the rest of the month.
                // Prune only what is ABANDONED. This used to also delete every receipt from a
                // previous period, which conflated two different jobs and lost money-adjacent
                // state: a September generation still running when an October reservation swept
                // its receipt then hit `return false` in `settle` — before any writes — so its
                // usage went unrecorded AND its generation locks were never released, blocking
                // that kind until they aged out.
                for (const id of Object.keys(pending)) {
                    if (!live.has(id))
                        delete pending[id];
                }
                // Only THIS period's reservations count against THIS period's allowance. A live
                // older-period receipt survives above so `settle` can still find it, but it must
                // not consume the new month's headroom.
                const reserved = Object.values(pending).reduce((total, receipt) => receipt.periodStart === periodStart
                    ? total + (receipt.cost ?? 0)
                    : total, 0);
                if (debited && balance.consumed + reserved + cost > balance.allowance) {
                    throw InsufficientCredits(`Not enough credits. Your allowance resets on ${resetsAt(periodStart).slice(0, 10)}.`, { ...present(balance), required: cost });
                }
                if (debited)
                    pending[token] = { periodStart, cost };
                // Free runs still need a settlement receipt so `settle` is idempotent.
                const usageReceipts = { ...(stored?.usageReceipts ?? {}) };
                if (!debited) {
                    const previous = new Date(Date.UTC(Number(periodStart.slice(0, 4)), Number(periodStart.slice(5)) - 2, 1)).toISOString().slice(0, 7);
                    for (const [id, receipt] of Object.entries(usageReceipts)) {
                        if (receipt.periodStart < previous)
                            delete usageReceipts[id];
                    }
                    while (Object.keys(usageReceipts).length >= 256)
                        delete usageReceipts[Object.keys(usageReceipts)[0]];
                    usageReceipts[token] = { periodStart };
                }
                // The lock and the reservation commit together.
                const generationLocks = Object.fromEntries(Object.entries(stored?.generationLocks ?? {}).filter(([, lock]) => lockAge(lock.startedAt) < STEP_LOCK_MS));
                generationLocks[lockKey] = { token, startedAt: lockStamp() };
                // `consumed` is deliberately written unchanged: this persists a period
                // rollover and an allowance change, and nothing else.
                txn.set(billingRef, { ...balance }, { merge: true });
                txn.update(billingRef, { pendingCharges: pending, usageReceipts, generationLocks });
                txn.update(projectRef ?? accountRef, { [`generationLocks.${spec.kind}`]: { token, startedAt: lockStamp(), ...(prior ? { prior } : {}) } });
                if (step && project && projectRef && prior?.status !== "completed") {
                    txn.update(projectRef, {
                        [`pipeline.${step}.status`]: "in_progress",
                        [`pipeline.${step}.startedAt`]: firebase.firestore.FieldValue.serverTimestamp(),
                        ...(STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf(project.currentStep) ? { currentStep: step } : {}),
                    });
                }
                return { ownerUid: account.billingOwnerUid, accountId: spec.actor.accountId, actorUserId: spec.actor.userId, periodStart, cost, debited, counter, lockKey, token, projectId: spec.projectId, kind: spec.kind, step, prior };
            });
        };
        /**
         * Release the reservation, and CHARGE it only if content was produced.
         *
         * This is where money moves. A failure moves none — there is nothing to refund,
         * because `reserve` took nothing. That is the whole reason the old
         * "debit-then-refund" shape is gone: a refund had to guess whether the run left
         * anything durable behind, and it guessed wrong in both directions.
         */
        this.settle = async (charge, failed) => {
            if (!charge)
                return true;
            return db.runTransaction(async (txn) => {
                const ref = db.collection("billing" /* COLLECTIONS.BILLING */).doc(charge.ownerUid);
                const billing = (await txn.get(ref)).data();
                const usageRef = db.collection("accounts" /* COLLECTIONS.ACCOUNTS */).doc(charge.accountId).collection("usage" /* SUBCOLLECTIONS.USAGE */).doc(charge.periodStart);
                // Read before any write, and only the success path needs it now.
                const usage = failed ? undefined : (await txn.get(usageRef)).data();
                const projectRef = charge.projectId ? db.collection("videoProjects" /* COLLECTIONS.VIDEO_PROJECTS */).doc(charge.projectId) : db.collection("accounts" /* COLLECTIONS.ACCOUNTS */).doc(charge.accountId);
                const project = projectRef ? (await txn.get(projectRef)).data() : undefined;
                const ownsProjectLock = project?.generationLocks?.[charge.kind]?.token === charge.token;
                const ownsLock = billing?.generationLocks?.[charge.lockKey]?.token === charge.token;
                const receipt = billing?.pendingCharges?.[charge.token];
                // Only the CHARGING path has to happen exactly once: the receipt is the
                // token that permits a charge, and it is consumed below, so a retried
                // settle cannot bill twice.
                //
                // A failed run is deliberately not gated this way. It moves no money, so
                // there is nothing to double, and its receipt may already have been swept
                // by a successor that took over the expired lock. Refusing then would mean
                // a superseded run could not report "you were not charged" — which is the
                // one thing it always knows to be true.
                if (!failed && (charge.debited ? !receipt : !billing?.usageReceipts?.[charge.token] && !ownsLock))
                    return false;
                const updates = {};
                if (ownsLock)
                    updates[`generationLocks.${charge.lockKey}`] = firebase.firestore.FieldValue.delete();
                if (billing?.usageReceipts?.[charge.token])
                    updates[`usageReceipts.${charge.token}`] = firebase.firestore.FieldValue.delete();
                if (receipt)
                    updates[`pendingCharges.${charge.token}`] = firebase.firestore.FieldValue.delete();
                // The charge itself. Skipped across a period boundary: the rollover already
                // zeroed `consumed`, and billing a September run against October's allowance
                // would take credits the user did not spend this month.
                const chargeable = !failed && charge.debited && billing?.periodStart === charge.periodStart;
                if (chargeable) {
                    const current = consumedCredits(billing?.consumed === undefined ? 0 : billing.consumed);
                    updates.consumed = consumedCredits(current + charge.cost); // Also reject integer overflow.
                }
                // A superseded run may own nothing left to clean up, and Firestore rejects
                // an update with no fields.
                if (Object.keys(updates).length)
                    txn.update(ref, updates);
                if (projectRef && ownsProjectLock)
                    txn.update(projectRef, { [`generationLocks.${charge.kind}`]: firebase.firestore.FieldValue.delete() });
                if (!failed) {
                    // Per-channel usage counts what was DELIVERED, so it is written here
                    // rather than at reserve — a crashed run now inflates neither the credits
                    // spent nor the action count.
                    txn.set(usageRef, { credits: (usage?.credits ?? 0) + charge.cost, [charge.counter]: (usage?.[charge.counter] ?? 0) + 1 }, { merge: true });
                }
                if (failed && ownsLock && ownsProjectLock && charge.projectId && charge.step && charge.prior && project?.pipeline?.[charge.step]?.status === "in_progress") {
                    txn.update(db.collection("videoProjects" /* COLLECTIONS.VIDEO_PROJECTS */).doc(charge.projectId), {
                        [`pipeline.${charge.step}.status`]: charge.prior.status,
                        [`pipeline.${charge.step}.startedAt`]: charge.prior.startedAt ?? null,
                        [`pipeline.${charge.step}.staleReason`]: charge.prior.staleReason ?? null,
                    });
                }
                return true;
            });
        };
    }
}
export default BillingRepository;
