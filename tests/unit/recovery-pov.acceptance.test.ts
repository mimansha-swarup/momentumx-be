/** Independent recovery contracts: no real Firebase credentials or remote writes. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { Timestamp } from "firebase-admin/firestore";
import { FakeFirestore } from "../helpers/fake-firestore";

jest.mock("../../src/config/firebase", () => require("../helpers/fake-firestore").mockFirebase());
import AccountRepository from "../../src/repository/account.repository";
import SharingRepository from "../../src/repository/sharing.repository";
const db: FakeFirestore = require("../../src/config/firebase").__db;
const token = (letter: string) => letter.repeat(43);

beforeEach(() => { db.data.clear(); });
afterEach(() => { jest.restoreAllMocks(); });

describe("operator command boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "momentum-recovery-cli-"));
  const entry = join(directory, "command.mjs");
  beforeAll(() => {
    // Run the actual CLI parser in a child process; only repository I/O is replaced.
    const stub = join(directory, "repository.mjs");
    writeFileSync(stub, `export default class Repository {
      async purgeAccountData(...received) { return {received}; }
      async pruneExpired(...received) { return {received}; }
    }`);
    const source = readFileSync("scripts/channel-maintenance-cli.ts", "utf8");
    const emitted = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    writeFileSync(entry, emitted.replaceAll(/\.\.\/src\/repository\/(account|sharing)\.repository\.js/g, pathToFileURL(stub).href));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8", env: { ...process.env, FIREBASE_SERVICE_ACCOUNT_BASE64: "", NODE_OPTIONS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  it("defaults both modes to dry-run and forwards explicit bounded/cursor options", () => {
    expect(JSON.parse(run("purge", "channel").stdout)).toMatchObject({ dryRun: true, received: ["channel", 2000, true] });
    expect(JSON.parse(run("expired-invites").stdout)).toMatchObject({ dryRun: true, received: [200, null, true] });
    expect(JSON.parse(run("expired-invites", "--apply", "--limit=1", `--after=${token("b")}`).stdout))
      .toMatchObject({ dryRun: false, received: [1, token("b"), false] });
  });

  it.each([
    ["purge"], ["purge", "channel", "--limit=2001"], ["purge", "channel", "--limit=0"],
    ["expired-invites", "--limit=451"], ["expired-invites", "--limit=2.5"],
    ["expired-invites", "--after=bad/path"], ["purge", "channel", "--apply=true"],
  ])("rejects invalid options before any repository invocation: %j", (...args) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("FIREBASE_SERVICE_ACCOUNT");
  });
});

describe("recovery of bounded channel data", () => {
  it("bounds every child collection independently and reports exact-cap completion", async () => {
    db.seed("accounts", [{ id: "deleted", deletedAt: Timestamp.now() }]);
    db.seed("accounts/deleted/context", [{ id: "channel", websiteContent: "private" }]);
    const paths = ["ideas", "scripts", "hooks", "packaging", "videoProjects", "invites", "accounts/deleted/usage", "accounts/deleted/membershipChanges"];
    for (const path of paths) db.seed(path, [{ id: "one", accountId: "deleted" }, { id: "two", accountId: "deleted" }]);
    const result = await new AccountRepository().purgeAccountData("deleted", 2, false);
    expect(result).toEqual({ deleted: 17, matched: 17, incomplete: [] });
    for (const path of paths) expect(db.all(path)).toEqual([]);
    expect(db.all("accounts")).toHaveLength(1);
  });

  it("removes private context even if the first content batch fails; retry finishes", async () => {
    db.seed("accounts", [{ id: "deleted", deletedAt: Timestamp.now() }]);
    db.seed("accounts/deleted/context", [{ id: "channel", websiteContent: "private" }]);
    db.seed("ideas", [{ id: "one", accountId: "deleted" }]);
    const original = db.batch.bind(db);
    jest.spyOn(db, "batch").mockImplementationOnce(() => ({ ...original(), commit: async () => { throw Error("offline"); } }));
    const repo = new AccountRepository();
    await expect(repo.purgeAccountData("deleted", 1, false)).rejects.toThrow("offline");
    expect(db.all("accounts/deleted/context")).toEqual([]);
    expect(db.all("ideas")).toHaveLength(1);
    expect(await repo.purgeAccountData("deleted", 1, false)).toEqual({ deleted: 1, matched: 1, incomplete: [] });
  });
});

describe("expired invitation reclamation", () => {
  it("preserves an invitation whose expiry was extended between scan and deletion", async () => {
    db.seed("invites", [{ id: token("a"), expiresAt: Timestamp.fromMillis(Date.now() - 1000) }]);
    const transaction = db.runTransaction.bind(db);
    jest.spyOn(db, "runTransaction").mockImplementationOnce(fn => {
      db.col("invites").get(token("a"))!.expiresAt = Timestamp.fromMillis(Date.now() + 60000);
      return transaction(fn);
    });
    expect(await new SharingRepository().pruneExpired(1, undefined, false)).toEqual({ scanned: 1, expired: 1, deleted: 0, nextCursor: token("a") });
    expect(db.all("invites")).toHaveLength(1);
  });

  it("skips malformed expiry records and can continue after a cursor row was deleted", async () => {
    db.seed("invites", [
      { id: token("a"), expiresAt: "yesterday" },
      { id: token("b"), expiresAt: Timestamp.fromMillis(Date.now() - 1000) },
      { id: token("c"), expiresAt: Timestamp.fromMillis(Date.now() - 1000) },
    ]);
    const repo = new SharingRepository();
    const first = await repo.pruneExpired(2, undefined, false);
    expect(first).toMatchObject({ scanned: 2, deleted: 1, nextCursor: token("b") });
    const second = await repo.pruneExpired(2, first.nextCursor!, false);
    expect(second).toMatchObject({ scanned: 1, deleted: 1, nextCursor: null });
    expect(db.all("invites").map(row => row.id)).toEqual([token("a")]);
  });
});

it("a refresh started before deletion cannot recreate context after successful purge", async () => {
  const { default: UserService } = await import("../../src/service/user.service");
  db.seed("accounts", [{ id: "deleted", deletedAt: null, displayName: "Existing name", memberUids: ["owner"], ownerUids: ["owner"], billingOwnerUid: "owner", members: { owner: { role: "owner" } } }]);
  db.seed("accounts/deleted/context", [{ id: "channel", website: "https://example.com", niche: "private niche" }]);
  let release!: (value: string) => void;
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const extraction = new Promise<string>(resolve => { release = resolve; });
  const accounts = new AccountRepository();
  const service = new UserService({} as never, accounts, {} as never, {
    getWebsiteContent: () => { reached(); return extraction; },
  } as never);
  const refresh = service.refreshContext({ accountId: "deleted", userId: "owner" });
  await started;
  db.col("accounts").get("deleted")!.deletedAt = Timestamp.now();
  expect((await accounts.purgeAccountData("deleted", 1, false)).incomplete).toEqual([]);
  release("private website scrape arriving after deletion");
  await refresh.catch(() => undefined);
  expect(db.all("accounts/deleted/context")).toEqual([]);
});

const writableChannel = (id: string) => ({
  id, displayName: "Established channel", handle: null, deletedAt: null,
  memberUids: ["owner", "editor"], ownerUids: ["owner"], billingOwnerUid: "owner",
  members: { owner: { role: "owner" as const, addedAt: Timestamp.now() }, editor: { role: "editor" as const, addedAt: Timestamp.now() } },
});

it.each([
  ["refresh", "deletedAt"], ["refresh", "orphanedAt"],
  ["update", "deletedAt"], ["update", "orphanedAt"],
  ["refresh", "removed"], ["refresh", "demoted"],
  ["update", "removed"], ["update", "demoted"],
])("%s rejects enrichment finishing after %s without partially changing stored context", async (operation, marker) => {
  const { default: UserService } = await import("../../src/service/user.service");
  db.seed("accounts", [{ ...writableChannel("channel"), displayName: "Untitled channel" }]);
  const original = { id: "channel", website: "https://example.com", niche: "existing niche", websiteContent: "existing scrape" };
  db.seed("accounts/channel/context", [original]);
  let release!: (content: string) => void;
  let started!: () => void;
  const pendingExtraction = new Promise<string>(resolve => { release = resolve; });
  const extractionStarted = new Promise<void>(resolve => { started = resolve; });
  const service = new UserService({} as never, new AccountRepository(), {} as never, {
    getWebsiteContent: () => { started(); return pendingExtraction; },
  } as never);
  const owner = { accountId: "channel", userId: "editor" };
  const pending = operation === "refresh" ? service.refreshContext(owner)
    : service.updateProfile(owner, { website: "https://example.com", niche: "new niche" } as IOnboardingPayload);
  await extractionStarted;
  const channel = db.col("accounts").get("channel")!;
  if (marker === "removed") channel.memberUids = ["owner"];
  else if (marker === "demoted") (channel.members as Record<string, {role: string}>).editor.role = "viewer";
  else channel[marker] = Timestamp.now();
  release("late scrape");
  await expect(pending).rejects.toMatchObject({ statusCode: expect.any(Number) });
  expect(db.all("accounts/channel/context")).toEqual([original]);
  expect(db.col("accounts").get("channel")!.displayName).toBe("Untitled channel");
});

it.each(["owner", "editor"])("live %s context writes retain unrelated fields", async (uid) => {
  const { default: UserService } = await import("../../src/service/user.service");
  db.seed("accounts", [writableChannel("channel")]);
  db.seed("accounts/channel/context", [{ id: "channel", website: "https://example.com", brandName: "Keep me" }]);
  const service = new UserService({} as never, new AccountRepository(), {} as never, {
    getWebsiteContent: async () => "new scrape",
  } as never);
  await service.updateProfile({ accountId: "channel", userId: uid }, { niche: "updated", website: "https://example.com" } as IOnboardingPayload);
  expect(db.all("accounts/channel/context")[0]).toMatchObject({ brandName: "Keep me", niche: "updated", websiteContent: "new scrape" });
});

it("first bootstrap and explicit additional channel retain their initial context", async () => {
  const accounts = new AccountRepository();
  const context = { userName: "", channelId: "", channelDescription: "", userTitle: [], niche: "initial niche", targetAudience: "creators", brandName: "", website: "", websiteContent: "", competitors: [], format: "talking_head" as const, purpose: "", description: "" };
  const first = await accounts.createWithContext(writableChannel("first"), context);
  const repeated = await accounts.createWithContext(writableChannel("duplicate"), { ...context, niche: "must not replace" });
  const second = await accounts.createAdditional(writableChannel("second"), { ...context, niche: "second niche" });
  expect([first, repeated, second]).toEqual(["first", "first", "second"]);
  expect(db.all("accounts").map(row => row.id)).toEqual(["first", "second"]);
  expect(db.all("accounts/first/context")[0]).toMatchObject(context);
  expect(db.all("accounts/second/context")[0]).toMatchObject({ ...context, niche: "second niche" });
});

it("onboarding updates a live channel's identity but never creates a missing parent", async () => {
  const { default: UserService } = await import("../../src/service/user.service");
  db.seed("accounts", [{ ...writableChannel("channel"), displayName: "Untitled channel" }]);
  const service = new UserService({} as never, new AccountRepository(), {} as never, {} as never);
  const profile = { brandName: "Kitchen channel", niche: "bread", targetAudience: "bakers" } as IOnboardingPayload;
  await service.createOnboardingData({ accountId: "channel", userId: "owner" }, profile);
  expect(db.col("accounts").get("channel")!.displayName).toBe("Kitchen channel");
  expect(db.all("accounts/channel/context")[0]).toMatchObject(profile);
  await expect(service.createOnboardingData({ accountId: "missing", userId: "owner" }, profile))
    .rejects.toMatchObject({ statusCode: 404 });
  expect(db.all("accounts/missing/context")).toEqual([]);
  expect(db.col("accounts").has("missing")).toBe(false);
});

it("a delayed identity adoption cannot rename a channel after its context was purged", async () => {
  const { default: UserService } = await import("../../src/service/user.service");
  db.seed("accounts", [{ ...writableChannel("channel"), displayName: "Untitled channel" }]);
  const accounts = new AccountRepository();
  let release!: () => void;
  let started!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const readStarted = new Promise<void>(resolve => { started = resolve; });
  const read = accounts.findById.bind(accounts);
  jest.spyOn(accounts, "findById").mockImplementationOnce(async id => {
    const snapshot = await read(id);
    started();
    await paused;
    return snapshot;
  });
  const service = new UserService({} as never, accounts, {} as never, {} as never);
  const pending = service.createOnboardingData({ accountId: "channel", userId: "owner" }, { brandName: "Late name" } as IOnboardingPayload);
  await readStarted;
  db.col("accounts").get("channel")!.deletedAt = Timestamp.now();
  await accounts.purgeAccountData("channel", 1, false);
  release();
  await expect(pending).rejects.toMatchObject({ statusCode: 410 });
  expect(db.col("accounts").get("channel")!.displayName).toBe("Untitled channel");
  expect(db.all("accounts/channel/context")).toEqual([]);
});
