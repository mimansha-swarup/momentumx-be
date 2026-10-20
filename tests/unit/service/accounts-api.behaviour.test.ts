/**
 * Phase 06a — the endpoints the switcher talks to.
 *
 * Written against the phase's own acceptance list rather than the implementation,
 * so the things that are easy to get subtly wrong are the things asserted:
 * `isOnboarded` sourced per-channel, `projectCount` reflecting the account filter,
 * the last-channel refusal, and one writer for the three membership fields.
 */

jest.mock("../../../src/config/firebase", () =>
  require("../../helpers/fake-firestore").mockFirebase()
);

import { FakeFirestore } from "../../helpers/fake-firestore";
import AccountRepository from "../../../src/repository/account.repository";
import UserRepository from "../../../src/repository/user.repository";
import VideoProjectRepository from "../../../src/repository/video-project.repository";
import AccountService, {
  buildOwnedAccount,
  isChannelOnboarded,
} from "../../../src/service/account.service";

const db = (require("../../../src/config/firebase") as { __db: FakeFirestore }).__db;

const ACC_A = "acc-aaaaaaaa-1111-4111-8111-111111111111";
const ACC_B = "acc-bbbbbbbb-2222-4222-8222-222222222222";
const uid = "uid-owner";
const mate = "uid-mate";

const make = () =>
  new AccountService(new AccountRepository(), new UserRepository(), new VideoProjectRepository());

const account = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  displayName: "My Channel",
  handle: null,
  memberUids: [uid],
  ownerUids: [uid],
  members: { [uid]: { role: "owner" } },
  billingOwnerUid: uid,
  deletedAt: null,
  ...over,
});

const seedContext = (accountId: string, context: Record<string, unknown>) =>
  db.seed(`accounts/${accountId}/context`, [{ id: "channel", ...context }]);

beforeEach(() => {
  db.data.clear();
  db.seed("users", [{ id: uid, lastActiveAccountId: ACC_A }]);
  db.seed("accounts", [account(ACC_A), account(ACC_B, { displayName: "Second Channel" })]);
  seedContext(ACC_A, { userName: "https://youtube.com/@cooking", niche: "cooking" });
  seedContext(ACC_B, {});
  db.seed("videoProjects", [
    { id: "p1", accountId: ACC_A, createdBy: uid, isDeleted: false },
    { id: "p2", accountId: ACC_A, createdBy: uid, isDeleted: false },
    { id: "p3", accountId: ACC_A, createdBy: uid, isDeleted: true },
    { id: "p4", accountId: ACC_B, createdBy: uid, isDeleted: false },
  ]);
});

describe("GET /v1/accounts — the switcher's list", () => {
  it("returns one row per live membership, with the caller's role", async () => {
    const rows = await make().listAccounts(uid);

    expect(rows.map((r) => r.id).sort()).toEqual([ACC_A, ACC_B]);
    expect(rows.every((r) => r.role === "owner")).toBe(true);
  });

  it("counts only that channel's live projects", async () => {
    // Deleted projects excluded, and the other channel's never counted. This is
    // the field that makes a Phase 06 query filtering the wrong thing visible
    // from the menu — "0 videos" beside a channel the user knows has forty.
    const rows = await make().listAccounts(uid);
    const counts = Object.fromEntries(rows.map((r) => [r.id, r.projectCount]));

    expect(counts).toEqual({ [ACC_A]: 2, [ACC_B]: 1 });
  });

  it("derives isOnboarded PER CHANNEL, not from the user record", async () => {
    // The whole reason this is server-side. Sourced from the user record, every
    // channel a user owns would report the first one's answers — so a channel
    // created seconds ago would claim to be onboarded and the switcher would send
    // them to a dashboard with nothing in it.
    const rows = await make().listAccounts(uid);
    const onboarded = Object.fromEntries(rows.map((r) => [r.id, r.isOnboarded]));

    expect(onboarded).toEqual({ [ACC_A]: true, [ACC_B]: false });
  });

  it("never lists a tombstoned channel", async () => {
    db.seed("accounts", [account(ACC_B, { deletedAt: "2026-08-01" })]);

    expect((await make().listAccounts(uid)).map((r) => r.id)).toEqual([ACC_A]);
  });

  it("lists nothing for a user who is a member of nothing — and mints nothing", async () => {
    // The freelancer case, inverted. Reading the list must never be the thing
    // that creates a channel; Phase 07's onboarding gate would then walk an
    // invite-only user through setting up a channel they never wanted.
    const rows = await make().listAccounts("uid-stranger");

    expect(rows).toEqual([]);
    expect(db.all("accounts")).toHaveLength(2);
  });
});

