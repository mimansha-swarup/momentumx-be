import fs from "fs";
import path from "path";

/**
 * Every model call must run inside the generation seam.
 *
 * Sibling of auth-coverage and validation-coverage, and the reason is the same:
 * the seam only guarantees anything if nothing can go around it. Phase 08 puts
 * the credit debit and refund inside `StepRunner.run`. A `generateContent` call
 * that sits outside it is a generation that is never charged and never rolled
 * back — and nothing else in the codebase would notice.
 *
 * This is a RATCHET. `UNWRAPPED` lists call sites not yet converted; it may
 * shrink, never grow. A NEW model call outside the seam fails this suite, and a
 * site that gets wrapped (or removed) must leave the list, so it cannot rot.
 *
 * Phase 01b conversion status is therefore readable straight off this list.
 */

const SERVICE_DIR = path.join(process.cwd(), "src", "service");
const MODEL_CALL = /\b(generateContent|generateStreamingContent)\s*\(/;

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

type CallSite = { file: string; line: number; insideSeam: boolean };

/**
 * Brace-depth scan rather than a full AST parse: find `steps.run(` and record the
 * region until its matching close paren. A model call whose line falls inside any
 * such region is wrapped.
 *
 * Deliberately not a TypeScript AST walk — this needs to answer one lexical
 * question, and a parser dependency to answer it would cost more than it returns.
 */
const collectCallSites = (): CallSite[] => {
  const sites: CallSite[] = [];

  for (const file of fs.readdirSync(SERVICE_DIR).filter((f) => f.endsWith(".ts"))) {
    const raw = stripComments(fs.readFileSync(path.join(SERVICE_DIR, file), "utf8"));
    const lines = raw.split("\n");

    // Character offset of each line start, so we can map depth back to lines.
    const seamRegions: Array<[number, number]> = [];
    const runIdx = /\bsteps\.run\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = runIdx.exec(raw))) {
      let depth = 0;
      let i = match.index + match[0].length - 1;
      for (; i < raw.length; i++) {
        if (raw[i] === "(") depth++;
        else if (raw[i] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      seamRegions.push([match.index, i]);
    }

    let offset = 0;
    lines.forEach((line, idx) => {
      if (MODEL_CALL.test(line)) {
        const inside = seamRegions.some(([s, e]) => offset >= s && offset <= e);
        sites.push({ file, line: idx + 1, insideSeam: inside });
      }
      offset += line.length + 1;
    });
  }

  return sites;
};

/**
 * Model calls not yet inside the seam. Shrink this; never add to it.
 * Format: "<file>:<line-ish>" is deliberately NOT used — line numbers churn.
 * Keyed by file + the count still outstanding in it.
 */
const UNWRAPPED: Record<string, number> = {
  // Ideas generation (no project, so no lock — still needs the seam for metering
  // and telemetry) plus the two script paths, which carry the OTHER real lock.
  "content.service.ts": 3,
  // The packaging fan-out: title / description / thumbnail / shorts, plus the
  // shared private generateContent helper. Deliberately unlocked by design (see
  // KIND_STEP), but still to be wrapped for metering.
  "packaging.service.ts": 5,
  // Onboarding prefill.
  "user.service.ts": 1,
};

describe("generation seam — no model call escapes the runner", () => {
  const sites = collectCallSites();

  it("finds model call sites to check", () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it("has no unwrapped call in a file that is meant to be fully converted", () => {
    const unwrappedByFile: Record<string, number> = {};
    for (const site of sites) {
      if (!site.insideSeam) {
        unwrappedByFile[site.file] = (unwrappedByFile[site.file] ?? 0) + 1;
      }
    }

    // A file absent from UNWRAPPED must have zero unwrapped calls.
    const unexpected = Object.keys(unwrappedByFile).filter((f) => !(f in UNWRAPPED));
    expect(unexpected).toEqual([]);
  });

  it("has no file with MORE unwrapped calls than recorded", () => {
    const unwrappedByFile: Record<string, number> = {};
    for (const site of sites) {
      if (!site.insideSeam) {
        unwrappedByFile[site.file] = (unwrappedByFile[site.file] ?? 0) + 1;
      }
    }

    const grew = Object.entries(unwrappedByFile)
      .filter(([file, count]) => count > (UNWRAPPED[file] ?? 0))
      .map(([file, count]) => `${file}: ${count} > ${UNWRAPPED[file] ?? 0}`);

    expect(grew).toEqual([]);
  });

  // Keeps the list honest: once a file is converted, its entry must go.
  it("has no stale entries — a recorded file must still have that many unwrapped", () => {
    const unwrappedByFile: Record<string, number> = {};
    for (const site of sites) {
      if (!site.insideSeam) {
        unwrappedByFile[site.file] = (unwrappedByFile[site.file] ?? 0) + 1;
      }
    }

    const stale = Object.entries(UNWRAPPED)
      .filter(([file, count]) => (unwrappedByFile[file] ?? 0) !== count)
      .map(([file, count]) => `${file}: recorded ${count}, actual ${unwrappedByFile[file] ?? 0}`);

    expect(stale).toEqual([]);
  });

  // hooks.service.ts is the phase's reference conversion — both its model calls
  // are inside the seam, and it must stay that way.
  it("keeps hooks.service.ts fully wrapped", () => {
    const hooks = sites.filter((s) => s.file === "hooks.service.ts");
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.every((s) => s.insideSeam)).toBe(true);
  });
});

/**
 * The scan above only looks at `src/service`, and only for the two WRAPPER
 * names. The wrappers themselves live in `src/utlils/ai.ts` and reach the SDK
 * through `genAIModel(...).generateContentStream(...)` — a different directory
 * and a different method name, so the ratchet could not see the place
 * generation actually happens.
 *
 * Two ways past it, both invisible to everything above: add a third generation
 * helper beside the existing two, or call the SDK straight from a service.
 * Either is an uncharged, un-refunded, un-rate-limited generation once Phase 08
 * attaches billing to the seam.
 *
 * So the SDK itself gets a single door.
 */
describe("the model SDK is reachable from exactly one file", () => {
  const SDK_DOOR = "src/utlils/ai.ts";
  // `content.ts` imports the EMBEDDING model, which is not a generation and is
  // not metered — it is a vector call for KMeans clustering.
  const EMBEDDING_DOOR = "src/utlils/content.ts";

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".ts") ? [path.relative(process.cwd(), full)] : [];
    });

  const sources = walk(path.join(process.cwd(), "src")).map((rel) => ({
    rel,
    source: stripComments(fs.readFileSync(path.join(process.cwd(), rel), "utf8")),
  }));

  it("only the seam and the embedding helper import the model factory", () => {
    const importers = sources
      .filter(({ source }) => /from\s+["'][^"']*config\/ai/.test(source))
      .map(({ rel }) => rel)
      .sort();

    expect(importers).toEqual([EMBEDDING_DOOR, SDK_DOOR].sort());
  });

  it("nothing outside the seam calls the SDK's streaming method directly", () => {
    const offenders = sources
      .filter(({ rel, source }) => rel !== SDK_DOOR && /\.generateContentStream\s*\(/.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it("the seam exports exactly the two generation helpers the ratchet scans for", () => {
    // A third helper added here would be wrapped by nothing and counted by
    // nothing — MODEL_CALL above only knows these two names.
    const seam = sources.find(({ rel }) => rel === SDK_DOOR)!.source;
    const exported = [...seam.matchAll(/export const (\w+)\s*=\s*(?:async\s*)?[(<]/g)].map(
      (m) => m[1]
    );

    expect(exported.sort()).toEqual(["collectJson", "generateContent", "generateStreamingContent"]);
  });
});
