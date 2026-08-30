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
  it("still writes createdBy, so authorship is not lost", () => {
    const sources = fs
      .readdirSync(serviceDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => fs.readFileSync(path.join(serviceDir, f), "utf8"))
      .join("\n");

    expect(/createdBy:\s*\w/.test(sources)).toBe(true);
  });
});

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

describe("phase 05 — the account id enters at exactly one place", () => {
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
    const EXEMPT: Record<string, string> = {
      // The middleware IS the check. It is the one place allowed to read it.
      "src/middleware/account.ts": "resolves and membership-checks the header",
      // Names the header in the CORS allowlist, which is a declaration, not a
      // read — and dropping it there silently pins every user to one channel.
      // `tests/unit/app.cors.behaviour.test.ts` asserts it stays.
      "src/app.ts": "declares the header in CORS allowedHeaders",
    };
    const offenders: string[] = [];

    {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".ts")) {
            const rel = path.relative(process.cwd(), full);
            if (EXEMPT[rel]) continue;
            // Comments stripped first. This scans for CODE that reads an
            // account id from the request; a comment explaining why a route is
            // exempt from the account middleware necessarily names the header,
            // and flagging that turns documentation into a build failure.
            const source = stripComments(fs.readFileSync(full, "utf8"));
            if (/x-account-id/i.test(source) || /req\.(body|query|params|headers)\W+accountId/.test(source)) {
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
      "video-project.repository.ts",
    ]);
  });
});