describe("activeAccountId — what a cold tab opens", () => {
  it("is the stored pointer when it still names a channel the caller can enter", async () => {
    const service = make();
    const rows = await service.listAccounts(uid);

    expect(await service.resolveActiveAccountId(uid, rows)).toBe(ACC_A);
  });

  it("falls back when the pointer names a channel that is gone", async () => {
    // Otherwise a cold tab opens straight into a 410 loop on a channel the user
    // deleted from another device.
    db.seed("users", [{ id: uid, lastActiveAccountId: "acc-deleted" }]);
    const service = make();

    const rows = await service.listAccounts(uid);
    expect(await service.resolveActiveAccountId(uid, rows)).toBe(rows[0].id);
  });

  it("is null when there is nothing to open", async () => {
    const service = make();
    expect(await service.resolveActiveAccountId("uid-stranger", [])).toBeNull();
  });
});

describe("bootstrapAccount — one initial channel", () => {
  it("reuses a live membership even when the stored pointer is stale", async () => {
    db.seed("users", [{ id: uid, lastActiveAccountId: "gone" }]);
    const resolved = await make().bootstrapAccount(uid);
    expect(resolved.id).toBe(ACC_A);
    expect(db.all("accounts")).toHaveLength(2);
  });

  it.each(["missing", "deleted", "departed"])("repairs a %s pointer without adopting an inaccessible channel", async (kind) => {
    db.data.clear();
    db.seed("users", [{ id: uid, lastActiveAccountId: ACC_A }]);
    if (kind !== "missing") db.seed("accounts", [account(ACC_A, kind === "deleted"
      ? { deletedAt: "yesterday" }
      : { memberUids: [mate] })]);
    const resolved = await make().bootstrapAccount(uid);
    expect(resolved.id).not.toBe(ACC_A);
    expect(resolved.memberUids).toContain(uid);
    expect((await make().bootstrapAccount(uid)).id).toBe(resolved.id);
  });

  it("concurrent initial bootstraps converge through the transactional pointer claim", async () => {
    db.data.clear();
    db.seed("users", [{ id: uid }]);
    // Model Firestore's serializable transactions. The shared fake deliberately
    // does not model retries; serialize only transaction commits in this check.
    const transaction = db.runTransaction.bind(db);
    let tail: Promise<unknown> = Promise.resolve();
    const spy = jest.spyOn(db, "runTransaction").mockImplementation((fn) => {
      const next = tail.then(() => transaction(fn));
      tail = next;
      return next as never;
    });
    try {
      const [first, second] = await Promise.all([make().bootstrapAccount(uid), make().bootstrapAccount(uid)]);
      expect(first.id).toBe(second.id);
      expect(db.all("accounts")).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST /v1/accounts — create a channel", () => {
  it("creates an additional channel rather than adopting the active one", async () => {
    // `ensureDefaultAccount` is idempotent through `lastActiveAccountId`, because
    // two concurrent first-requests must converge. Create must NOT share that:
    // pressing the button while already in a channel would silently hand back the
    // channel the user is standing in.
    const created = await make().createAccount(uid);

    expect(created.id).not.toBe(ACC_A);
    expect(db.all("accounts")).toHaveLength(3);
  });

  it("starts empty, so the switcher routes it to onboarding", async () => {
    const service = make();
    const created = await service.createAccount(uid);

    const row = (await service.listAccounts(uid)).find((r) => r.id === created.id)!;
    expect(row.isOnboarded).toBe(false);
    expect(row.projectCount).toBe(0);
  });

  it("makes the new channel active, so create needs no follow-up call", async () => {
    const created = await make().createAccount(uid);

    expect(db.all("users").find((u) => u.id === uid)!.lastActiveAccountId).toBe(created.id);
  });

  it("writes the three membership fields together, from the one helper", async () => {
    // Phase 02 and Phase 09 both state this rule, and the plan broke it at the
    // design level: two independent writers of memberUids/ownerUids/members is
    // how you get a member who can query an account but has no role.
    const created = await make().createAccount(uid);
    const stored = db.all("accounts").find((a) => a.id === created.id)!;

    expect(stored.memberUids).toEqual([uid]);
    expect(stored.ownerUids).toEqual([uid]);
    expect((stored.members as Record<string, { role: string }>)[uid].role).toBe("owner");
  });
});

describe("buildOwnedAccount — the one writer", () => {
  it("keeps the array, the owner list and the role map in agreement", () => {
    const built = buildOwnedAccount("uid-x", { displayName: "X", handle: null });

    expect(built.memberUids).toEqual(["uid-x"]);
    expect(built.ownerUids).toEqual(["uid-x"]);
    expect(Object.keys(built.members)).toEqual(["uid-x"]);
    expect(built.billingOwnerUid).toBe("uid-x");
  });

  it("mints a UUID v4, never the uid", () => {
    // Under the retired `accounts/{uid}` scheme a bug passing a uid where an
    // accountId belongs still isolated correctly and was invisible. Disjoint id
    // spaces are what make that class fail loudly instead.
    const built = buildOwnedAccount("uid-x", { displayName: "X", handle: null });

    expect(built.id).not.toBe("uid-x");
    expect(built.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});

describe("isChannelOnboarded — the same rule the frontend routes on", () => {
  it.each([
    ["a channel URL alone", { userName: "https://youtube.com/@x" }, true],
    ["niche and audience together", { niche: "cooking", targetAudience: "home cooks" }, true],
    ["niche alone", { niche: "cooking" }, false],
    ["audience alone", { targetAudience: "home cooks" }, false],
    ["whitespace only", { niche: "   ", targetAudience: "  " }, false],
    ["nothing at all", {}, false],
  ])("%s → %s", (_case, context, expected) => {
    expect(isChannelOnboarded(context as never)).toBe(expected);
  });

  it("is false for a channel with no context document at all", () => {
    expect(isChannelOnboarded(null)).toBe(false);
  });
});

describe("DELETE /v1/accounts/:id", () => {
  it("tombstones rather than removing, so a stale link can still 410", async () => {
    await make().deleteAccount(uid, ACC_B);
    const stored = db.all("accounts").find((a) => a.id === ACC_B)!;

    expect(stored).toBeDefined();
    expect(stored.deletedAt).toBeTruthy();
  });

  it("refuses the user's last channel", async () => {
    // Without this, deleting the only channel makes the next request find zero
    // memberships and mint a fresh empty one — so "delete my channel" becomes
    // "replace my channel with an empty one", and every document still carrying
    // the old accountId is present, billable and unreachable.
    await make().deleteAccount(uid, ACC_B);

    await expect(make().deleteAccount(uid, ACC_A)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.all("accounts").find((a) => a.id === ACC_A)!.deletedAt).toBeNull();
  });

  it("clears the pointer when the deleted channel was the active one", async () => {
    await make().deleteAccount(uid, ACC_A);

    expect(db.all("users").find((u) => u.id === uid)!.lastActiveAccountId).toBeNull();
  });

  it("refuses a member who is not an owner, with role_forbidden", async () => {
    db.seed("accounts", [
      account(ACC_B, { memberUids: [uid, mate], members: { [uid]: { role: "owner" }, [mate]: { role: "editor" } } }),
    ]);

    await expect(make().deleteAccount(mate, ACC_B)).rejects.toMatchObject({
      statusCode: 403,
      code: "role_forbidden",
    });
  });

  /**
   * Firestore does not cascade. Tombstoning the account left every idea,
   * script, hook batch, packaging doc, project and event exactly where it was —
   * present and billable, invisible only because every query filters accountId.
   * Phase 05 requires enumerate-and-delete or mark-and-sweep; Phase 06a shipped
   * the endpoint doing neither and marked it done.
   */
  describe("purges the channel's content, because Firestore will not", () => {
    const seedContent = (accountId: string) => {
      db.seed("ideas", [
        { id: `i1-${accountId}`, accountId },
        { id: `i2-${accountId}`, accountId },
      ]);
      db.seed("scripts", [{ id: `s1-${accountId}`, accountId }]);
      db.seed("hooks", [{ id: `h1-${accountId}`, accountId }]);
      db.seed("packaging", [{ id: `p1-${accountId}`, accountId }]);
      db.seed("videoProjects", [{ id: `v1-${accountId}`, accountId }]);
      db.seed("events", [{ id: `e1-${accountId}`, accountId }]);
      db.seed("invites", [{ id: `inv1-${accountId}`, accountId, email: "guest@example.com", status: "pending" }]);
    };

    it("deletes every tenancy collection's documents for that channel", async () => {
      seedContent(ACC_B);

      await make().deleteAccount(uid, ACC_B);

      for (const collection of ["ideas", "scripts", "hooks", "packaging", "videoProjects"]) {
        expect(db.all(collection).filter((d) => d.accountId === ACC_B)).toEqual([]);
      }
    });

    it("purges invitations, which carry a third party's email and the channel's name", async () => {
      // Nothing else in the codebase deletes an invite. Left behind, they kept the
      // deleted channel's name answerable from the UNAUTHENTICATED preview route
      // indefinitely, and kept costing every invitee an account read per inbox
      // load — and no API could sweep them afterwards, because every path through
      // a tombstoned account throws.
      seedContent(ACC_B);
      seedContent(ACC_A);

      await make().deleteAccount(uid, ACC_B);

      expect(db.all("invites").filter((d) => d.accountId === ACC_B)).toEqual([]);
      // The other channel's invitations are untouched.
      expect(db.all("invites").filter((d) => d.accountId === ACC_A)).toHaveLength(1);
    });

    it("RETAINS the telemetry log, which the content purge must not touch", async () => {
      // Product decision: `events` is append-only telemetry and the only record of
      // what a channel did — needed to answer a support ticket or spot abuse, and
      // impossible to reconstruct. It is retained and simply not surfaced, rather
      // than destroyed with the channel. Nothing in the API reads it, so keeping
      // it exposes nothing.
      seedContent(ACC_B);

      await make().deleteAccount(uid, ACC_B);

      expect(db.all("events").filter((d) => d.accountId === ACC_B).length).toBeGreaterThan(0);
    });

    it("leaves the OTHER channel's content completely alone", async () => {
      // The purge is a destructive query. Getting its filter wrong deletes a
      // channel the user never asked to touch, and nothing would report it.
      seedContent(ACC_A);
      seedContent(ACC_B);

      await make().deleteAccount(uid, ACC_B);

      // By id, not by count — the shared fixture already seeds projects for A.
      for (const [collection, id] of [
        ["ideas", `i1-${ACC_A}`],
        ["scripts", `s1-${ACC_A}`],
        ["hooks", `h1-${ACC_A}`],
        ["packaging", `p1-${ACC_A}`],
        ["videoProjects", `v1-${ACC_A}`],
        ["events", `e1-${ACC_A}`],
      ]) {
        expect(db.all(collection).map((d) => d.id)).toContain(id);
      }
    });

    it("deletes the channel context subcollection, not just the account document", async () => {
      // The one that matters most for a deletion request: it holds the niche,
      // the competitor list and the scraped website text. A subcollection is not
      // removed with its parent.
      seedContext(ACC_B, { niche: "cooking", websiteContent: "scraped page text" });

      await make().deleteAccount(uid, ACC_B);

      expect(db.all(`accounts/${ACC_B}/context`)).toEqual([]);
    });

    /**
     * The paging loop was entirely unexercised: every other fixture seeds two
     * documents, so the first page is always short and the loop always exits
     * after one pass. Replacing the whole `while` with a single get+commit kept
     * the suite green while a channel with more than one page kept everything
     * past the first 450 — the "present and billable" state the purge exists to
     * end.
     */
    it("pages past the batch limit instead of stopping at the first 450", async () => {
      db.seed(
        "ideas",
        Array.from({ length: 1000 }, (_, i) => ({ id: `bulk-${i}`, accountId: ACC_B }))
      );

      await make().deleteAccount(uid, ACC_B);

      expect(db.all("ideas").filter((d) => d.accountId === ACC_B)).toEqual([]);
    });

    /**
     * The cap used to be ONE counter shared across the `for` loop, so a channel
     * whose first collection exhausted it left the remaining five never even
     * queried — five whole collections skipped, chosen by array order, with
     * nothing logged. A per-collection cap cannot starve a sibling.
     */
    it("a huge collection does not starve the others", async () => {
      const repo = new AccountRepository();
      db.seed(
        "ideas",
        Array.from({ length: 2500 }, (_, i) => ({ id: `many-${i}`, accountId: ACC_B }))
      );
      db.seed("videoProjects", [{ id: "vp-1", accountId: ACC_B }]);

      db.seed("accounts", [account(ACC_B, { deletedAt: "now" })]);
      const { incomplete } = await repo.purgeAccountData(ACC_B, 1000);

      // Ideas hit the cap and are reported as unfinished...
      expect(incomplete).toContain("ideas");
      // ...but videoProjects, last in the list, were still swept. A per-collection
      // cap is what stops one huge collection consuming the whole budget.
      expect(db.all("videoProjects").filter((d) => d.accountId === ACC_B)).toEqual([]);
    });

    it("reports which collections it could not finish, rather than returning a bare count", async () => {
      const repo = new AccountRepository();
      db.seed(
        "scripts",
        Array.from({ length: 1200 }, (_, i) => ({ id: `s-${i}`, accountId: ACC_B }))
      );

      db.seed("accounts", [account(ACC_B, { deletedAt: "now" })]);
      const { deleted, incomplete } = await repo.purgeAccountData(ACC_B, 900);

      expect(incomplete).toEqual(["scripts"]);
      expect(deleted).toBeGreaterThanOrEqual(900);
    });

    it("deletes the channel context FIRST, so a later failure cannot strand it", async () => {
      // It holds the niche, the competitor list and the website scrape — the
      // data a deletion request is actually about. Deleting it last meant a
      // timeout part-way through the content loop left exactly that behind, and
      // the tombstone makes the operation unrepeatable through the API.
      seedContext(ACC_B, { niche: "cooking", websiteContent: "scraped page text" });
      db.seed("ideas", [{ id: "i-1", accountId: ACC_B }]);

      const repo = new AccountRepository();
      const realBatch = db.batch.bind(db);
      let calls = 0;
      // Fail the FIRST content batch — the context is already gone by then.
      jest.spyOn(db, "batch").mockImplementation(() => {
        if (calls++ === 0) throw new Error("firestore unavailable");
        return realBatch();
      });

      db.seed("accounts", [account(ACC_B, { deletedAt: "now" })]);
      await expect(repo.purgeAccountData(ACC_B)).rejects.toThrow("firestore unavailable");
      expect(db.all(`accounts/${ACC_B}/context`)).toEqual([]);

      jest.restoreAllMocks();
    });

    it("a failed purge still leaves the channel deleted, and says so in the log", async () => {
      const warn = jest.spyOn(console, "error").mockImplementation(() => undefined);
      // An arrow-function class property, so it lives on the INSTANCE — the
      // service has to be built around the spied repo.
      const repo = new AccountRepository();
      repo.purgeAccountData = jest.fn().mockRejectedValue(new Error("firestore unavailable"));
      const service = new AccountService(repo, new UserRepository(), new VideoProjectRepository());

      // Not a 500: the tombstone already committed, so the channel IS gone, and
      // a retry would hit `assertOwner` → 410 with the remainder unsweepable.
      await expect(service.deleteAccount(uid, ACC_B)).resolves.toBeUndefined();

      const logged = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("purge_failed"));
      expect(logged).toBeDefined();
      expect(JSON.parse(logged!)).toMatchObject({
        event: "account_purge_failed",
        accountId: ACC_B,
      });

      warn.mockRestore();
    });

    it("does not purge anything when the last-channel refusal fires", async () => {
      seedContent(ACC_A);
      await make().deleteAccount(uid, ACC_B);

      await expect(make().deleteAccount(uid, ACC_A)).rejects.toMatchObject({ statusCode: 400 });

      expect(db.all("ideas").filter((d) => d.accountId === ACC_A)).toHaveLength(2);
    });
  });

  it("refuses a stranger with account_forbidden, not role_forbidden", async () => {
    // The client branches on these: account_forbidden ejects to the channel list,
    // role_forbidden shows an inline message. Telling a non-member their role is
    // wrong would also confirm the channel exists.
    await expect(make().deleteAccount("uid-stranger", ACC_B)).rejects.toMatchObject({
      code: "account_forbidden",
    });
  });
});

describe("GET, PATCH and activate on a single channel", () => {
  it("reads a channel the caller belongs to", async () => {
    await expect(make().getAccount(uid, ACC_A)).resolves.toMatchObject({ id: ACC_A });
  });

  it("refuses one they do not, without revealing whether it exists", async () => {
    await expect(make().getAccount("uid-stranger", ACC_A)).rejects.toMatchObject({
      statusCode: 403,
      code: "account_forbidden",
    });
    await expect(make().getAccount(uid, "acc-does-not-exist")).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("renames a channel, owner only", async () => {
    await make().updateAccount(uid, ACC_A, { displayName: "  Renamed  " });

    expect(db.all("accounts").find((a) => a.id === ACC_A)!.displayName).toBe("Renamed");
  });

  it("refuses a blank rename rather than storing one", async () => {
    // displayName is what the switcher renders; an empty one is a row with
    // nothing to click.
    await expect(make().updateAccount(uid, ACC_A, { displayName: "   " })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("lets an owner fix a handle, which was otherwise permanent", async () => {
    // `adoptChannelIdentity` fills a BLANK handle from whatever channel URL
    // onboarding was given — and onboarding is `requireRole("editor")` while
    // rename is owner-only. So an editor could set a bare channel's handle once
    // and no route could ever change it: adoption only fills blanks, and this
    // patch accepted `displayName` alone.
    db.seed("accounts", [account(ACC_A, { handle: "@wrong" })]);

    await make().updateAccount(uid, ACC_A, { handle: "  @right  " });

    expect(db.all("accounts").find((a) => a.id === ACC_A)!.handle).toBe("@right");
  });

  it("lets an owner clear a handle outright", async () => {
    db.seed("accounts", [account(ACC_A, { handle: "@wrong" })]);

    await make().updateAccount(uid, ACC_A, { handle: null });

    expect(db.all("accounts").find((a) => a.id === ACC_A)!.handle).toBeNull();
  });

  it("refuses a rename from a member who is not an owner", async () => {
    // The check now lives INSIDE the writing transaction. It used to be a
    // separate read, so a demotion committing in the gap let a now-non-owner's
    // rename land anyway.
    db.seed("accounts", [
      account(ACC_A, {
        memberUids: [uid, "uid-editor"],
        ownerUids: [uid],
        members: { [uid]: { role: "owner" }, "uid-editor": { role: "editor" } },
      }),
    ]);

    await expect(
      make().updateAccount("uid-editor", ACC_A, { displayName: "Theirs" })
    ).rejects.toMatchObject({ code: "role_forbidden" });

    expect(db.all("accounts").find((a) => a.id === ACC_A)!.displayName).toBe("My Channel");
  });

  it("refuses a rename whose authorization went stale before the write", async () => {
    // The race the transaction closes. `assertOwner` is a separate read, so a
    // demotion committing between it and the write let a now-non-owner's rename
    // land. Reproduced by handing the pre-check a STALE view while the stored
    // document has already demoted the caller — exactly the state the gap leaves.
    db.seed("accounts", [
      account(ACC_A, { ownerUids: [], members: { [uid]: { role: "editor" } } }),
    ]);
    const repo = new AccountRepository();
    const service = new AccountService(repo, new UserRepository(), new VideoProjectRepository());
    jest
      .spyOn(repo, "findById")
      .mockResolvedValueOnce(account(ACC_A) as never); // still an owner, as it was a moment ago

    await expect(
      service.updateAccount(uid, ACC_A, { displayName: "Theirs" })
    ).rejects.toMatchObject({ code: "role_forbidden" });

    expect(db.all("accounts").find((a) => a.id === ACC_A)!.displayName).toBe("My Channel");
  });

  it("tells a non-member nothing about a channel's state", async () => {
    // Ordering: membership BEFORE state. Checking `deletedAt`/`orphanedAt` first
    // gave a caller with no right to know the channel exists three
    // distinguishable answers — 410 for deleted, a recovery message for orphaned,
    // and a plain 403 otherwise.
    db.seed("accounts", [account(ACC_B, { memberUids: ["someone-else"], deletedAt: "2026-08-01" })]);
    const deleted = await make().getAccount(uid, ACC_B).catch((error) => error);

    db.seed("accounts", [account(ACC_B, { memberUids: ["someone-else"], orphanedAt: "2026-08-01" })]);
    const orphaned = await make().getAccount(uid, ACC_B).catch((error) => error);

    db.seed("accounts", [account(ACC_B, { memberUids: ["someone-else"] })]);
    const forbidden = await make().getAccount(uid, ACC_B).catch((error) => error);

    // All three look identical to a non-member.
    for (const error of [deleted, orphaned, forbidden]) {
      expect(error).toMatchObject({ statusCode: 403, code: "account_forbidden" });
    }
    expect(new Set([deleted.message, orphaned.message, forbidden.message]).size).toBe(1);
  });

  it("activate moves the pointer, and only to a channel the caller can enter", async () => {
    await make().activateAccount(uid, ACC_B);
    expect(db.all("users").find((u) => u.id === uid)!.lastActiveAccountId).toBe(ACC_B);

    await expect(make().activateAccount("uid-stranger", ACC_B)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("refuses to activate a tombstoned channel", async () => {
    db.seed("accounts", [account(ACC_B, { deletedAt: "2026-08-01" })]);

    await expect(make().activateAccount(uid, ACC_B)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("Phase 06b — onboarding a channel makes THAT channel onboarded", () => {
  // The gap this closes. `POST /v1/accounts` creates an empty channel, so
  // `isOnboarded` starts false — correct. But while onboarding wrote the USER
  // record, nothing ever wrote the channel's context, so it stayed false forever
  // and the switcher would route the user back to onboarding every time they
  // picked it. Sourcing the flag from the user record instead is not a fix: then
  // every channel reports the first one's answers, and a channel created seconds
  // ago claims to be set up.
  const userService = () =>
    new (require("../../../src/service/user.service").default)(
      new UserRepository(),
      new AccountRepository()
    );

  it("a newly created channel becomes onboarded once IT is onboarded", async () => {
    const service = make();
    const created = await service.createAccount(uid);

    const before = (await service.listAccounts(uid)).find((r) => r.id === created.id)!;
    expect(before.isOnboarded).toBe(false);

    await userService().createOnboardingData(
      { userId: uid, accountId: created.id },
      { niche: "index funds", targetAudience: "new investors" } as never
    );

    const after = (await service.listAccounts(uid)).find((r) => r.id === created.id)!;
    expect(after.isOnboarded).toBe(true);
  });

  it("and onboarding it does NOT touch the other channel", async () => {
    // The failure in the other direction, and the sharper one: one shared record
    // meant setting up the finance channel overwrote the cooking channel's niche,
    // so generation for A silently started producing B's content.
    const service = make();

    await userService().createOnboardingData(
      { userId: uid, accountId: ACC_B },
      { niche: "index funds", targetAudience: "new investors" } as never
    );

    const contextA = await new AccountRepository().getContext(ACC_A);
    expect(contextA!.niche).toBe("cooking");

    const rows = await service.listAccounts(uid);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.isOnboarded]))).toEqual({
      [ACC_A]: true,
      [ACC_B]: true,
    });
  });

  it("keeps the user record free of channel fields", async () => {
    await userService().createOnboardingData(
      { userId: uid, accountId: ACC_B },
      { niche: "index funds", targetAudience: "new investors" } as never
    );

    const user = db.all("users").find((u) => u.id === uid)!;
    expect(user.niche).toBeUndefined();
    expect(user.targetAudience).toBeUndefined();
  });
});

it("orphaned channels are excluded from discovery and bootstrap repairs their pointer", async () => {
  db.seed("accounts", [account(ACC_A, { orphanedAt: "now" }), account(ACC_B)]);
  const service = make();
  expect((await service.listAccounts(uid)).map(a => a.id)).toEqual([ACC_B]);
  expect((await service.bootstrapAccount(uid)).id).toBe(ACC_B);
  expect(await service.ensureDefaultAccount(uid)).toBe(ACC_B);
  await expect(service.getAccount(uid, ACC_A)).rejects.toMatchObject({ code: "account_forbidden" });
});

it.each(["demoted", "removed"])("refuses deletion if ownership is %s after the service precheck", async change => {
  const repo = new AccountRepository();
  const original = repo.softDeleteUnlessLast;
  repo.softDeleteUnlessLast = async (id, caller) => {
    db.seed("accounts", [account(ACC_A, change === "demoted"
      ? { members: { [uid]: { role: "editor" }, [mate]: { role: "owner" } }, ownerUids: [mate], billingOwnerUid: mate }
      : { members: { [mate]: { role: "owner" } }, memberUids: [mate], ownerUids: [mate], billingOwnerUid: mate })]);
    return original(id, caller);
  };
  const purge = jest.spyOn(repo, "purgeAccountData");
  const service = new AccountService(repo, new UserRepository(), new VideoProjectRepository());
  await expect(service.deleteAccount(uid, ACC_A)).rejects.toMatchObject({ statusCode: 403 });
  expect(purge).not.toHaveBeenCalled();
  expect(db.all("accounts").find(a => a.id === ACC_A)!.deletedAt).toBeNull();
  expect(db.all("videoProjects").find(p => p.id === "p1")).toBeDefined();
});
