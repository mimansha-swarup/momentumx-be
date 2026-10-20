import { Timestamp } from "firebase-admin/firestore";
import { FakeFirestore, isServerTimestamp } from "../../helpers/fake-firestore";

// The shared fake enforces read-after-write ordering and all-or-nothing commits
// for real (see its own docstring) — this suite used to define its own second
// transaction fake that did neither, so "this is transactional" here proved
// nothing: a repository that wrote before it finished reading would pass this
// suite and fail in production.
const fake = new FakeFirestore();

const split = (key: string): [string, string] => {
  const at = key.lastIndexOf("/");
  return [key.slice(0, at), key.slice(at + 1)];
};
/** `store.get("accounts/channel")` — the shape every test body already reads. */
const store = { get: (key: string): any => { const [col, id] = split(key); return fake.col(col).get(id); } };
const put = (key: string, value: any) => { const [col, id] = split(key); fake.col(col).set(id, { ...value }); };

jest.mock("../../../src/config/firebase", () => ({
  db: { collection: (name: string) => fake.collection(name), runTransaction: (fn: any) => fake.runTransaction(fn) },
  firebase: { firestore: { FieldValue: { serverTimestamp: () => ({ __fv: "serverTimestamp" }) } } },
}));
import SharingRepository from "../../../src/repository/sharing.repository";
const token = "a".repeat(43);
const now = Timestamp.now();
const account = () => ({ id: "channel", displayName: "Kitchen", deletedAt: null, billingOwnerUid: "owner",
  members: { owner: { role: "owner", addedAt: now }, second: { role: "owner", addedAt: now }, editor: { role: "editor", addedAt: now } },
  memberUids: ["owner", "second", "editor"], ownerUids: ["owner", "second"] });
const invite = () => ({ accountId: "channel", email: "guest@example.com", role: "viewer", status: "pending", expiresAt: Timestamp.fromMillis(Date.now()+60000), accountName: "Kitchen", invitedByName: "Chef" });
const repo = new SharingRepository();
beforeEach(() => { fake.data.clear(); put("accounts/channel", account()); put(`invites/${token}`, invite()); });

