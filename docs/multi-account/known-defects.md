---
title: Known defects — recorded, not migration-blocking
status: "open"
date: 2026-08-24
last_updated: 2026-08-25
---

# Known defects

Bugs found while reviewing the multi-account plan that are **not** part of it.

They are recorded here rather than filed into a phase because they fail Phase 01's own
entry criterion — *"bugs that are harmless with one user per channel and become real the
moment there are two, or the moment a migration script walks the whole database."* These do
not get worse under multi-account. Filing them into migration phases would inflate the
critical path with work that has no deadline attached to it.

**This list does not fix itself.** Nothing schedules these; each entry names the trigger
that should. An entry with no trigger is a defect nobody will fix, and should either get
one or be deleted.

**Open items only.** Fixed entries are deleted from this file rather than moved to a
"done" table — the code and its tests are the record, and git has the history. A defect
list that also tracks completed work stops being a to-do list and becomes an archive
nobody reads to the bottom of. Anything a phase owns lives in that phase doc, not here.

## Scope

| Section | Covers |
|---|---|
| Backend (`momentumx-be`) | **None open.** |
| §2–§10 | **Frontend** (`momentumx-fe`) — open |

Both repos are audited. Sections are labelled because the two deploy separately, and a
backend-only list would have read as a clean bill of health for a frontend nobody had
looked at. Numbering is original and deliberately not re-flowed: §1 was fixed and removed,
and renumbering would break every reference written against the audit.

**Reachability matters more than severity here.** Several entries are unreachable from the
current UI — the control that would trigger them has not been built. Those are not "bugs to
fix later"; they are traps waiting for whoever builds that control, and the useful place for
the warning is the code they will be reading, not this file.

---

## Deferred into the migration plan — do not double-file

Real, but owned by a phase rather than this list:

| Defect | Where it landed |
|---|---|
| `reconcileView` divergence between `list` and `getById`, and the broken `?status=` filter | [Phase 01b](./phase-01b-generation-seam.md), problem 2 |
| `completeStep` can move `currentStep` backward | [Phase 01b](./phase-01b-generation-seam.md), problem 2 |
| `reopenTitleStep` / `clearSelectedHook` never recompute `overallStatus` | [Phase 01b](./phase-01b-generation-seam.md), problem 2 |

---

# Frontend (`momentumx-fe`)

Audited 2026-08-24. Every entry below is **open** — one FE fix has shipped (§1, the logout
Redux leak, now removed from this file). Each entry was confirmed against source; anything
the audit could not confirm is marked as such.

Ordered by consequence, not by file.

---

## 2. A failed profile fetch logs the user out of the app

> **Trigger: now.** No feature depends on it; it is a bad failure mode on a live path.

**HIGH — live today.**

`getUser.rejected` leaves `data: null` (`user.slice.ts:40-43`), and `ProtectedRoute:42-44`
reads `!user` as *unauthenticated* and navigates to `/login`. The Firebase session is still
valid, so the user sees a login screen with no explanation, and `onAuthStateChanged` will not
re-fire on its own. There is no retry anywhere.

Related, same root cause — "no profile" and "not signed in" are the same state:

- **`getUser` can resurrect a signed-out user** (`user.thunk.ts:20-21`). A logout racing an
  in-flight `getUser` re-populates `user.data`; `Login/index.tsx:16-17` sees a truthy user and
  navigates to the dashboard with no Firebase session. Every request 401s → signs out →
  redirects. The login button appears broken.
- **A successfully-onboarded user can be trapped** (`user.thunk.ts:74`). `completeOnboarding`
  fulfils even when its inner `getUser()` rejects, so `selectIsOnboarded` stays false and
  `ProtectedRoute:61-63` bounces every attempt to reach the dashboard. The profile *is* saved
  server-side. Only a reload recovers.

**Fix:** distinguish "profile fetch failed" from "not authenticated" — they are not the same
state and must not share `data === null`.

---

## 3. Packaging edits are silently destroyed on navigation after a failed save

> **Trigger: now.** Data loss, and the recovery affordance actively lies.

**HIGH — live today.**

`usePackagingDoc.ts:63-67` dispatches `resetPackaging()` (`() => initialState`) on unmount.
If a save failed, the edited text exists **only** in Redux. `SaveStatus.tsx:46-54` offers
Retry, and its own comment explains the premise — *"the edit still lives in Redux, so retry
just re-saves"* — which is void the moment the user leaves the screen. Unmount wipes the text
*and* the `saveError`.

