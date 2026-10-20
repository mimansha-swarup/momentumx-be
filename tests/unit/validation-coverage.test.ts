import fs from "fs";
import path from "path";

/**
 * Every route whose controller reads `req.body` must mount a validation schema.
 *
 * Sibling of auth-coverage.test.ts, and it exists for the same reason: a rule
 * that lives only in prose gets forgotten. `POST /v1/packaging/save` shipped with
 * no schema and spread its raw body onto the stored document, which let a client
 * write `isStale` and `itemStatuses` directly and defeat the stale cascade
 * (Phase 01 item 7). Nothing caught it because nothing was looking.
 *
 * The invariant is derived from ground truth rather than guessed: a route needs a
 * schema exactly when its controller method touches `req.body`. Routes that carry
 * no body (`POST /:ideaId/regenerate`, `DELETE /:projectId`, the step-complete
 * PATCHes) are excluded automatically — not by an opinion recorded here.
 *
 * This started as a ratchet over 14 unvalidated routes with an allowlist. The
 * allowlist reached zero, so it is gone along with the test that kept it honest:
 * an exemption mechanism nothing is exempt from is a concept to maintain for no
 * return. The rule is now flat — every body-reading route mounts a schema, and a
 * new one that does not fails here. If a genuine exception ever turns up, argue it
 * then; adding the list back is four lines.
 */

const ROUTES_DIR = path.join(process.cwd(), "src", "routes", "v1");
const CONTROLLER_DIR = path.join(process.cwd(), "src", "controller");

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

/** Controller methods that read req.body, as `controllerVar.method` is written in routes. */
const collectBodyReadingMethods = (): Set<string> => {
  const found = new Set<string>();

  for (const file of fs.readdirSync(CONTROLLER_DIR).filter((f) => f.endsWith(".controller.ts"))) {
    const source = stripComments(fs.readFileSync(path.join(CONTROLLER_DIR, file), "utf8"));
    let current: string | null = null;

    for (const line of source.split("\n")) {
      const declaration = line.match(/^\s{2}(\w+)\s*=\s*(asyncHandler|async)/);
      if (declaration) current = declaration[1];
      if (current && /req\.body/.test(line)) found.add(current);
    }
  }

  return found;
};

type RouteRegistration = {
  file: string;
  method: string;
  routePath: string;
  handler: string; // bare controller method name
  validated: boolean;
  inlineBodyReader: boolean;
};

const collectRoutes = (): RouteRegistration[] => {
  const routes: RouteRegistration[] = [];

  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".route.ts"))) {
    const source = stripComments(fs.readFileSync(path.join(ROUTES_DIR, file), "utf8"));

    // Paren-depth scan, NOT a per-line regex. An end-of-line-anchored match
    // silently skips any registration spread over several lines — which is a
    // FALSE PASS in a coverage ratchet, the one failure mode that makes it worse
    // than having no ratchet at all. It really happened: the multi-line
    // `PATCH /:projectId/link/:resourceType` registration was invisible to this
    // scanner (41 of 42 routes seen), so validation could have been stripped from
    // that route without a single test failing.
    const registration = /router\.(get|post|patch|put|delete)\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = registration.exec(source))) {
      let depth = 0;
      let i = match.index + match[0].length - 1;
      for (; i < source.length; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }

      const args = source.slice(match.index + match[0].length, i);
      const pathMatch = args.match(/^\s*"([^"]+)"/);
      if (!pathMatch) continue;

      const rest = args.slice(pathMatch[0].length);
      const handlerRef = rest.trim().replace(/,\s*$/, "").split(",").pop()?.trim() ?? "";

      routes.push({
        file,
        method: match[1].toUpperCase(),
        routePath: pathMatch[1],
        handler: handlerRef.split(".").pop() ?? "",
        validated: /validate\s*\(/.test(rest),
        inlineBodyReader: /\breq\.body\b/.test(rest),
      });
    }
  }

  return routes;
};

/** Raw count of registrations, independent of how they are parsed. */
const countRegistrations = (): number => {
  let total = 0;
  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".route.ts"))) {
    const source = stripComments(fs.readFileSync(path.join(ROUTES_DIR, file), "utf8"));
    total += (source.match(/router\.(get|post|patch|put|delete)\s*\(/g) ?? []).length;
  }
  return total;
};

const describeRoute = (r: RouteRegistration) => `${r.file} ${r.method} ${r.routePath}`;

describe("validation coverage — every body-reading route mounts a schema", () => {
  const routes = collectRoutes();
  const bodyReaders = collectBodyReadingMethods();

  it("discovers routes and controllers", () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(bodyReaders.size).toBeGreaterThan(0);
  });

  // The guard against this suite silently scanning nothing. If the parser drifts
  // — a new formatting style, a regex tweak — this fails loudly instead of the
  // coverage assertions passing over a shrinking set they no longer see.
  it("parses EVERY route registration, including multi-line ones", () => {
    expect(routes.length).toBe(countRegistrations());
  });

  const bodyRoutes = routes.filter((r) => r.inlineBodyReader || bodyReaders.has(r.handler));

  it("finds routes whose controller reads req.body", () => {
    expect(bodyRoutes.length).toBeGreaterThan(0);
  });

  it("has no body-reading route without a schema", () => {
    const offenders = bodyRoutes.filter((r) => !r.validated).map(describeRoute);

    expect(offenders).toEqual([]);
  });

  // A route with a schema whose controller never reads the body is dead weight —
  // usually a copy-paste, occasionally a sign the controller stopped reading input.
  it("mounts no schema on a route that never reads a body", () => {
    const pointless = routes
      .filter((r) => r.validated && !r.inlineBodyReader && !bodyReaders.has(r.handler))
      .map(describeRoute);

    expect(pointless).toEqual([]);
  });
});