it("accepts only once; a replayed token is rejected, and every membership index stays consistent", async () => {
  // Was a `Promise.allSettled` race. Confirmed by direct probe that the shared
  // fake's per-nested-object aliasing fix does NOT make that race safe: with no
  // version-conflict detection between two concurrent `runTransaction` calls,
  // both still read "pending" before either applies its write, so both accept —
  // the fake's serial design (no cross-transaction contention modelling, by its
  // own docstring) is the binding constraint, not the aliasing that got fixed.
  // Exercised sequentially instead, which pins the same business rule
  // deterministically: a second accept of an already-accepted invite is refused.
  await repo.accept(token, "guest", "GUEST@example.com", true);
  await expect(repo.accept(token, "guest", "guest@example.com", true)).rejects.toMatchObject({ code: "invite_used" });
  expect(store.get("accounts/channel").memberUids).toEqual(["owner", "second", "editor", "guest"]);
  expect(store.get("accounts/channel").members.guest.role).toBe("viewer");
  expect(store.get(`invites/${token}`).status).toBe("accepted");
  expect(store.get("users/guest").lastActiveAccountId).toBe("channel");
});
it.each([
  ["wrong@example.com", true, "invite_email_mismatch"],
  ["guest+alias@example.com", true, "invite_email_mismatch"],
  ["guest@example.com", false, "invite_email_unverified"],
])("refuses invalid identity %s verified=%s without writes", async (email, verified, code) => {
  await expect(repo.accept(token, "guest", email as string, verified as boolean)).rejects.toMatchObject({ code });
  expect(store.get(`invites/${token}`).status).toBe("pending");
  expect(store.get("accounts/channel").members.guest).toBeUndefined();
});
it.each([["expired", "invite_expired"], ["accepted", "invite_used"], ["revoked", "invite_revoked"]])("refuses %s invites", async (status, code) => {
  put(`invites/${token}`, { ...invite(), ...(status === "expired" ? { expiresAt: Timestamp.fromMillis(Date.now()-1) } : { status }) });
  await expect(repo.accept(token, "guest", "guest@example.com", true)).rejects.toMatchObject({ code });
});
it("a prior invite never demotes an existing owner", async () => {
  await repo.accept(token, "owner", "guest@example.com", true);
  expect(store.get("accounts/channel").members.owner.role).toBe("owner");
});
it("owner transfer and concurrent owner removal cannot orphan or detach billing", async () => {
  const results = await Promise.allSettled([repo.change("channel", "owner", "second", "owner", true), repo.change("channel", "second", "owner", null)]);
  expect(results.some(r => r.status === "fulfilled")).toBe(true);
  const saved = store.get("accounts/channel");
  expect(saved.ownerUids.length).toBeGreaterThan(0);
  expect(saved.ownerUids).toContain(saved.billingOwnerUid);
  expect(saved.memberUids.sort()).toEqual(Object.keys(saved.members).sort());
});
it("self-demotion succeeds down to a last owner, and billing follows it", async () => {
  // This used to assert a RACE where the survivor was specifically the BILLING
  // owner, because they were effectively immune: stepping down moved billing
  // off an owner, which the old code refused outright — so the billing owner
  // could never leave, and the error told you to "reassign billing" through an
  // endpoint that did not exist. Billing now follows ownership, so either owner
  // may step down first; what must hold is order-independent. Confirmed by
  // direct probe (same as the accept race above) that concurrent `change()`
  // calls both still fulfill on this fake — no version-conflict detection
  // between transactions, an accepted ceiling of its serial design, not the
  // nested-object aliasing that got fixed. Exercised sequentially instead.
  await repo.change("channel", "owner", "owner", "editor");
  await expect(repo.change("channel", "second", "second", "editor")).rejects.toMatchObject({ statusCode: 400 });

  const saved = store.get("accounts/channel");
  expect(saved.ownerUids).toHaveLength(1);
  // The payer is always an owner — the invariant the old refusal was protecting.
  expect(saved.billingOwnerUid).toBe(saved.ownerUids[0]);
  // And the last owner still cannot remove themselves.
  await expect(repo.change("channel", saved.ownerUids[0], saved.ownerUids[0], null)).rejects.toMatchObject({ statusCode: 400 });
});
it("rechecks actor authority inside transaction, rejects editors and deleted/orphan channels", async () => {
  await expect(repo.change("channel", "editor", "second", null)).rejects.toMatchObject({ code: "role_forbidden" });
  put("accounts/channel", { ...account(), orphanedAt: now });
  await expect(repo.accept(token, "guest", "guest@example.com", true)).rejects.toMatchObject({ code: "invite_revoked" });
  put("accounts/channel", { ...account(), deletedAt: now });
  await expect(repo.accept(token, "guest", "guest@example.com", true)).rejects.toMatchObject({ code: "invite_revoked" });
});
it("preview masks email and never exposes invite fields, token paths are validated", async () => {
  expect(await repo.preview(token)).toEqual({ accountName: "Kitchen", invitedByName: "Chef", role: "viewer", emailMasked: "g••••@example.com", status: "pending", expiresAt: expect.any(String) });
  await expect(repo.preview("../users/owner")).rejects.toMatchObject({ statusCode: 404 });
});
it("invite creation is owner-only and tokens have 256 bits of entropy", async () => {
  await expect(repo.create("channel", "editor", "guest@example.com", "viewer")).rejects.toMatchObject({ code: "role_forbidden" });
  const created = await repo.create("channel", "owner", "GUEST@example.com", "editor");
  expect(created.invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(created.invite.email).toBe("guest@example.com");
  expect(Date.parse(created.invite.expiresAt)-Date.now()).toBeGreaterThan(6*86400000);
});
it("revocation checks channel ownership and the invite's exact account", async () => {
  await expect(repo.revoke("channel", "editor", token)).rejects.toMatchObject({ code: "role_forbidden" });
  put(`invites/${token}`, { ...invite(), accountId: "other" });
  await expect(repo.revoke("channel", "owner", token)).rejects.toMatchObject({ statusCode: 404 });
});
it("refuses payer transfer while this channel has a live generation", async () => {
  put("billing/owner", { generationLocks: { channel_project_hooks: { startedAt: Date.now() } } });
  await expect(repo.change("channel", "owner", "second", "owner", true)).rejects.toMatchObject({ statusCode: 409 });
  expect(store.get("accounts/channel").billingOwnerUid).toBe("owner");
});
it("allows payer transfer after this channel's generation lock expires", async () => {
  put("billing/owner", { generationLocks: { channel_project_hooks: { startedAt: Date.now() - 181_000 } } });
  await repo.change("channel", "owner", "second", "owner", true);
  expect(store.get("accounts/channel").billingOwnerUid).toBe("second");
});

/**
 * `writeMembers` reassigns `billingOwnerUid` automatically the moment the billing owner
 * stops being an owner. The live-generation guard used to sit inside the `transfer`
 * branch only, so these two routes swapped the payer mid-generation without any check —
 * the in-flight reservation is keyed to the OLD payer's billing document, so settling it
 * afterwards bills, or fails to bill, the wrong person.
 */
it.each([
  ["removing", null],
  ["demoting", "editor"],
] as const)("refuses %s the billing owner while this channel has a live generation", async (_label, role) => {
  put("billing/owner", { generationLocks: { channel_project_hooks: { startedAt: Date.now() } } });

  await expect(repo.change("channel", "second", "owner", role)).rejects.toMatchObject({
    statusCode: 409,
  });
  // And the payer is untouched — a refused write must not half-apply.
  expect(store.get("accounts/channel").billingOwnerUid).toBe("owner");
  expect(store.get("accounts/channel").members.owner.role).toBe("owner");
});

it("allows removing the billing owner once the lock has expired, reassigning the payer", async () => {
  // The inverse: the guard must not weld the channel to an absent payer, which is the
  // deadlock that made automatic reassignment necessary in the first place.
  put("billing/owner", { generationLocks: { channel_project_hooks: { startedAt: Date.now() - 181_000 } } });

  await repo.change("channel", "second", "owner", null);

  expect(store.get("accounts/channel").members.owner).toBeUndefined();
  expect(store.get("accounts/channel").billingOwnerUid).toBe("second");
});

const STALE = "b".repeat(43);
const withGuest = (role = "viewer") => ({
  ...account(),
  members: { ...account().members, guest: { role, addedAt: now } },
  memberUids: ["owner", "second", "editor", "guest"],
});

it("revokes a removed member's outstanding invitations, in the same transaction", async () => {
  // The vulnerability: removal was undoable BY THE REMOVED MEMBER, and could
  // RAISE their role on the way back. Invite guest as editor (ignored), invite as
  // viewer (accepted), remove guest — then guest replays the editor token.
  // `accept` only preserves the role of an EXISTING member, and a removed member
  // is not one, so they returned as an editor to a channel they were removed from.
  put("users/guest", { email: "guest@example.com" });
  put("accounts/channel", withGuest());
  put(`invites/${STALE}`, { ...invite(), role: "editor" });

  await repo.change("channel", "owner", "guest", null);

  expect(store.get(`invites/${STALE}`).status).toBe("revoked");
  await expect(repo.accept(STALE, "guest", "guest@example.com", true)).rejects.toMatchObject({ code: "invite_revoked" });
  expect(store.get("accounts/channel").members.guest).toBeUndefined();
});

it("revokes outstanding invitations when a member leaves of their own accord", async () => {
  put("users/guest", { email: "guest@example.com" });
  put("accounts/channel", withGuest());
  put(`invites/${STALE}`, { ...invite(), role: "editor" });

  await repo.change("channel", "guest", "guest", null);

  expect(store.get(`invites/${STALE}`).status).toBe("revoked");
});

it("supersedes an earlier pending invite to the same address", async () => {
  // Two live invitations for one person meant the WEAKER could be accepted and
  // the stronger kept as a spare, and an unbounded pile of them is a denial of
  // service against the invitee's inbox.
  put(`invites/${STALE}`, { ...invite(), role: "editor" });

  const { invite: created } = await repo.create("channel", "owner", "guest@example.com", "viewer");

  expect(store.get(`invites/${STALE}`).status).toBe("revoked");
  expect(created.role).toBe("viewer");
});

it("raises an existing member's role instead of burning the invite for nothing", async () => {
  // The invite was marked accepted and the route returned 200 "you're in", while
  // the member's role was left untouched — so an owner promoting a viewer to
  // editor got a success response and no promotion, and the token was spent.
  put("accounts/channel", withGuest("viewer"));
  put(`invites/${token}`, { ...invite(), role: "editor" });

  await repo.accept(token, "guest", "guest@example.com", true);

  expect(store.get("accounts/channel").members.guest.role).toBe("editor");
  expect(store.get(`invites/${token}`).status).toBe("accepted");
});

it("bounds the invitation inbox, so it cannot be flooded into unusability", async () => {
  for (let i = 0; i < 150; i++) {
    put(`invites/${String(i).padStart(43, "x")}`, { ...invite(), email: "flood@example.com" });
  }

  const pending = await repo.pending("flood@example.com", true);

  expect(pending.length).toBeLessThanOrEqual(100);
});

it("returns a live invitation past 100 expired ones, for both the personal inbox and the channel's list", async () => {
  // The bug: both queries capped at 100 and filtered expiry AFTER the cap, so
  // 100 expired rows followed by one live one came back empty — the limit
  // consumed the page before the in-memory filter ever saw the live row.
  const expired = Timestamp.fromMillis(Date.now() - 1000);
  for (let i = 0; i < 100; i++) {
    put(`invites/${String(i).padStart(43, "y")}`, { ...invite(), email: "flood@example.com", expiresAt: expired });
  }
  const live = "z".repeat(43);
  put(`invites/${live}`, { ...invite(), email: "flood@example.com", expiresAt: Timestamp.fromMillis(Date.now() + 60000) });

  const pending = await repo.pending("flood@example.com", true);
  expect(pending.map(i => i.token)).toEqual([live]);

  const listed = await repo.list("channel", "owner");
  expect(listed.map(i => i.token)).toContain(live);
  expect(listed.every(i => i.status === "pending")).toBe(true);
});

it("revokes a demoted member's outstanding invitation, so replaying it cannot restore the higher role", async () => {
  // The sibling of the removal defect below: `accept` takes the HIGHER of the
  // invited role and the member's CURRENT one, so a token minted before a
  // demotion is a way back to the role it was demoted from. Invite guest as
  // editor (left outstanding as a stale token), guest is already an editor,
  // owner demotes guest to viewer — guest replays the editor token and
  // RANK.editor(1) > RANK.viewer(0) used to put them right back.
  put("users/guest", { email: "guest@example.com" });
  put("accounts/channel", withGuest("editor"));
  put(`invites/${STALE}`, { ...invite(), role: "editor" });

  await repo.change("channel", "owner", "guest", "viewer");

  expect(store.get(`invites/${STALE}`).status).toBe("revoked");
  await expect(repo.accept(STALE, "guest", "guest@example.com", true)).rejects.toMatchObject({ code: "invite_revoked" });
  expect(store.get("accounts/channel").members.guest.role).toBe("viewer");
});

it("stores membership and invite times as server timestamps, not this host's clock", async () => {
  // `expiresAt` is compared against another instance's `Date.now()`, and an
  // account's `updatedAt` is what any audit would order by — a skewed instance
  // could mint already-expired invites or make `updatedAt` go backwards. The
  // shared fake models a `Timestamp` by duck type, not by class, so the server
  // origin is asserted with its own `isServerTimestamp` rather than `instanceof`.
  const { invite: created } = await repo.create("channel", "owner", "fresh@example.com", "viewer");

  expect(isServerTimestamp(store.get(`invites/${created.token}`).createdAt)).toBe(true);
  await repo.change("channel", "owner", "editor", "viewer");
  expect(isServerTimestamp(store.get("accounts/channel").updatedAt)).toBe(true);
});

it("moves billing to a remaining owner when the payer is removed", async () => {
  // The dead end this replaces: `billingOwnerUid` is only ever written at
  // creation and by a transfer performed BY the billing owner, so once that
  // person left, no co-owner could remove or demote them — remove → 400,
  // demote → 400, and a transfer demoted the caller while billing stayed put.
  // The error even told operators to "reassign billing", which no endpoint did.
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  expect(store.get("accounts/channel").billingOwnerUid).toBe("owner");

  await repo.change("channel", "second", "owner", null);

  const saved = store.get("accounts/channel");
  expect(saved.ownerUids).toEqual(["second"]);
  expect(saved.billingOwnerUid).toBe("second");
  // Who pays is never a silent change.
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("billing_owner_reassigned"));
});

it("moves billing when the payer is merely demoted, not removed", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});

  await repo.change("channel", "second", "owner", "editor");

  expect(store.get("accounts/channel").billingOwnerUid).toBe("second");
  expect(store.get("accounts/channel").members.owner.role).toBe("editor");
});