Symptom: edit a description, the save fails, a toast flashes, the user clicks to the Title
tab and back — the edit is gone with no trace. There is no `beforeunload` guard on either
screen.

Related: `titles.isEdited` is never cleared on a successful save
(`packaging.slice.ts:225-229`), and `hydrateFromResponse:108` gates on it — so one title edit
freezes titles against server refresh for the rest of the mount.

---

## 4. Regenerate-All leaves the user acting on deleted ideas

> **Trigger: now.**

**HIGH — live today.**

The backend archives the batch *before* generating (`content.service.ts:415-417`). On the
frontend, `regenerateAllIdeas.rejected` leaves `state.data` untouched
(`ideas.slice.ts:136-139`) — so an error banner renders above a grid of ideas that no longer
exist server-side. "Use Idea" on those cards acts on an archived document; a reload shows an
empty list.

Same shape on a timeout: `network.ts:28` caps at 150s, and archive + 10 generations +
embeddings can exceed that while the backend succeeds. The user then clicks Regenerate All
again and regenerates a second time.

---

## 5. Streaming failures are unreadable, and a completed script can be thrown away

> **Trigger: now for the discard; the reconnect question needs a backend decision.**

**HIGH — live today.**

- **A fully-streamed script is discarded on save-poll exhaustion.** `useScriptStream.tsx:98-113`
  sets `streamError` after the poll gives up, and `ProjectScript/index.tsx:138,141` renders the
  error branch *before* the streaming branch — while `streamContent` still holds the complete
  text. The user watches a script stream in, then sees it replaced by "Script streaming failed"
  with no copy, no export, no fallback. Retry regenerates from scratch.
- **Every failure reads the same.** `onError` takes no argument (`script.ts:61-64`), so a 403,
  a 409 lock and a Wi-Fi drop all render "Script streaming failed." The backend's real message
  — including *"Script generation already in progress"* — exists and is unreachable, because
  EventSource never exposes the body.
- **Retry re-fires the same failing call, unbounded** (`ProjectScript:150-158`, and the same
  pattern on the other three screens). In the 409 window every click is a guaranteed failure,
  for up to three minutes.

**Correction to an earlier reading of this file:** `evtSource.close()` inside `onerror`
(`script.ts:61-64`) is **not** the critical bug it was described as. Per spec, EventSource does
not reconnect on an HTTP error status at all, so `close()` is a no-op for the 403/409/404
cases. It only changes a mid-stream transport drop — and removing it naively would send the
client into a 3-second-interval reconnect loop against the step lock, i.e. a 3-minute 409
storm. The real gap is that there is **no retry and no backoff anywhere**, which is a design
decision needing a backend resume contract, not a one-line fix.

---

## 6. Refresh mid-generation re-fires generation into a 409

> **Trigger: superseded by Phase 07 checklist item 8** (generate-on-mount removal), which
> deletes this path entirely. Listed so it isn't rediscovered as a separate bug.

**HIGH — live today.**

`ProjectScript/index.tsx:93-98` guards auto-start with `hasScript` (`!!project.scriptId`) and a
per-mount ref. Two live paths where `scriptId` is legitimately still null while generation is
in flight — a refresh, and Script → Hooks → Back — re-trigger generation into the backend's
in-flight lock, producing a 409, the generic error of §8, and the retry loop. Meanwhile the
script *is* being saved server-side, so the user is told it failed while it succeeded.

`ProjectHooks:143-150` and `ProjectTitles:76-84` get this right by keying on a
**server-persisted id**. `ProjectScript` and `ProjectPackaging` do not.

---

## 7. Onboarding: the "no channel URL" escape hatch guarantees a 400

> **Trigger: now.** One line.

**HIGH — live today.**

`Onboarding/index.tsx:353-360` switches to the manual path but never clears `channelUrl`, and
`handleGenerate:152` still sends it. The frontend's pre-check (`:69`) is looser than the
backend's `youtubeChannelUrl` regex, so a user who typed a *video* URL, gave up, took the
opt-out and filled in niche + audience gets a 400 naming `userName` — **a field no longer on
screen**. Nothing saves, and the button repeats the failure.

The same file already does the right thing on the prefill-failed path (`:114-121` clears
`channelUrl`); the opt-out was missed.

Related, lower severity: a blank prefill (backend returns 200 with empty strings) lands the
user on "Here's what we found" over three empty boxes with a disabled button and **no back
control** (`:246-267`); and a background `refreshContext` failure paints a red error over the
onboarding success screen, because `silent` suppresses the toast but not the shared
`user.error` (`user.thunk.ts:78`, `user.slice.ts:89-91`).

