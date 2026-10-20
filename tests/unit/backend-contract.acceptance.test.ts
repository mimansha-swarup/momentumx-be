/** Public account/sharing contracts exercised over HTTP with real application layers.
 * Only Firebase authentication and storage are local test doubles. These checks
 * assert serial behavior; they do not claim to model Firestore contention. */
import express from "express";
import request from "supertest";
import { Timestamp } from "firebase-admin/firestore";
import { FakeFirestore } from "../helpers/fake-firestore";
import { useSharedServer } from "../integration/shared-server";

const identities: Record<string, { uid: string; email: string; email_verified: boolean }> = {
  owner: { uid: "owner", email: "owner@example.com", email_verified: true },
  viewer: { uid: "viewer", email: "viewer@example.com", email_verified: true },
  editor: { uid: "editor", email: "editor@example.com", email_verified: true },
  guest: { uid: "guest", email: "guest@example.com", email_verified: true },
  named: { uid: "constructor", email: "named@example.com", email_verified: true },
};
jest.mock(require.resolve("firebase-functions/v2/identity", { paths: [__dirname + "/../../functions"] }), () => ({
  IS_NOT_TENANT: "__no_tenant__",
  onUserCreated: (_options: unknown, handler: unknown) => handler,
  onUserDeleted: (_options: unknown, handler: unknown) => handler,
}));
jest.mock(require.resolve("firebase-admin", { paths: [__dirname + "/../../functions"] }), () => ({
  initializeApp: jest.fn(),
  firestore: Object.assign(() => require("../../src/config/firebase").db, {
    FieldValue: { serverTimestamp: () => ({ __fv: "serverTimestamp" }) },
  }),
}));
jest.mock("../../src/config/firebase", () => {
  const local = require("../helpers/fake-firestore").mockFirebase();
  local.firebase.auth = () => ({ verifyIdToken: async (token: string) => {
    if (!identities[token]) throw new Error("invalid test token");
    return identities[token];
  } });
  return local;
});
jest.mock("../../src/container", () => {
  const accountRepository = new (require("../../src/repository/account.repository").default)();
  const videoProjectRepository = new (require("../../src/repository/video-project.repository").default)();
  const accountService = new (require("../../src/service/account.service").default)(accountRepository,
    new (require("../../src/repository/user.repository").default)(), videoProjectRepository);
  const sharing = new (require("../../src/repository/sharing.repository").default)();
  return {
    accountRepository, videoProjectRepository, accountService,
    accountController: new (require("../../src/controller/account.controller").default)(accountService),
    sharingController: new (require("../../src/controller/sharing.controller").default)(sharing),
    inviteController: new (require("../../src/controller/invite.controller").default)(sharing, accountService),
  };
});
import accountRouter from "../../src/routes/v1/account.route";
import sharingRouter from "../../src/routes/v1/sharing.route";
import inviteRouter from "../../src/routes/v1/invite.route";
import { responseFormatter } from "../../src/middleware/response_formatter";
import { errorHandler } from "../../src/middleware/error_handler";
import AccountRepository from "../../src/repository/account.repository";
import SharingRepository from "../../src/repository/sharing.repository";
import { onDeleteUserV2 } from "../../functions/src/index";

const db: FakeFirestore = require("../../src/config/firebase").__db;
const app = express();
app.use(express.json(), responseFormatter);
app.use("/v1/accounts", accountRouter, sharingRouter);
app.use("/v1/invites", inviteRouter);
app.use(errorHandler);
const server = useSharedServer(app);
const token = "s".repeat(43);
const channel = (id: string) => ({
  id, displayName: "Private kitchen " + id, handle: null,
  memberUids: ["owner", "viewer", "editor"], ownerUids: ["owner"], billingOwnerUid: "owner",
  members: { owner: { role: "owner" }, viewer: { role: "viewer" }, editor: { role: "editor" } },
  deletedAt: null,
});

