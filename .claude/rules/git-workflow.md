---
name: git-workflow
description: Commit message format, branch naming, and dist/ build rules for MomentumX.
---

# Git Workflow

Commit message format, branch naming, and dist/ build rules. Keeps git history clean and Vercel deployments working correctly.

---

## Commit Message Format

```
type(scope): short description

Types:  feat | fix | refactor | prompt | chore | docs | test
Scopes: user | content | packaging | ai | db | deploy | config
```

**Examples:**
```
feat(content): add trending topics endpoint
fix(ai): handle malformed JSON from Gemini
prompt(ai): refine script system prompt for retention
test(content): add unit tests for topic service
docs(api): update packaging endpoint reference
chore(db): add scriptId field to packaging collection
refactor(packaging): extract generation into separate service methods
```

---

## Branch Naming

```
feat/research-phase
feat/script-iteration
fix/sse-token-auth
refactor/error-handling
test/content-service
prompt/title-generation
```

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
