import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * What each service ASKS the billing seam for.
 *
 * `StepRunner.run(spec, generate)` does nothing on its own — the `spec` is what
 * decides whether a generation is paid for, whether it takes an in-flight lock,
 * and whether its writes are token-fenced against a superseding run. All of that
 * is chosen by one string literal at the call site.
 *
 * Nothing pinned those literals. Changing `kind: "script"` to `kind: "prefill"`
 * in `content.service.ts` left the entire 1243-test suite green, because
 * `BillingRepository.reserve` short-circuits on `prefill` on its FIRST line —
 * before the membership check, the viewer check, the project lock and the debit.
 * Script generation became free, unlocked (so two tabs generate the same script
 * concurrently, which is the whole point of the lock) and unfenced, with no test
 * failing and no type error. The same mutation was green at all three `ideas`
 * sites.
 *
 * It was invisible because every service-level test mocks the seam
 * (`tests/helpers/step-runner.ts` discards the spec entirely) or mocks
 * `billing.reserve` to return a charge regardless of what it was asked for. Those
 * mocks are right for what those tests are about; the consequence is that the
 * spec itself is asserted nowhere. This is that assertion.
 *
 * Counts, not just a set: a kind changing at ONE of three `ideas` sites has to
 * fail, and it only shows up as a count.
 *
 * WHAT THIS FILE IS, AND IS NOT. It is a STRUCTURAL INVENTORY of the literals in
 * the source: it catches a kind being introduced, removed, or changed into a
 * different kind within a file. It cannot catch a kind being SWAPPED between two
 * call sites in the same file — trade `"title"` and `"description"` between
 * `generateTitle` and `generateDescription` and every count below is unchanged,
 * while the two operations charge each other's price and fence each other's
 * writes. That claim is behavioural and is made behaviourally, per operation, in
 * `tests/unit/service/generation-spec.behaviour.test.ts`, which invokes each
 * public operation and reads the spec the seam was handed. The two are siblings:
 * this file notices a NEW site nobody has driven yet, that file notices a site
 * asking for the wrong thing.
 */
const SERVICE_DIR = join(__dirname, "..", "..", "src", "service");

const EXPECTED_KINDS: Record<string, Record<string, number>> = {
  "content.service.ts": { ideas: 3, script: 2 },
  "hooks.service.ts": { hooks: 2 },
  "packaging.service.ts": {
    title: 1,
    description: 1,
    thumbnail: 1,
    shorts: 1,
  },
  // Free by design, and the ONLY kind `reserve` short-circuits. It still runs
  // through the seam for the shared failure logging.
  "user.service.ts": { prefill: 1 },
};

/**
 * Sites that pass the kind through from a validated route param rather than a
 * literal. Shrink-only: a new one needs a written reason here, because a
 * non-literal kind is exactly what this file cannot check.
 *
 * `packaging.service.regenerateItem` takes `item` from `/:packagingId/regenerate/:item`
 * and narrows it to a `PackagingItemName` before `steps.run`, so it cannot widen
 * into `prefill` or a bare string.
 */
const DYNAMIC_KIND_SITES: Record<string, number> = {
  "packaging.service.ts": 1,
};

interface Site {
  file: string;
  line: number;
  kind: string | null;
}

const seamSites = (): Site[] => {
  const sites: Site[] = [];
  for (const file of readdirSync(SERVICE_DIR).filter((name) =>
    name.endsWith(".service.ts")
  )) {
    const source = readFileSync(join(SERVICE_DIR, file), "utf8");
    // Non-greedy across newlines: several call sites wrap their spec object.
    const call = /steps\.run\(\s*\{(.{0,300}?)\}/gs;
    let match: RegExpExecArray | null;
    while ((match = call.exec(source)) !== null) {
      const kind = /kind:\s*"([a-z]+)"/.exec(match[1]);
      sites.push({
        file,
        line: source.slice(0, match.index).split("\n").length,
        kind: kind ? kind[1] : null,
      });
    }
  }
  return sites;
};

const countByKind = (sites: Site[]) => {
  const counted: Record<string, Record<string, number>> = {};
  for (const site of sites) {
    if (!site.kind) continue;
    counted[site.file] ??= {};
    counted[site.file][site.kind] = (counted[site.file][site.kind] ?? 0) + 1;
  }
  return counted;
};

describe("what each service asks the billing seam for", () => {
  it("finds the seam at all, so a broken scan cannot pass vacuously", () => {
    const sites = seamSites();
    expect(sites.length).toBeGreaterThanOrEqual(13);
    expect(new Set(sites.map((site) => site.file)).size).toBe(4);
  });

  // INVENTORY, not a per-operation guarantee: these are per-FILE counts of the
  // literals, so they are blind to two sites in one file trading kinds. Which
  // operation asks for which kind is asserted by running them, in
  // `tests/unit/service/generation-spec.behaviour.test.ts`.
  // This inventory subsumes a "prefill is only free at user.service.ts" check:
  // EXPECTED_KINDS names prefill at exactly one file, so any other file
  // acquiring a "prefill" literal already fails the toEqual below — a separate
  // assertion for that would just be re-reading the same scan.
  it("declares exactly the expected inventory of kind literals per file", () => {
    expect(countByKind(seamSites())).toEqual(EXPECTED_KINDS);
  });

  it("keeps non-literal kinds to the sites that justify them", () => {
    const dynamic: Record<string, number> = {};
    for (const site of seamSites().filter((site) => site.kind === null)) {
      dynamic[site.file] = (dynamic[site.file] ?? 0) + 1;
    }

    expect(dynamic).toEqual(DYNAMIC_KIND_SITES);
  });
});