describe("operator cleanup contracts", () => {
  it("refuses destructive purge of a live channel, and dry runs leave all data intact", async () => {
    const repo = new AccountRepository();
    db.seed("ideas", [{ id: "private-idea", accountId: "channel-a" }]);
    await expect(repo.purgeAccountData("channel-a", 2, false)).rejects.toMatchObject({ statusCode: 400 });
    db.seed("accounts", [{ ...channel("channel-a"), deletedAt: Timestamp.now() }]);
    db.seed("accounts/channel-a/context", [{ id: "channel", niche: "private context" }]);
    const documents = () => JSON.stringify([...db.data].filter(([, rows]) => rows.size > 0).map(([name, rows]) => [name, [...rows]]));
    const before = documents();
    const preview = await repo.purgeAccountData("channel-a", 2, true);
    expect(preview.deleted).toBe(0);
    expect(preview.matched).toBeGreaterThan(0);
    expect(documents()).toBe(before);
  });

  it("exact per-collection caps can be resumed without touching another channel or telemetry", async () => {
    const repo = new AccountRepository();
    db.seed("accounts", [{ ...channel("channel-a"), deletedAt: Timestamp.now() }]);
    db.seed("ideas", [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `idea-${index}`, accountId: "channel-a" })),
      { id: "other-channel", accountId: "channel-b" },
    ]);
    db.seed("events", [{ id: "retained", accountId: "channel-a" }]);
    const first = await repo.purgeAccountData("channel-a", 2, false);
    expect(first.incomplete).toContain("ideas");
    expect(db.all("ideas").filter(row => row.accountId === "channel-a")).toHaveLength(3);
    await repo.purgeAccountData("channel-a", 2, false);
    const last = await repo.purgeAccountData("channel-a", 2, false);
    expect(last.incomplete).toEqual([]);
    expect(db.all("ideas").map(row => row.id)).toEqual(["other-channel"]);
    expect(db.all("events")).toHaveLength(1);
    expect(db.col("accounts").get("channel-a")?.deletedAt).toBeDefined();
    expect((await repo.purgeAccountData("channel-a", 2, false)).deleted).toBe(0);
  });

  it("retry resumes after a committed page followed by a storage failure", async () => {
    const repo = new AccountRepository();
    db.seed("accounts", [{ ...channel("channel-a"), deletedAt: Timestamp.now() }]);
    db.seed("ideas", Array.from({ length: 451 }, (_, index) => ({ id: `idea-${index}`, accountId: "channel-a" })));
    const original = db.batch.bind(db);
    let calls = 0;
    const batches = jest.spyOn(db, "batch").mockImplementation(() => {
      const batch = original();
      if (++calls === 2) batch.commit = async () => { throw new Error("storage unavailable"); };
      return batch;
    });
    try {
      await expect(repo.purgeAccountData("channel-a", 1000, false)).rejects.toThrow("storage unavailable");
      expect(db.all("ideas")).toHaveLength(1);
    } finally {
      batches.mockRestore();
    }
    await repo.purgeAccountData("channel-a", 1000, false);
    expect(db.all("ideas")).toEqual([]);
    expect(db.all("invites")).toEqual([]);
  });

  it("expired-invite cleanup is dry by default and scans through full pages of live invitations", async () => {
    const repo = new SharingRepository();
    db.col("invites").clear();
    const ids = ["a", "b", "c", "d"].map(letter => letter.repeat(43));
    db.seed("invites", ids.map((id, index) => ({ ...invitation(), id,
      expiresAt: Timestamp.fromMillis(Date.now() + (index < 2 ? 60000 : -60000)),
    })));
    const preview = await repo.pruneExpired(4);
    expect(preview).toMatchObject({ scanned: 4, expired: 2, deleted: 0 });
    expect(db.all("invites")).toHaveLength(4);
    const livePage = await repo.pruneExpired(2, undefined, false);
    expect(livePage).toMatchObject({ scanned: 2, expired: 0, deleted: 0, nextCursor: ids[1] });
    const expiredPage = await repo.pruneExpired(2, livePage.nextCursor ?? undefined, false);
    expect(expiredPage.deleted).toBe(2);
    expect(db.all("invites").map(row => row.id)).toEqual(ids.slice(0, 2));
    const complete = await repo.pruneExpired(2, expiredPage.nextCursor ?? undefined, false);
    expect(complete).toMatchObject({ scanned: 0, deleted: 0, nextCursor: null });
  });
});
const invitation = () => ({ id: token, accountId: "channel-a", email: "guest@example.com", role: "editor", status: "pending",
  accountName: "Private kitchen channel-a", invitedByName: "Private chef", invitedBy: "owner",
  createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 86400000) });
const headers = (who: string, id = "channel-a") => ({ Authorization: `Bearer ${who}`, "X-Account-Id": id });

beforeEach(() => {
  db.data.clear();
  db.seed("accounts", [channel("channel-a"), channel("channel-b")]);
  db.seed("users", Object.values(identities).map((identity) => ({ id: identity.uid, email: identity.email, lastActiveAccountId: "channel-a" })));
  db.seed("invites", [invitation()]);
});

