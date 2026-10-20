# Momentum-X backend

The API is tested on **Node 22, 24, and 26**. Node 24 is the recommended default
(see `.nvmrc`); an existing Node 26 installation can run `npm ci` and `npm run dev`
directly. The startup check rejects versions older than 22 and warns, rather than
blocks, when experimenting with versions outside the tested matrix.

With nvm installed:

```sh
nvm install
nvm use
npm ci
npm run dev
```

If you use another Node manager, select Node 24 and verify `node --version` before
running the npm commands. The `.nvmrc` file does not change your shell's runtime
automatically.

Without a Node manager, npm can run this command with an isolated Node 24 runtime
(downloaded on first use, without changing your global Node installation):

```sh
npm exec --yes --package=node@24 -- npm run dev
```

Local development requires a `.env` file with the project's service credentials,
including `FIREBASE_SERVICE_ACCOUNT_BASE64` and `API_KEY`. Obtain the development configuration
from the project owner; do not commit credentials. `npm run dev` loads this file
and serves the API at `http://localhost:3000`, automatically restarting after
source changes. `npm run dev:watch` provides the same behavior. Both commands use
the installed, locked version of `tsx`. Restart the command after changing `.env`.

Set `GENERATION_MODEL` in `.env` or your hosting environment to select a Gemini
generation model available to your API key. Use its bare model ID (without
`models/` or a URL). When omitted, the default is `gemini-3.8-flash`.
The setting applies to scripts, ideas, hooks, titles, and other generated content;
it does not change `gemini-embedding-001` or existing embeddings. There is no
automatic model fallback. Verify the chosen model supports the application's
structured output and generation settings before switching, and restart the
backend after changing this setting. A model switch can change quality, latency,
and provider cost; availability does not guarantee free capacity.

Existing shell or hosting environment variables take precedence over `.env`.
If a local override is stale, run `unset GENERATION_MODEL`, then restart
`npm run dev`. The startup `ai_model_configured` log shows the effective model
without exposing credentials. Restart the watcher itself after editing `.env`;
a source reload is not a substitute for reloading its environment.

For the compiled application:

```sh
npm run build
npm start
```

`npm start` loads `.env` if present. Deployed environments can supply the variables
directly without a file. `GET /` is a basic HTTP startup check; it does not verify
external services or credentials.

## Runtime upgrades

The GitHub Actions matrix checks real Firebase/JWT imports, signature verification,
types, the build, and tests on Node 22/24/26. Mocked application tests alone do not
catch dependency import failures. `npm run test:runtime` runs the real dependency
check locally without credentials or service calls.

For a new Node major, update dependencies within their supported ranges, run this
matrix plus a local `npm run dev` startup check, then add the major to `engines`,
`scripts/check-node.cjs`, and the workflow. Update `.nvmrc` when changing the default.
Keep Node types at the oldest supported runtime so shared code does not accidentally
require newer APIs. A new version is not supported merely because startup permits it.

Hosting selects runtimes separately: Vercel currently supports Node 22/24 and chooses
24 from this package's engines range on the next deployment (the package engines
override the dashboard setting). It may select a newer
allowed major when platform support arrives; review runtime selection before each
upgrade/deploy. Render uses `.nvmrc` (24) unless its `NODE_VERSION` setting or a
`.node-version` overrides it. Check existing host settings before deployment.
The separate `functions/package.json` targets Node 24 and second-generation Auth
triggers, with its own Node 24 CI install/build job. The Auth lifecycle triggers
are labeled **Preview** in the Auth guide but GA in SDK 7.4.0 release notes. Read [the Functions migration runbook](functions/README.md)
before deployment; the new function names require a controlled handover from gen1.
API compatibility with Node 26 does not imply Firebase Functions or Vercel deployment
support. No hosting settings are changed by local testing.
