import ts from "typescript";
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
 * Phase 01b's conversion is complete: every model call site in `src/service`
 * must be inside the seam, full stop — no allowlist of not-yet-converted
 * sites to maintain.
 */

const SERVICE_DIR = path.join(process.cwd(), "src", "service");
// Kept in sync with the seam's actual exports by the "exactly the generation helpers"
// test below — so another helper cannot be added without this list being faced.
const MODEL_CALL_G = /\b(generateContent|generateStreamingContent|generateTextContent|streamScript)\s*\(/g;

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
  for (const file of fs.readdirSync(SERVICE_DIR).filter(f => f.endsWith(".ts"))) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(SERVICE_DIR, file), "utf8"), ts.ScriptTarget.Latest, true);
    const modelPositions = new Set<number>();
    const methods = new Map<string, { private: boolean; calls: { target: string; guarded: boolean }[]; models: { line: number; guarded: boolean }[] }>();
    const visitClass = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) for (const member of node.members) {
        // Arrow PROPERTIES are this codebase's house style, but a METHOD
        // declaration is valid TypeScript and was invisible here: its calls never
        // entered the caller graph, so an unmetered `async freeTitles() { return
        // this.runTitle(...) }` reached the model through a private helper and
        // this file still passed. A bare model call in a method was caught by the
        // separate unowned-site scan; only the indirect form slipped.
        if (!ts.isPropertyDeclaration(member) && !ts.isMethodDeclaration(member)) continue;
        const declared = member as ts.PropertyDeclaration | ts.MethodDeclaration;
        const body = ts.isPropertyDeclaration(declared) ? declared.initializer : declared.body;
        if (!declared.name || !body) continue;
        const entry = { private: declared.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword) ?? false, calls: [] as {target: string; guarded: boolean}[], models: [] as {line: number; guarded: boolean}[] };
        methods.set(declared.name.getText(source), entry);
        const scan = (child: ts.Node, guarded: boolean) => {
          if (ts.isCallExpression(child)) {
            if (child.expression.getText(source) === "this.steps.run") {
              child.arguments.forEach(arg => scan(arg, true));
              return;
            }
            if (ts.isIdentifier(child.expression) && ["generateContent", "generateStreamingContent", "generateTextContent", "streamScript"].includes(child.expression.text)) {
              modelPositions.add(child.getStart());
              entry.models.push({ line: source.getLineAndCharacterOfPosition(child.getStart()).line + 1, guarded });
            }
            if (ts.isPropertyAccessExpression(child.expression) && child.expression.expression.kind === ts.SyntaxKind.ThisKeyword) entry.calls.push({ target: child.expression.name.text, guarded });
          }
          ts.forEachChild(child, n => scan(n, guarded));
        };
        scan(body, false);
      }
      ts.forEachChild(node, visitClass);
    };
    visitClass(source);
    const scanUnowned = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ["generateContent", "generateStreamingContent", "generateTextContent", "streamScript"].includes(node.expression.text)
        && !modelPositions.has(node.getStart())) sites.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, insideSeam: false });
      ts.forEachChild(node, scanUnowned);
    };
    scanUnowned(source);
    // Shared PRIVATE prompt/model helpers are protected only if EVERY caller
    // reaches them inside the seam. Public entry points cannot inherit a guard.
    const protectedMethod = (name: string, seen = new Set<string>()): boolean => {
      const method = methods.get(name);
      if (!method?.private || seen.has(name)) return false;
      const next = new Set(seen).add(name);
      const callers = [...methods].flatMap(([caller, value]) => value.calls.filter(c => c.target === name).map(c => ({ caller, ...c })));
      return callers.length > 0 && callers.every(c => c.guarded || protectedMethod(c.caller, next));
    };
    for (const [name, method] of methods) for (const call of method.models) sites.push({ file, line: call.line, insideSeam: call.guarded || protectedMethod(name) });
  }
  return sites;
};