describe("account and invitation public contracts", () => {
  it("listing never creates a first channel; bootstrap is authenticated and idempotent", async () => {
    const before = db.all("accounts").length;
    const listed = await request(server()).get("/v1/accounts").set("Authorization", "Bearer guest").expect(200);
    expect(listed.body.data.accounts).toEqual([]);
    expect(db.all("accounts")).toHaveLength(before);
    await request(server()).post("/v1/accounts/bootstrap").expect(401);
    const first = await request(server()).post("/v1/accounts/bootstrap").set("Authorization", "Bearer guest").expect(200);
    const second = await request(server()).post("/v1/accounts/bootstrap").set("Authorization", "Bearer guest").expect(200);
    expect(first.body.data.account.id).toBe(second.body.data.account.id);
    expect(db.all("accounts")).toHaveLength(before + 1);
  });

  it("viewer bootstrap does not disclose the channel's membership or payer roster", async () => {
    const response = await request(server()).post("/v1/accounts/bootstrap").set("Authorization", "Bearer viewer").expect(200);
    expect(response.body.data.account.role).toBe("viewer");
    for (const key of ["members", "memberUids", "ownerUids", "billingOwnerUid"]) expect(response.body.data.account).not.toHaveProperty(key);
  });

  it("a path/header mismatch offers a switch only to a channel the caller belongs to", async () => {
    const mismatch = await request(server()).patch("/v1/accounts/channel-b").set(headers("viewer")).send({ displayName: "Edited" }).expect(403);
    expect(mismatch.body.code).toBe("wrong_account");
    expect(mismatch.body.detail.accountId).toBe("channel-b");
    db.seed("accounts", [{ ...channel("secret"), memberUids: ["owner"], members: { owner: { role: "owner" } } }]);
    const denied = await request(server()).patch("/v1/accounts/secret").set(headers("viewer")).send({ displayName: "Edited" }).expect(403);
    expect(denied.body.code).toBe("account_forbidden");
    expect(JSON.stringify(denied.body)).not.toContain("Private kitchen secret");
  });

  it("viewers and editors cannot manage members or issue invitations", async () => {
    for (const who of ["viewer", "editor"]) {
      await request(server()).get("/v1/accounts/channel-a/members").set(headers(who)).expect(403);
      await request(server()).post("/v1/accounts/channel-a/invites").set(headers(who)).send({ email: "next@example.com", role: "editor" }).expect(403);
    }
    expect(db.all("invites")).toHaveLength(1);
  });

  it("acceptance checks verified identity, then consumes the link once", async () => {
    const wrong = await request(server()).post(`/v1/invites/${token}/accept`).set("Authorization", "Bearer viewer").send({ email: "guest@example.com", email_verified: true }).expect(403);
    expect(wrong.body.code).toBe("invite_email_mismatch");
    const joined = await request(server()).post(`/v1/invites/${token}/accept`).set("Authorization", "Bearer guest").expect(200);
    expect(joined.body.data.account.id).toBe("channel-a");
    const replay = await request(server()).post(`/v1/invites/${token}/accept`).set("Authorization", "Bearer guest").expect(403);
    expect(replay.body.code).toBe("invite_used");
  });

  it("expiry is enforced even when the document has not been reclaimed", async () => {
    db.seed("invites", [{ ...invitation(), expiresAt: Timestamp.fromMillis(0) }]);
    const result = await request(server()).post(`/v1/invites/${token}/accept`).set("Authorization", "Bearer guest").expect(403);
    expect(result.body.code).toBe("invite_expired");
    expect(db.all("invites")).toHaveLength(1);
  });

  it.each(["deleted", "orphaned", "missing"])("public preview cannot disclose names for an unavailable (%s) channel", async (state) => {
    if (state === "missing") db.col("accounts").delete("channel-a");
    else db.seed("accounts", [{ ...channel("channel-a"), [state === "deleted" ? "deletedAt" : "orphanedAt"]: Timestamp.now() }]);
    const result = await request(server()).get(`/v1/invites/${token}`);
    expect([403, 404, 410]).toContain(result.status);
    expect(JSON.stringify(result.body)).not.toMatch(/Private kitchen|Private chef|guest@example/);
  });

  it("deleting a channel removes its invitations without touching another channel", async () => {
    db.seed("invites", [{ ...invitation(), id: "t".repeat(43), accountId: "channel-b" }]);
    await request(server()).delete("/v1/accounts/channel-a").set(headers("owner")).expect(200);
    await request(server()).get(`/v1/invites/${token}`).expect(404);
    expect(db.all("invites").map((row) => row.accountId)).toEqual(["channel-b"]);
    await request(server()).delete("/v1/accounts/channel-b").set(headers("owner", "channel-b")).expect(400);
  });

  it("an incomplete capped purge does not leave a public identity disclosure", async () => {
    db.seed("invites", Array.from({ length: 2251 }, (_, index) => ({
      ...invitation(), id: "p".repeat(39) + String(index).padStart(4, "0"),
    })));
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await request(server()).delete("/v1/accounts/channel-a").set(headers("owner")).expect(200);
      const leftovers = db.all("invites");
      expect(leftovers.length).toBeGreaterThan(0);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("account_purge_incomplete"));
      const response = await request(server()).get(`/v1/invites/${leftovers[0].id}`).expect(404);
      expect(JSON.stringify(response.body)).not.toMatch(/Private kitchen|Private chef/);
    } finally {
      warning.mockRestore();
    }
  });

  it.each([
    ["demote", "former-address@example.com"],
    ["remove", "former-address@example.com"],
    ["demote", undefined],
    ["remove", undefined],
  ])("an old invite cannot undo %s with stale or missing profile email (%s)", async (operation, email) => {
    db.col("users").set("editor", { id: "editor", ...(email ? { email } : {}), lastActiveAccountId: "channel-a" });
    const created = await request(server()).post("/v1/accounts/channel-a/invites").set(headers("owner")).send({ email: "editor@example.com", role: "editor" }).expect(201);
    if (operation === "demote") await request(server()).patch("/v1/accounts/channel-a/members/editor").set(headers("owner")).send({ role: "viewer" }).expect(200);
    else await request(server()).delete("/v1/accounts/channel-a/members/editor").set(headers("owner")).expect(200);
    const restore = await request(server()).post(`/v1/invites/${created.body.data.invite.token}/accept`).set("Authorization", "Bearer editor");
    expect(restore.status).toBe(403);
    const roster = await request(server()).get("/v1/accounts/channel-a/members").set(headers("owner")).expect(200);
    const target = roster.body.data.members.find((member: { uid: string }) => member.uid === "editor");
    if (operation === "demote") expect(target.role).toBe("viewer");
    else expect(target).toBeUndefined();
  });

  it.each(["demote", "remove"])("an intentional new invitation after %s still promotes or rejoins", async (operation) => {
    db.col("users").set("editor", { id: "editor", email: "former-address@example.com" });
    const base = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(base);
    try {
      if (operation === "demote") await request(server()).patch("/v1/accounts/channel-a/members/editor").set(headers("owner")).send({ role: "viewer" }).expect(200);
      else await request(server()).delete("/v1/accounts/channel-a/members/editor").set(headers("owner")).expect(200);
      clock.mockReturnValue(base + 1);
      const created = await request(server()).post("/v1/accounts/channel-a/invites").set(headers("owner")).send({ email: "editor@example.com", role: "editor" }).expect(201);
      const joined = await request(server()).post(`/v1/invites/${created.body.data.invite.token}/accept`).set("Authorization", "Bearer editor").expect(200);
      expect(joined.body.data.account.role).toBe("editor");
    } finally {
      clock.mockRestore();
    }
  });

  it("membership history for another member does not refuse a valid prototype-named UID", async () => {
    await request(server()).patch("/v1/accounts/channel-a/members/editor").set(headers("owner")).send({ role: "viewer" }).expect(200);
    const created = await request(server()).post("/v1/accounts/channel-a/invites").set(headers("owner")).send({ email: "named@example.com", role: "viewer" }).expect(201);
    const joined = await request(server()).post(`/v1/invites/${created.body.data.invite.token}/accept`).set("Authorization", "Bearer named").expect(200);
    expect(joined.body.data.account.role).toBe("viewer");
  });

  it.each(["missing", "same-instant", "one-nanosecond-later"])("orders replacement invitations safely at the timestamp boundary (%s)", async (caseName) => {
    const base = 1_700_000_000_000;
    const clock = jest.spyOn(Date, "now").mockReturnValue(base);
    db.col("users").set("editor", { id: "editor", email: "former-address@example.com" });
    try {
      await request(server()).patch("/v1/accounts/channel-a/members/editor").set(headers("owner")).send({ role: "viewer" }).expect(200);
      const fixture: Record<string, unknown> = { ...invitation(), email: "editor@example.com" };
      if (caseName === "missing") delete fixture.createdAt;
      else fixture.createdAt = new Timestamp(base / 1000, caseName === "one-nanosecond-later" ? 1 : 0);
      db.col("invites").set(token, fixture);
      const expected = caseName === "one-nanosecond-later" ? 200 : 403;
      await request(server()).post(`/v1/invites/${token}/accept`).set("Authorization", "Bearer editor").expect(expected);
    } finally {
      clock.mockRestore();
    }
  });

  it("a busy channel can still remove a member after more than 1000 prior distinct removals", async () => {
    const historical = Array.from({ length: 1001 }, (_, index) => `past-member-${index}`);
    const original = channel("channel-a");
    db.seed("accounts", [{ ...original,
      memberUids: [...original.memberUids, ...historical],
      members: { ...original.members, ...Object.fromEntries(historical.map(uid => [uid, { role: "viewer" }])) },
    }]);
    const sharing = new SharingRepository();
    for (const uid of historical) await sharing.change("channel-a", "owner", uid, null);
    await request(server()).delete("/v1/accounts/channel-a/members/editor").set(headers("owner")).expect(200);
    const roster = await request(server()).get("/v1/accounts/channel-a/members").set(headers("owner")).expect(200);
    expect(roster.body.data.members.map((member: { uid: string }) => member.uid).sort()).toEqual(["owner", "viewer"]);
  }, 20_000);

  it("channel deletion also purges private membership history without deleting another channel's history", async () => {
    await request(server()).delete("/v1/accounts/channel-a/members/editor").set(headers("owner")).expect(200);
    await request(server()).delete("/v1/accounts/channel-b/members/editor").set(headers("owner", "channel-b")).expect(200);
    const descendants = (id: string) => [...db.data]
      .filter(([path]) => path.startsWith(`accounts/${id}/`))
      .reduce((count, [, rows]) => count + rows.size, 0);
    expect(descendants("channel-a")).toBeGreaterThan(0);
    const otherCount = descendants("channel-b");
    await request(server()).delete("/v1/accounts/channel-a").set(headers("owner")).expect(200);
    expect(descendants("channel-a")).toBe(0);
    expect(descendants("channel-b")).toBe(otherCount);
  });

  it("a failed membership transaction neither changes a role nor revokes an otherwise valid invitation", async () => {
    db.col("users").set("editor", { id: "editor", email: "former-address@example.com" });
    const created = await request(server()).post("/v1/accounts/channel-a/invites").set(headers("owner")).send({ email: "editor@example.com", role: "editor" }).expect(201);
    const transaction = db.runTransaction.bind(db);
    const interrupted = jest.spyOn(db, "runTransaction").mockImplementation(fn => transaction(async tx => {
      await fn(tx);
      throw new Error("commit unavailable");
    }));
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await request(server()).patch("/v1/accounts/channel-a/members/editor").set(headers("owner")).send({ role: "viewer" }).expect(500);
    } finally {
      interrupted.mockRestore();
      errors.mockRestore();
    }
    const roster = await request(server()).get("/v1/accounts/channel-a/members").set(headers("owner")).expect(200);
    expect(roster.body.data.members.find((member: { uid: string }) => member.uid === "editor").role).toBe("editor");
    await request(server()).post(`/v1/invites/${created.body.data.invite.token}/accept`).set("Authorization", "Bearer editor").expect(200);
  });

  it("an auth-deletion trigger cannot be undone with an outstanding invite and an unexpired identity token", async () => {
    const created = await request(server()).post("/v1/accounts/channel-a/invites").set(headers("owner")).send({ email: "editor@example.com", role: "editor" }).expect(201);
    await (onDeleteUserV2 as unknown as (event: { data: { uid: string } }) => Promise<void>)({ data: { uid: "editor" } });
    // verifyIdToken defaults to checkRevoked=false in the installed Admin SDK.
    // Keep presenting the same decoded, unexpired claims after trigger removal.
    const response = await request(server()).post(`/v1/invites/${created.body.data.invite.token}/accept`).set("Authorization", "Bearer editor");
    expect(response.status).toBe(403);
    const roster = await request(server()).get("/v1/accounts/channel-a/members").set(headers("owner")).expect(200);
    expect(roster.body.data.members.some((member: { uid: string }) => member.uid === "editor")).toBe(false);
  });
});
