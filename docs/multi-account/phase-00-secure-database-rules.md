---
title: "Phase 00 — Secure the Database Rules"
description: "Replace expired test-mode Firestore rules with an explicit deny-all, and bring them into the repo."
date: 2026-08-19
last_updated: 2026-08-19
status: "planned"
tags: ["multi-account", "phase-00", "security"]
---

# Phase 00 — Secure the Database Rules

**Size:** tiny — one new file, one config line, one deploy.
**Depends on:** nothing.
**Blocks:** nothing technically, but should land before any other phase.

---

## The problem in simple English

Your database is currently protected by an accident.

The rules deployed to Firestore are the ones Google generates when you create a project
in "test mode" and never replace:

```
match /{document=**} {
  allow read, write: if request.time < timestamp.date(2025, 4, 15);
}
```

That date has passed. So the condition is now false, and every direct client request is
denied. Your app is unaffected, because the Express backend talks to Firestore with the
**Admin SDK**, which bypasses rules completely.

So you are safe — but **by expiry, not by intent**. Three things make that fragile:

1. **The rules aren't in the repo.** `firebase.json` declares only
   `"firestore": { "indexes": "firestore.indexes.json" }`. There's no `"rules"` key, so
   nobody reviews them in a pull request and nobody can see what's deployed without
   opening the console.
2. **Your frontend ships a Firebase client SDK** — `initializeApp(firebaseConfig)` in
   `momentumx-fe/src/utils/firebase/config.ts` — with your project ID compiled into the
   bundle. The client *can* reach Firestore. Only the expired rule stops it.
3. **The obvious "fix" is catastrophic.** If anyone ever hits a rules error and repairs
   it by pushing the date forward, your entire database becomes readable and writable by
   anyone who reads your JavaScript bundle.

Doing this before the multi-account work matters because that work adds a `members` list
and roles. If client access is ever opened, tenancy would be decided in rules rather than
in the backend — and every permission decision in this plan would be bypassable.

---

## What we'll do

Say "no client access" explicitly, in a file that lives in the repo.

### 1. New file — `firestore.rules`

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    // All access is server-side through the Express API, which uses the Firebase
    // Admin SDK and bypasses these rules. No client — web, mobile or otherwise —
    // is permitted to read or write Firestore directly.
    //
    // If a client ever needs direct access, that is a design decision to make
    // deliberately here, not a date to push forward.
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

### 2. Change — `firebase.json`

Add the rules file next to the existing indexes entry:

```jsonc
{
  "firestore": {
    "rules": "firestore.rules",          // ← new
    "indexes": "firestore.indexes.json"
  },
  "functions": [ /* unchanged */ ]
}
```

### 3. Deploy

```bash
firebase deploy --only firestore:rules
```

Scoped deliberately. `--only firestore` would also push indexes, and index deploys are
their own careful operation (see [Phase 02](./phase-02-accounts-schema-and-indexes.md)).

---

## How we'll know it worked

- The app keeps working end to end — sign in, generate ideas, open a project. The Admin
  SDK path is untouched, so nothing should change.
- The Firebase console shows the new rules, with no expiry date anywhere.
- `firestore.rules` appears in `git log`, so future changes are reviewable.

A quick negative check, if you want certainty: from the browser console on the running
app, attempt a direct Firestore read using the client SDK. It should fail with
`permission-denied`. It would have failed before too — the point is that now it fails
*because we said so*.

---

## Rollback

Revert the file and redeploy. There is no data change and no code change; nothing to
migrate back.

---

## Risks

**Very low.** The one thing to confirm first: that nothing in the frontend reads
Firestore directly today. Searching `momentumx-fe/src` for `getFirestore`, `collection(`
or `doc(` from `firebase/firestore` should return nothing — the only Firebase imports
should be `firebase/app` and `firebase/auth`. If that search turns up a real usage, stop
and handle it before deploying, because this would break it.
