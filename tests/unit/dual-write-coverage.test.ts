// Two ratchets for Phase 03 that a behaviour test structurally cannot express,
// because both are assertions about code that must NOT exist.
//
// The stamp itself is NOT asserted here. Every one of the seven write paths now
// checks the written document's `accountId` for its real value, where that
// document is built:
//
//   ideas               tests/integration/ideas.route.behaviour.test.ts
//   scripts             tests/unit/content.service.script-iteration.test.ts
//   hooks               tests/unit/service/hooks.flow.behaviour.test.ts
//   packaging (save)    tests/unit/packaging.service.iteration.test.ts
//   packaging (generate) tests/unit/packaging.repository.test.ts
//   videoProjects       tests/unit/video-project.service.test.ts
//   events              tests/unit/event.service.test.ts
//
// This file previously also brace-matched each of those source files and regexed
// `/\baccountId\b/` inside the slice. That version was deleted: it asserted the
// TEXT of an implementation rather than a value, so `accountId: batchId` passed
// it — which is the exact bug that actually happened during this phase — while
// renaming a local `const packagingData` failed it on correct code.

import fs from "fs";
import path from "path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("phase 03 — accountId is never quietly defaulted to a uid", () => {
  // The scheme this replaced set `accountId = uid`. Its fatal property was that
  // a `userId` passed where an `accountId` belongs STILL isolated correctly
  // between two users, so no behaviour test could see the bug. Any default
  // reintroduces it, and reintroduces it invisibly.
  it.each([
    "src/utlils/content.ts",
    "src/service/hooks.service.ts",
    "src/service/packaging.service.ts",
    "src/service/video-project.service.ts",
    "src/service/event.service.ts",
    "src/service/account.service.ts",
  ])("%s never assigns accountId from userId", (file) => {
    const source = read(file);

    expect(source).not.toMatch(/accountId\s*[:=]\s*userId\b/);
    expect(source).not.toMatch(/accountId\s*[:=]\s*[^,;\n]*\?\?\s*userId\b/);
    expect(source).not.toMatch(/accountId\s*[:=]\s*[^,;\n]*\|\|\s*userId\b/);
  });
});