describe("generation seam — no model call escapes the runner", () => {
  const sites = collectCallSites();

  it("finds model call sites to check", () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it("has no unwrapped generation call sites", () => {
    const unwrapped = sites.filter((s) => !s.insideSeam);
    expect(unwrapped).toEqual([]);
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
  const STARTUP_LOG = "src/server.ts";

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

  it("only the seam, embedding helper, and startup log import AI configuration", () => {
    const importers = sources
      .filter(({ source }) => /from\s+["'][^"']*config\/ai/.test(source))
      .map(({ rel }) => rel)
      .sort();

    expect(importers).toEqual([EMBEDDING_DOOR, SDK_DOOR, STARTUP_LOG].sort());
  });

  it("startup imports only the model ID for logging, never a callable model", () => {
    const source = sources.find(({ rel }) => rel === STARTUP_LOG)!.source;
    const imports = [...source.matchAll(/import\s+([^;]*?)\s+from\s+["'][^"']*config\/ai[^"']*["']/g)];
    expect(imports).toHaveLength(1);
    expect(imports[0][1].trim()).toBe("{ GENERATION_MODEL }");
  });

  // `content.ts` is exempt from the IMPORT rule because it needs the embedding
  // model — but a whole-file exemption meant a generation call could simply be
  // written there: `src/utlils` is not scanned by `collectCallSites`, so all six
  // tests above would pass. Narrow it to the named import it actually needs.
  it("the embedding door imports only the embedding model, not the generation factory", () => {
    const source = sources.find(({ rel }) => rel === EMBEDDING_DOOR)!.source;
    const importLine = source.match(/import\s+([^;]*?)\s+from\s+["'][^"']*config\/ai[^"']*["']/);

    expect(importLine).not.toBeNull();
    // A DEFAULT import is `genAIModel` — the generation factory.
    expect(importLine![1]).toMatch(/^\{[^}]*\}$/);
    expect(importLine![1]).toContain("embeddingModel");
    expect(importLine![1]).not.toContain("genAIModel");
  });

  it("nothing outside the seam calls the SDK's generation methods directly", () => {
    const offenders = sources
      .filter(
        ({ rel, source }) =>
          rel !== SDK_DOOR &&
          // BOTH SDK methods. The ban was on `generateContentStream` only, so a
          // call to the SDK's non-streaming `generateContent` was unrestricted.
          /\.generateContentStream\s*\(|genAIModel\s*\([^)]*\)\s*\.\s*generateContent\s*\(/.test(
            source
          )
      )
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it("the seam exports exactly the generation helpers the ratchet scans for", () => {
    // Another helper added here would be wrapped by nothing and counted by
    // nothing — MODEL_CALL above only knows these generation names.
    const seam = sources.find(({ rel }) => rel === SDK_DOOR)!.source;
    // EVERY export form, not just `export const x = (`. Executed against the
    // five ways this could be written, the first version saw exactly one:
    //   export const foo = (a) => {}              SEEN
    //   export async function generateAudio() {}  INVISIBLE
    //   export function generateAudio() {}        INVISIBLE
    //   export const generateAudio: Gen = async…  INVISIBLE
    //   export const generateAudio = async funct… INVISIBLE
    // A helper added in any of those four shapes is wrapped by nothing and
    // counted by nothing — which is precisely what this test claims to prevent.
    const exported = [
      ...seam.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g),
      ...seam.matchAll(/export\s+const\s+(\w+)\s*(?::[^=]+)?=/g),
      ...seam.matchAll(/export\s*\{([^}]*)\}/g),
    ].flatMap((m) => m[1].split(",").map((name) => name.trim().split(/\s+as\s+/)[0]))
      .filter(Boolean);

    expect(exported.sort()).toEqual(["collectJson", "generateContent", "generateStreamingContent", "generateTextContent", "streamScript"]);
  });
});