/**
 * A schema that is MOUNTED but not STRICT is the bug this suite exists for.
 *
 * The check above asks whether `validate(` appears next to a route. It cannot
 * ask whether the schema does anything — and the defect it was written after
 * was not a missing schema. `POST /v1/packaging/save` spread its raw body onto
 * the stored document (`const { videoProjectId, ...rest } = req.body`, still
 * there in `packaging.controller.ts`), which let a client write `isStale` and
 * `itemStatuses` directly and defeat the stale cascade.
 *
 * What actually stops that today is `validate` reassigning `req.body =
 * result.data` and zod dropping unknown keys. Switch one schema to
 * `.passthrough()` and the original hole reopens with `validate(` still sitting
 * on the route and this suite still green.
 */
/**
 * The ways a zod object stops stripping unknown keys.
 *
 * `z.looseObject(...)` is the zod-4 spelling and this repo is on 4.4.3 —
 * verified: `z.looseObject({a:z.string()}).parse({a:'x',evil:1})` returns
 * `{a:'x',evil:1}`. The first version of this scan knew only the zod-3 names,
 * so it was one edit away from reopening the packaging-save hole on a codebase
 * where that edit is the idiomatic one.
 *
 * Field-level `z.unknown()` / `z.any()` are deliberately NOT here. They say
 * "this key is permitted, its shape is owned downstream" — `packagingSaveSchema`
 * uses them for exactly that — and the enclosing `z.object` still strips
 * everything unnamed. Flagging them produced four false positives on correct
 * code, which is how a ratchet gets deleted. The whole-body case is covered by
 * the separate check below.
 */
const OBJECT_LEVEL_ESCAPE =
  /\.(passthrough|loose|catchall|nonstrict)\s*\(|\bz\.looseObject\s*\(/g;

describe("validation coverage — a mounted schema also has to strip", () => {
  const VALIDATION_DIR = path.join(process.cwd(), "src", "validation");

  it("no request schema opts out of stripping unknown keys", () => {
    const offenders: string[] = [];

    for (const file of fs.readdirSync(VALIDATION_DIR).filter((f) => f.endsWith(".ts"))) {
      const source = stripComments(fs.readFileSync(path.join(VALIDATION_DIR, file), "utf8"));
      // `z.looseObject(...)` is the idiomatic non-stripping object in zod 4 (this
      // repo is on 4.4.3) and does NOT match `\.loose\s*\(`. Verified:
      //   z.looseObject({a:z.string()}).parse({a:'x',evil:1}) -> {a:'x',evil:1}
      // So the first version of this scan knew only the zod-3 spellings, on a
      // zod-4 codebase — one edit away from reopening the packaging-save hole
      // it was written for. `z.any()` and `z.record(...)` as a whole body are
      // the same escape by a different route.
      for (const match of source.matchAll(OBJECT_LEVEL_ESCAPE)) {
        offenders.push(`${file}:${source.slice(0, match.index).split("\n").length} ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // The escape `OBJECT_LEVEL_ESCAPE` cannot see: `export const fooSchema =
  // z.any()`. There is no object to strip with, so `validate` passes the raw
  // body through untouched.
  it("every exported request schema is built from z.object", () => {
    const offenders: string[] = [];

    for (const file of fs.readdirSync(VALIDATION_DIR).filter((f) => f.endsWith(".ts"))) {
      const source = stripComments(fs.readFileSync(path.join(VALIDATION_DIR, file), "utf8"));
      // Identifiers in this file that ARE a z.object — so an alias
      // (`profileUpdateSchema = userFields`) or a chain
      // (`onboardingSchema = userFields.refine(...)`) resolves correctly.
      // `.refine`/`.superRefine` add a predicate; they do not stop stripping.
      const objectLocals = new Set(
        [...source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*z\s*\.\s*object\s*\(/g)].map(
          (m) => m[1]
        )
      );

      for (const match of source.matchAll(/export const (\w*[Ss]chema)\s*=\s*([\s\S]{0,40})/g)) {
        const rhs = match[2].trim();
        const rootsInObject =
          /^z\s*\.\s*object\s*\(/.test(rhs) ||
          [...objectLocals].some((local) => new RegExp(`^${local}\\b`).test(rhs));
        if (!rootsInObject) offenders.push(`${file} ${match[1]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The strip is a property of the middleware, not of each schema — so assert it
   * BEHAVIOURALLY. The first version of this matched the source text for
   * `req.body = result.data`, which `if (FLAG) req.body = result.data` also
   * satisfies, as does an early `return next()` inserted above it.
   */
  it("validate actually strips unknown keys off req.body", async () => {
    const { validate } = await import("../../src/middleware/validate");
    const { z } = await import("zod");

    const req = { body: { title: "keep", isStale: true, itemStatuses: {} } } as never;
    const next = jest.fn();

    validate(z.object({ title: z.string() }))(req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect((req as { body: Record<string, unknown> }).body).toEqual({ title: "keep" });
  });
});