// The phase doc's "What explicitly does NOT change" list. Each of these is a
// silent tenancy change if it slips in early — nothing breaks in review, and the
// damage only shows once Phase 04 has already scanned past the affected records.
describe("phase 06 — permissions are decided by the account, never the author", () => {
  const serviceDir = path.join(process.cwd(), "src", "service");

  // The inverse of the Phase 03 ratchet this replaces. That one asserted every
  // ownership comparison still tested `createdBy`, because swapping one early
  // reads as forward progress and passes every test — each user had exactly one
  // account, so the check still admitted the right person.
  //
  // Phase 06 flipped them all, and the risk reverses with it: a NEW check written
  // against `createdBy` also passes every test today, and keeps passing right up
  // until two people share a channel. Then the author can act and the co-member
  // cannot, on a document they both own. Sharing is Phase 09; this is the only
  // thing standing between here and there.
  it("no service decides permission by comparing createdBy", () => {
    const offenders: string[] = [];

    for (const file of fs.readdirSync(serviceDir).filter((f) => f.endsWith(".ts"))) {
      const source = stripComments(fs.readFileSync(path.join(serviceDir, file), "utf8"));
      // BOTH operand orders, and across newlines.
      //
      // This was `/\bcreatedBy\s*[!=]==?/` applied line by line, so it saw
      // `doc.createdBy !== uid` and missed `uid !== doc.createdBy` — the same
      // check, written the other way round, which is how roughly half of all
      // developers write it. A comparison split over two lines was invisible
      // either way. The invariant is "createdBy decides nothing", so the scan
      // has to be about the comparison, not about which side the field sits on.
      for (const pattern of [
        /\bcreatedBy\s*[!=]==?/g,
        /[!=]==?\s*[\w.[\]"'?]*\bcreatedBy\b/g,
      ]) {
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index).split("\n").length;
          offenders.push(`${file}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // `createdBy` is not banned — it is still authorship, and still written on
  // every record. It is banned from DECIDING anything.
  //
  // THE OTHER HALF OF THAT SENTENCE — "still written on every record" — lives in
  // `tests/unit/authorship.behaviour.test.ts`, which drives all seven creation
  // paths through their real document builder and real repository and reads the
  // stored document back out of the fake Firestore.
  //
  // It used to be asserted here, as `/createdBy:\s*\w/` over the CONCATENATED
  // service sources. That test survived every write path dropping the author, as
  // long as one matching fragment remained anywhere in `src/service` — and since
  // the sources were joined without `stripComments`, the fragment was allowed to
  // be a comment. It claimed a per-record guarantee and asserted the existence of
  // a substring, which is the failure this file's own docstring warns about two
  // paragraphs up. Replaced rather than repaired: a text scan cannot see whether
  // the value written is the authenticated uid, the account id, or `undefined`.
});

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

/**
 * Every shape "read an account id off the request" actually takes.
 *
 * The first version was two patterns — `/x-account-id/i` and
 * `req.(body|query|params|headers)\W+accountId` — and running them against
 * candidate code showed four ways through, including the two a developer is
 * MOST likely to write:
 *
 *   const a = req.header(ACCOUNT_HEADER);   ← EVADED (and `ACCOUNT_HEADER` is exported)
 *   const { accountId } = req.body;         ← EVADED (commonest Express idiom)
 *   const { accountId } = req.query;        ← EVADED
 *   const { accountId: acc } = req.params;  ← EVADED
 *   req.body.accountId                      ← caught
 *   req.headers["x-account-id"]             ← caught
 *
 * The scan was widened to all of `src` without the patterns being re-tested,
 * which is how a ratchet ends up broader and no stronger.
 */
/**
 * SHRINK-ONLY, and pinned by a test below — adding a third entry is a deliberate
 * edit with a written reason, not a two-line convenience. This lacked the
 * staleness check its sibling `ACCOUNT_EXEMPT` (auth-coverage) has.
 */
const EXEMPT_FILES: Record<string, string> = {
  // The middleware IS the check. It is the one place allowed to read it.
  "src/middleware/account.ts": "resolves and membership-checks the header",
  // Names the header in the CORS allowlist, which is a declaration, not a read.
  // `app.cors.behaviour.test.ts` asserts the explicit list survives — and that
  // test had to be rewritten, because `cors` REFLECTS the requested headers
  // when the option is absent, so its preflight version passed with the config
  // deleted outright.
  "src/app.ts": "declares the header in CORS allowedHeaders",
};

const READS_AN_ACCOUNT_ID: RegExp[] = [
  // The literal header, however it is spelled or cased.
  /x-account-id/i,
  // The exported constant, which is the tidy way to spell the same thing.
  /\bACCOUNT_HEADER\b/,
  // Member access: req.body.accountId, req.query.accountId, …
  /req\.(body|query|params|headers)\W+accountId/,
  // Destructuring, with or without a rename: const { accountId: acc } = req.body
  /\{[^}]*\baccountId\b[^}]*\}\s*=\s*req\.(body|query|params|headers)\b/,
];

describe("phase 05 — the account id enters at exactly one place", () => {
  // The patterns are the whole protection, so they get their own test rather
  // than being trusted because they look thorough.
  it("catches every shape of reading an account id off the request", () => {
    const shouldCatch = [
      'const a = req.header(ACCOUNT_HEADER);',
      'const { accountId } = req.body;',
      'const { accountId } = req.query;',
      'const { accountId: acc } = req.params;',
      'req.body.accountId',
      'req.headers["x-account-id"]',
      'const id = req.get("X-Account-Id");',
    ];

    const missed = shouldCatch.filter(
      (snippet) => !READS_AN_ACCOUNT_ID.some((p) => p.test(snippet))
    );

    expect(missed).toEqual([]);
  });

  it("does not fire on ordinary account-id usage that is not a request read", () => {
    // `owner.accountId` and `req.accountId` (set BY the middleware) are the
    // normal way every service and controller works. Flagging those would make
    // the ratchet unusable and it would be deleted.
    const shouldPass = [
      "const { accountId } = owner;",
      "doc.accountId !== owner.accountId",
      "ownerOf(req)",
      "req.accountId",
    ];

    const falsePositives = shouldPass.filter((snippet) =>
      READS_AN_ACCOUNT_ID.some((p) => p.test(snippet))
    );

    expect(falsePositives).toEqual([]);
  });

  // ALLOWLIST TRIPWIRE — not a security guarantee.
  //
  // Nothing here says anything about the code: it compares a constant declared 60
  // lines up against the same two names written out again. Its only job is to make
  // widening the exemption list a deliberate act with a written reason, so a third
  // file cannot be waved through as a two-line convenience while the scan below
  // keeps reporting zero offenders. The guarantee is the scan.
  //
  // It previously ALSO asserted `reason.length > 10`, which eleven spaces satisfy
  // and which therefore checked that a string exists. Dropped for the check below,
  // which has teeth: an exemption is stale the moment its file stops reading an
  // account id, and a stale exemption is a live hole waiting for the next edit to
  // that file.
  it("allowlist tripwire: exactly two files are exempt, and each still needs it", () => {
    expect(Object.keys(EXEMPT_FILES).sort()).toEqual([
      "src/app.ts",
      "src/middleware/account.ts",
    ]);

    const stale = Object.keys(EXEMPT_FILES).filter(
      (file) => !READS_AN_ACCOUNT_ID.some((p) => p.test(stripComments(read(file))))
    );

    expect(stale).toEqual([]); // ← an exempt file that no longer reads one: SHRINK the list
  });
  it("only accountMiddleware reads an account id from the request", () => {
    // Phase 03's version of this asserted NOTHING read the header. Phase 05 is
    // the phase that introduces it, so the invariant narrows rather than
    // disappears: the header is forgeable, and it is only safe because one
    // middleware checks membership unconditionally before anything trusts it.
    // A controller or route reading it directly would bypass that check — which
    // is the single way a user reads another's channel by editing their browser.
    // ALL of `src`, not three folders.
    //
    // The old roots were routes + middleware + controller, which left out the
    // one file that actually assembles the account: `ownerOf` in
    // `src/utlils/content.ts` is the only sanctioned constructor of a
    // `RecordOwner`, and every controller calls it. Rewriting it to read
    // `req.headers["x-account-id"]` would have handed every service in the app a
    // forgeable account id — AFTER the membership check — and this test, the one
    // written to prevent exactly that, could not see the file. `src/service` and
    // `src/repository` were unscanned for the same reason.
    const offenders: string[] = [];

    {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".ts")) {
            const rel = path.relative(process.cwd(), full);
            if (EXEMPT_FILES[rel]) continue;
            // Comments stripped first. This scans for CODE that reads an
            // account id from the request; a comment explaining why a route is
            // exempt from the account middleware necessarily names the header,
            // and flagging that turns documentation into a build failure.
            const source = stripComments(fs.readFileSync(full, "utf8"));
            if (READS_AN_ACCOUNT_ID.some((pattern) => pattern.test(source))) {
              offenders.push(rel);
            }
          }
        }
      };
      walk(path.join(process.cwd(), "src"));
    }

    expect(offenders).toEqual([]);
  });
});

describe("phase 06 — every tenancy query filters the account", () => {
  // Phase 03's version of this asserted the opposite: NO query filtered
  // accountId, because switching one early would hide every record written
  // before the dual-write. Phase 06 is the switch, so the invariant inverts.
  //
  // A query left on `createdBy` does not fail loudly. It returns the caller's own
  // records, which looks correct — until a channel has two members, and each sees
  // only what they personally created.
  it("no repository query filters on createdBy", () => {
    const dir = path.join(process.cwd(), "src", "repository");
    const offenders: string[] = [];

    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      // Not line by line, and backticks count. `\s*` cannot cross a newline once
      // the source is split into lines, and `content.repository.ts` ALREADY
      // formats a filter as `.where(\n  "isScriptGenerated",\n ...)` — so the
      // defeating shape was not hypothetical, it was the house style two
      // functions above the query this is guarding.
      const source = stripComments(fs.readFileSync(path.join(dir, file), "utf8"));
      for (const match of source.matchAll(/\.where\(\s*["'`]createdBy["'`]/g)) {
        offenders.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("and the queries that replaced them do filter on accountId", () => {
    // Guards the lazy way to satisfy the test above — deleting the filter rather
    // than changing it, which turns a mis-scoped list into an unscoped one.
    const dir = path.join(process.cwd(), "src", "repository");
    const filtered = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /\.where\(\s*["']accountId["']/.test(fs.readFileSync(path.join(dir, f), "utf8")));

    // GROW-ONLY, and every addition needs a reason here. The list is exact so
    // that DELETING a filter fails just as loudly as changing one — the lazy way
    // to satisfy the test above is to drop the `where` rather than fix it, which
    // turns a mis-scoped list into an unscoped one.
    //
    // `account.repository.ts` joined when channel deletion learned to purge the
    // channel's content: `purgeAccountData` queries all six tenancy collections
    // by `accountId`, which is the correct scope for a destructive sweep.
    expect(filtered.sort()).toEqual([
      "account.repository.ts",
      "content.repository.ts",
      "packaging.repository.ts",
      "sharing.repository.ts", // Owners list invitations scoped to the current channel.
      "video-project.repository.ts",
    ]);
  });
});
