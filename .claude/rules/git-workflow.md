---
name: git-workflow
description: Commit message format, branch naming, and dist/ build rules for MomentumX.
---

# Git Workflow

Commit message format, branch naming, and dist/ build rules. Keeps git history clean and Vercel deployments working correctly.

---

## Commit Message Format — Conventional Commits

Follows [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>[optional scope]: <description>
```

- Keep the description short (under 72 chars) — no body or footer needed
- Never add a `Co-Authored-By` or any other footer to commits

**Types:** `feat` | `fix` | `refactor` | `chore` | `docs` | `test` | `perf` | `ci` | `build` | `style` | `revert`
**Scopes:** `user` | `content` | `packaging` | `hooks` | `video-project` | `research` | `ai` | `db` | `deploy` | `config`

Breaking changes use `!` after the type/scope: `feat(content)!: redesign topic response shape`

**Examples:**

```
feat(content): add trending topics endpoint
fix(ai): handle malformed JSON from Gemini
refactor(packaging): extract generation into separate service methods
test(content): add unit tests for topic service
docs(api): update packaging endpoint reference
chore(db): add scriptId field to packaging collection
perf(content): cap KMeans clustering at 200 topics
```

---

## Branch Naming — Conventional Branch

Follows [Conventional Branch](https://conventional-branch.github.io/).

```
<type>/<description>
```

**Types:** `feature/` or `feat/` | `bugfix/` or `fix/` | `hotfix/` | `release/` | `chore/`

**Examples:**

```
feature/add-trending-topics-endpoint
feature/sse-script-streaming
bugfix/fix-stale-cascade
bugfix/malformed-json-handling
hotfix/security-patch
release/v1.2.0
chore/update-dependencies
feature/issue-123-hooks-generation
```

Rules:

- Always lowercase letters, numbers, and hyphens only
- No consecutive or leading/trailing hyphens
- Dots allowed in release versions (`release/v1.2.0`)
- Optionally include ticket number: `feature/issue-123-description`

---

## dist/ Rule — Always Build Before Committing a Feature

```bash
npm run build    # compiles src/ → dist/
```

- Vercel uses pre-built `dist/` — `vercel-build` is a no-op script
- A source change without a `dist/` update means a broken deployment
- Always commit `dist/` alongside the source change that produced it
- Never commit `dist/` alone without an accompanying source change

---

## Never Commit

- `.env` or any file containing API keys
- `node_modules/`
- Firebase service account JSON files
- Any file matching `.gitignore` patterns

---

## Before Pushing

- `npm run build` passes with no TypeScript errors
- No `console.log` left in production code paths
- No uncommitted changes to `.env`
- `dist/` is up to date with the latest source changes