---

## 8. The Dashboard shows a credit balance that does not exist

> **Trigger: now — delete the tile, or ship Phase 08.**

**HIGH (trust) — live today.**

`Dashboard/index.tsx:95` renders `stats?.credits?.toString() ?? "FREE"`. No backend code
reads, decrements or checks `credits` anywhere. It is a constant sitting in a numeric stat
tile between two real counters, and on the day Phase 08 ships it will read "FREE" while every
generation returns `insufficient_credits`.

Two neighbours in the same row are also misleading: `stats.ideas` is a **lifetime** counter
that never decrements on archive, so after one regenerate-all the dashboard says 20 while the
ideas page shows 10; and stats never refresh in-session — `getUser` only runs on auth-state
change, so generating anything leaves the numbers stale until a reload.

---

## 9. Smaller confirmed items

Each verified, none urgent. Grouped to keep the list readable.

| Item | Where | Consequence |
|---|---|---|
| Script edit never lands in Redux | BE returns `scriptId`, FE matches on `payload.id` (`script.slice.ts:89,92`) | Editor closes showing pre-edit text until a refetch |
| Competitor "channelTitle" is a URL | `research.service.ts:41-42` | Competitors panel lists raw `youtube.com/@handle` where a name belongs |
| Trending falls back to a hardcoded niche | `research.service.ts:24` → `"AI and technology"` | A URL-only-onboarded creator sees someone else's niche as *their* research, unlabelled |
| `getIdToken()` unguarded | `network.ts:34` | On a network blip the user is shown `"Firebase: Error (auth/network-request-failed)"` as if the API said it |
| `user.error` has no clear path | no `clearError` reducer; `pending` doesn't reset it | One transient failure pins a red banner on Settings and Onboarding for the session |
| One 401 destroys the session | `network.ts:49-59`, no refresh-and-retry | Unsaved packaging edits are lost |
| `/app` exact renders a blank shell | `route.tsx:23-118` has no `index` route | Sidebar with an empty page |
| Unknown `/app/*` deep links land on marketing | `route.tsx:119` catch-all | A signed-in user mistyping a project URL gets the landing page |
| No `errorElement` outside the project route | `route.tsx:62` only | A stale lazy chunk after a deploy white-screens |
| SSE token expires and cannot refresh | `script.ts:29-37`, token baked into the URL | After ~1h every reconnect carries a dead token |
| Packaging empty state swallows generation errors | `ProjectPackaging:289-315` reads the shared bucket, not the per-item ones | Auto-generation fails and the user sees a cheerful "Generate Your Packaging" |
| `ProjectScript` has no empty state | `:233` `return null` | Header, tracker, then nothing — and no Generate button |
| Concurrent single-idea regenerates corrupt the spinner | `IdeaCard.tsx:79,100`; `Research:175,106-110` | Spinner jumps to the wrong card, then vanishes while a request is still running |
| `selectActiveIdeas` dereferences `lists` unguarded | `ideas.slice.ts:194-198` | Latent white-screen; its sibling one line below does it correctly |
| Accessibility basics | `IdeaCard.tsx:76-93` no `aria-busy`/`aria-live`; `Research:356-374` `role="tablist"` with no arrow-key handling; `button.tsx:8` `disabled:pointer-events-none` kills tooltips | Screen-reader users get no signal that an action started or finished; a disabled control can never explain why |

---

## 10. Frontend dead plumbing — do not mistake for features

Confirmed present in types/state and wired to nothing. Relevant because two of them pair with
backend defects above, and because building the UI without fixing the backend ships a broken
feature on day one.

- `searchText` and `isScriptGenerated` (`service/ideas.ts:13-14`, `ideas.slice.ts:17-18`,
  `updateFilter` exported and never dispatched) — **there is no search input and no
  script-generated filter in the UI.** The backend side is ready: the search cursor and the
  three-state `isScriptGenerated` parse were both fixed and are covered by tests, so building
  the controls is now purely FE work.
- `linkResource` thunk — defined, never dispatched from any page or component.
- `recommendedNextStep` — the backend computes it on every project read; the frontend re-derives
  the guided CTA client-side instead.
- `selectCompleteness` — backend returns it on every profile read; consumed nowhere outside
  Settings.
- `EnrichNudge` dismissal is `useState` (`:26`), so it returns on every visit forever; its
  "pre-filled from prefill" promise (`:27-30`) is false after any reload, since `prefill` is
  memory-only.
