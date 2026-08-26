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
describe("phase 03 — no permission check moves to accountId", () => {
  const serviceDir = path.join(process.cwd(), "src", "service");

  it("every ownership comparison still tests createdBy", () => {
    // Ownership is `resource.createdBy !== userId` in all four services. Swapping
    // one to `accountId` reads as forward progress and passes every existing
    // test, because in this phase each user has exactly one account — so the
    // check still ADMITS the right person. It starts rejecting only for records
    // written before the dual-write began, which have no accountId at all.
    const offenders: string[] = [];

    for (const file of fs.readdirSync(serviceDir).filter((f) => f.endsWith(".ts"))) {
      if (file === "account.service.ts") continue; // owns the account itself
      const source = fs.readFileSync(path.join(serviceDir, file), "utf8");
      source.split("\n").forEach((line, i) => {
        if (/\baccountId\s*[!=]==?\s*\w/.test(line) || /\w\s*[!=]==?\s*\S*\baccountId\b/.test(line)) {
          offenders.push(`${file}:${i + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

describe("phase 05 — the account id enters at exactly one place", () => {
  it("only accountMiddleware reads an account id from the request", () => {
    // Phase 03's version of this asserted NOTHING read the header. Phase 05 is
    // the phase that introduces it, so the invariant narrows rather than
    // disappears: the header is forgeable, and it is only safe because one
    // middleware checks membership unconditionally before anything trusts it.
    // A controller or route reading it directly would bypass that check — which
    // is the single way a user reads another's channel by editing their browser.
    const roots = ["src/routes", "src/middleware", "src/controller"];
    const ENTRY_POINT = "src/middleware/account.ts";
    const offenders: string[] = [];

    for (const root of roots) {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".ts")) {
            const rel = path.relative(process.cwd(), full);
            if (rel === ENTRY_POINT) continue;
            const source = fs.readFileSync(full, "utf8");
            if (/x-account-id/i.test(source) || /req\.(body|query|params|headers)\W+accountId/.test(source)) {
              offenders.push(rel);
            }
          }
        }
      };
      walk(path.join(process.cwd(), root));
    }

    expect(offenders).toEqual([]);
  });
});

describe("phase 03 — nothing READS accountId yet", () => {
  // "If this phase is working correctly, users notice nothing at all." Reads
  // switch in Phase 06, and switching one early is a silent tenancy change: the
  // query would filter on a field that only NEW records carry, so every record
  // written before this phase would vanish from that list.
  it("no query filters on accountId", () => {
    const dir = path.join(process.cwd(), "src", "repository");
    const offenders: string[] = [];

    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      // `accounts` is the new collection's OWN repository — it legitimately
      // queries membership. Every other repository must still filter createdBy.
      if (file === "account.repository.ts") continue;
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      if (/\.where\(\s*["']accountId["']/.test(source)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
