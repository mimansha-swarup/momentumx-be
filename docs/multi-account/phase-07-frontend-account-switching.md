---
title: "Phase 07 — Frontend Account State and Switching"
description: "The channel switcher, adding a channel, and per-channel onboarding. The one-way door."
date: 2026-08-19
last_updated: 2026-09-26
status: "locally accepted — deployment not performed"
tags: ["multi-account", "phase-07", "frontend"]
---

# Phase 07 — Frontend Account State and Switching

## Local acceptance — 2026-09-26

Frontend validation passes: **174 tests in 24 files**, including 19 mounted interaction
checks (15 independent lifecycle checks and four actual pipeline screens) and 11 stream
parser/status checks. Production build passes; lint has zero errors and three existing
warnings. Account bootstrap, switching, stale-response isolation, explicit generation,
viewer empty states and recovery paths are covered. This is local acceptance, not a
claim that the frontend, backend, indexes or Functions have been deployed.

See [operational readiness](./operational-readiness.md) for the consolidated acceptance
matrix and remaining deployment/data gates.


> ## Built, and where this document is now wrong
>
> Everything below is the plan as written. Four things about it did not survive
> contact with the code, and the code is the authority:
>
> 1. **"There is no test framework"** — there is. vitest, a `test` script and
>    four test files already existed. The gate cost nothing to set up.
> 2. **The identity stub is wrong here.** The plan preserves
>    `{uid, email, name, photoURL}` with `isLoading: false`. `selectIsOnboarded`
>    wants `userName`, or `niche + targetAudience`; a stub has neither, so
>    `ProtectedLayout` reads it as `!isOnboarded` and redirects an
>    already-onboarded channel into `/app/onboarding`, where `onboardedAtMount`
>    is frozen `false` and will not let go. Shipped: rebuild `user` from
>    `initialUserState` (`data: null`, `isLoading: true`) and carry only
>    `isAuthenticated`, landing on the cold-boot loader until step 5's
>    `getUser()` arrives.
> 3. **`epochOf.clear()` disables the middleware it is in.** Clearing the map on
>    switch loses every in-flight epoch, so the settle finds `undefined`, reads
>    as *not stale*, and passes straight through to a reducer. Shipped without
>    the clear; entries are bounded by their own settle.
> 4. **No `isStreaming` redux flag.** Nothing renders from it — the only reader
>    is a click handler. A 12-line module registry
>    (`src/utils/streamControl.ts`) gives the switcher both the check and the
>    teardown, with no action pair and no stuck-`true` failure mode.
>
> And one thing the plan does not mention at all, which blocks the flip:
> **the first channel used to be minted by the first header-less write.** Once
> the fallback goes read-only that write is a 400, and `listAccounts` does not
> mint. `ensureChannel` (dispatched at sign-in) now calls the idempotent
> `POST /v1/accounts/bootstrap` when the list comes back empty, then loads the
> profile with the resolved header. The account middleware exemption permits
> this initial request. Headerless profile reads still lazily create a channel;
> both paths share the transactional claim, so concurrent tabs converge on one
> channel. `POST /v1/accounts` remains the explicit add-another-channel action.

**Review fixes (2026-09-26):** requests capture their channel synchronously before
waiting for a token. A save already issued in A finishes in A after a switch;
requests from an ended authentication session are cancelled. The request epoch
protects reducers only, so async workflows also check the captured account context
before follow-up writes, navigation, or rollback. Forced ejection resets data and
streams before choosing a replacement channel; stale errors cannot eject it.
Sign-out invalidates pending results, and stream cancellation covers token lookup
and save polling. Editing a selected title synchronizes the project name within
the backend packaging save, without requiring a later client mutation.

**Size:** large — this is where users finally see the change.
**Depends on:** Phase 06b (a hard gate), which in turn depends on Phase 06a. Phase 06 should
have been running cleanly in production for a while before any of this starts.
**Blocks:** Phase 09.
**Full precondition checklist:** see the end of this document — several items are easy to
defer and expensive to skip.

> ## ⚠️ This is the one-way door
>
> The moment one user creates a second channel, **you cannot roll back**. Reverting to
> the old model would merge two channels' content into a single jumbled list, because the
> old code doesn't read `accountId`.
>
> Everything before this phase is reversible. Be deliberate about opening it, and let
> Phase 06 soak in production first.

---

## What users get

- A **channel switcher**, showing every channel they own or belong to.
- **Add a channel** — today's onboarding, pointed at a new channel.
- Data that is genuinely separate: switching channels changes every screen.

---

## The one thing most likely to go wrong

This codebase has produced the same bug three times already: **cached data from one
context showing up in another.** Hooks and scripts leaked between projects because Redux
slices were never reset. The research tab looped forever because "empty" was confused with
"not fetched yet".

At account level the same mistake shows **one channel's work under another channel's
name** — the worst possible version.

### Do not fix this slice by slice

There is no root-level reset today (`momentumx-fe/src/utils/store/index.ts`). Each slice
invented its own — `resetState`, `clearHooks`, `resetPackaging`, `clearCurrentScript` —
and `research.slice` has none at all. That approach has already failed twice; adding a
seventh hand-maintained reset will fail again the moment someone adds an eighth slice.

**Use one root reducer that wipes everything on account change.** This is the version to
ship — it typechecks against redux 5.0.1 and the two subtleties below are both load-bearing:

```ts
// src/utils/store/index.ts
const appReducer = combineReducers({
  user, account, ideas, scripts, packaging, videoProject, hooks, research,
});

// combineReducers refills every OMITTED key from that slice's initial state, so a
// slice added six months from now is wiped by default. That is the whole reason
// this lives at the root instead of in seven hand-maintained reset actions.
export const rootReducer: typeof appReducer = (state, action) => {
  if (!accountSwitched.match(action)) return appReducer(state, action);
  const id = state?.user?.data;
  return appReducer(
    {
      account: state?.account,
      user: {
        ...initialUserState,
        isLoading: false,
        data: id
          ? { uid: id.uid, email: id.email, name: id.name,
              photoURL: id.photoURL, createdAt: id.createdAt }
          : null,
      },
    },
    action
  );
};
```

Then `configureStore({ reducer: rootReducer })` — the store passes a slice map directly
today (`src/utils/store/index.ts:17-29`), so that line changes too. `initialUserState` must
be **exported** from `user.slice.ts:12`; it isn't today.

**Subtlety 1 — match on the action creator, never on a string.**

```ts
export const accountSwitched = createAction<string>("account/switched");
```

Declared with `createAction`, not inside `createSlice`, because the root reducer has to
reference it and importing the slice into the store would be a cycle. If you write
`action.type === "account/switched"` and the slice's actual action type is
`"account/switchAccount"` — which is what the obvious `createSlice` reducer produces — the
comparison never matches, **the wipe silently never happens**, and you get exactly the
cross-account bleed this whole section exists to prevent. No type error, no runtime error.
It fails *open*.

**Subtlety 2 — preserve a FIELD, not the whole `user` slice.**

An earlier draft said `{ user: state?.user, account: state?.account }`. That is wrong, and it
recreates the bug in a different place. `user.data` is not identity — it is identity
**merged with the channel**: `userName`, `niche`, `targetAudience`, `brandName`, `website`,
`websiteContent`, `channelDescription`, `userTitle`, `competitors`, `format`, `completeness`,
`stats`. Preserving the slice carries channel A's identity into channel B — the sidebar
handle (`sideDrawer/index.tsx:43,86`), the Settings form (`Settings/index.tsx:37-41`), the
stat cards (`Dashboard/index.tsx:93-95`).

Worse, `user.prefill` survives too, and `user.slice.ts:60-61` keeps it deliberately after
onboarding. `EnrichNudge.tsx:24-29` seeds its niche and audience inputs from
`prefill.suggestions` — so channel B's enrich nudge pre-fills with **channel A's inferred
niche**, and one Save writes A's identity onto B. That is the exact failure
[Phase 06b](./phase-06b-move-channel-context.md) exists to prevent, arriving through the
front door. `prefill` must be cleared on switch; the spread of `initialUserState` above does
it.

**But do not wipe the user slice entirely either.** `user` starts as
`{ data: null, isLoading: true }` (`user.slice.ts:12-13`), and `ProtectedLayout` renders a
full-screen loader while `loading && !user` (`ProtectedRoute/index.tsx:40-41`). Nothing
re-dispatches `getUser` on its own — the auth listener is a one-time subscription that does
not refire on a store reset (`useAuth.tsx:11-23`). Leaving `isLoading: true` means
**switching channels shows a permanent spinner, recoverable only by reloading the page.**
Hence `isLoading: false` above, plus the explicit `getUser()` dispatch in step 5 of the
sequence below.

### And carry the lesson about "empty"

After a switch every slice is legitimately empty. Any code that treats *empty* as
*already fetched* will refuse to load, and any code that treats it as *never fetched* will
loop. The `hasLoaded` flags added to `research.slice` are the pattern to follow — an
explicit "have we asked?" separate from "did we get anything?".

---

## Switching safely

Switching isn't just "change the header and refetch". Work may be in flight:

- Packaging auto-saves on every edit and every thumbnail click.
- A script stream runs 60–120 seconds.

If a switch happens mid-flight, a write issued under channel A can land after the switch.

### Don't abort. Drop stale settles.

An earlier draft said "abort in-flight requests with `AbortController`". Two problems: there
is **no `AbortController` anywhere in this codebase** (grep `src/` for `signal|abort` — zero
hits in any service or thunk), so it means threading a signal through ~40 service methods;
and **aborting does not un-send a request already in flight**, which is the actual bleed
vector. It buys nothing the cheaper option doesn't.

One middleware, ~15 lines, no changes to services, thunks or call sites:

```ts
// src/utils/store/accountEpoch.ts
// Every createAsyncThunk stamps meta.requestId and dispatches /pending synchronously
// at call time — i.e. under the OLD account. Record the epoch there, compare on
// settle, drop anything from a previous epoch before it reaches a reducer.
const epochOf = new Map<string, number>();
let epoch = 0;

export const accountEpochMiddleware: Middleware = () => (next) => (action) => {
  if (accountSwitched.match(action)) { epoch++; epochOf.clear(); }
  const { type, meta } = action as { type: string; meta?: { requestId?: string } };
  const id = meta?.requestId;
  if (id) {
    if (type.endsWith("/pending")) epochOf.set(id, epoch);
    else {
      const at = epochOf.get(id);
      epochOf.delete(id);
      if (at !== undefined && at !== epoch) return;   // stale reply — never reaches a reducer
    }
  }
  return next(action);
};
```

This also deletes the whole cancellation-error problem. A request that completes normally
never enters a catch block, so there is no `ERR_CANCELED`, no `"Unknown error"` from
`state.error = action.payload ?? "Unknown error"` (`script.slice.ts:62,76,99,113,143`), and
no red toast from `packaging.thunk.ts:144` — which hardcodes
`toastError("Couldn't save your changes")` and never calls `getErrorMessage` at all
(same at `:25`).

**Costs, stated plainly:** the request still finishes and burns bandwidth, and a mutation
already in flight still lands server-side — unavoidable under either strategy. And RTK
resolves the thunk promise from its own return value regardless of middleware, so a component
doing `await dispatch(x)` then `navigate(...)` can still fire a stray navigate into a
channel-A project URL. `ProjectHooks/index.tsx:155-158` is the one that matters;
`ProjectPipelineLayout.tsx` catches it as an error screen — degraded, but not silent.

**The `EventSource` genuinely must be closed.** It holds a connection for up to 180 s and its
callbacks dispatch. It has no external stop today (`useScriptStream.tsx:15-21` returns no
`stop`), and the switcher lives in `SideDrawer` under `RootLayout` — a sibling of the page —
so it cannot see the component-local `isStreaming`. Two additions:

- `script.slice`: an `isStreaming` boolean with `streamStarted` / `streamEnded` actions.
  This is the **only** global "a generation is running" signal, and step 1 below needs it.
  `streamEnded` must also fire from the unmount cleanup, or navigating away mid-stream
  leaves the flag stuck `true` and blocks every future switch.
- `useScriptStream`: return a `stopStreaming()` that closes the source, clears the
  save-poll timeout (`useScriptStream.tsx:139`), and dispatches `streamEnded`.

**The sequence.** All six steps run synchronously in one handler — React batches the router
update and the store update into one re-render, so there is no intermediate frame where a
mounted screen sees a wiped store. Do not `await` anything inside it.

1. **Block if a stream is running.** `selectIsStreaming` → confirm: *"Your script is still
   generating. Switching will cancel it."* Nothing else needs blocking; the epoch middleware
   covers every other in-flight request.
2. **`stopStreaming()`** — the only real abort.
3. **Persist first, synchronously.** `setActiveAccountId(id)` writes the module-level
   variable in `network.ts` **and** `localStorage`, both synchronous, before any request can
   go out. Then fire `POST /v1/accounts/:id/activate` **fire-and-forget** — the client is the
   source of truth for the active account; the server copy only decides where a *new tab*
   lands. Awaiting it would split the sequence across ticks and reopen the
   intermediate-render window. Wiping before persisting means the next request carries no
   header, the server falls back to the *old* `lastActiveAccountId`, and channel A's data
   loads into channel B's UI — the mitigation causing the bug it exists to prevent.
4. **`dispatch(accountSwitched(id))`** — bumps the epoch and runs the root reducer wipe.
5. **`dispatch(getUser())` and `dispatch(getAccounts())`** — required, not optional. Step 4
   deliberately left `user.data` as a four-field identity stub, and nothing re-dispatches
   `getUser` on its own.
6. **Navigate last.** `localRouter.navigate(dest, { replace: true })` — `localRouter` is a
   module-scoped export (`constants/route.tsx:20`), so this works from a thunk, which the
   403 interceptor also needs. `dest` defaults to the dashboard but **may be supplied by the
   caller** — the `wrong_account` screen (Phase 05) passes the project URL the user was
   trying to open, so a one-click switch lands them where they meant to go.

### Keying is what actually resets the UI — not the navigate

`navigate("/app/dashboard")` is a **no-op when the user is already on the dashboard**, which
is the common case and where step 6 sends everyone. Nothing unmounts. Apply the key to
**both** branches of `ProtectedLayout`:

```tsx
if (onOnboarding) return <Outlet key={activeAccountId} />;          // ProtectedRoute/index.tsx:56
return <RootLayout><Outlet key={activeAccountId} /></RootLayout>;   // :65-69
```

Both are required:

- **The `RootLayout` branch.** `ProjectList.tsx:40-53` keys its fetch effect on
  `[dispatch, statusFilter]` — neither changes on a wipe, so it never refetches, and its
  local `statusFilter` plus `prevFilter` ref carry channel A's filter tab into channel B. It
  also un-sticks `ProjectPipelineLayout.tsx:33,37`'s `fetchedForIdRef`, which otherwise
  early-returns forever on a cleared store. (`Dashboard/index.tsx:33-35` *does* self-heal via
  `hasLoaded` — that is the pattern working, and why the two behave differently.)
- **The onboarding branch**, which is the new-channel escape hatch. Switching *out of* a
  half-configured channel B while on `/app/onboarding` does not change the route, so
  `Onboarding` never unmounts and keeps `phase`, `channelUrl`, `niche`, `brandName`,
  `topTitlesRef` — and fatally `onboardedAtMount = useRef(isOnboarded).current`
  (`Onboarding/index.tsx:89`), frozen at `false`, so the gate at `:102` will not redirect you
  out of channel B's half-filled form.

This does **not** violate the constraint below about the onboarding route's stable element
type. The element *type* is unchanged; only the key differs. Completing onboarding within one
account still does not remount.

### Storage

Use `localStorage`, **not** the `localforage` dependency — `localforage` is async, which
opens a boot window where requests go out with no header and silently hit Phase 05's
fallback. There is no persistence of any kind in `src/` today (grep: zero hits for
`localStorage|sessionStorage|localforage`), so this is net-new.

**Namespace the key by Firebase uid** (`mx.activeAccount.<uid>`), or a second user signing in
on a shared browser inherits the previous user's active account and eats a 403 on first paint.

---

## Sending the header

`baseFetch` (`momentumx-fe/src/utils/network.ts`) already has a request interceptor that
attaches the Firebase token. Add `X-Account-Id` there — one change, every call covered.

**Don't read it from the store.** `network.ts` is imported by the services, which are
imported by the thunks, which are imported by the slices — importing the store back into
`network.ts` is a require cycle. Hold the active id in a module-level variable with a setter
called by the switch, hydrated from storage at boot. It also survives the state wipe, which
a store value would not.

**The SSE stream is the exception again.** `EventSource` can't send headers, so it doesn't
need this: Phase 05 has the server derive the account from the project id in the URL.

**And it goes to a different host.** `network.ts:6` — `getApiDomain(true)` returns
`https://momentumx-be.onrender.com`, used by `service/script.ts:36` (the stream) and
`ProtectedRoute/index.tsx:24` (the health poll). Everything else uses
`momentumx-be.vercel.app` (`network.ts:10,22`). See the deploy table in the README: both
hosts must ship the same commit, and Phase 05's `X-Account-Id` CORS change has to be applied
on both.

---

## The Render cold start is a live bug, and this phase makes it worse

Not caused by multi-account — but Phase 07 makes "open a project" a routine cross-channel
action, and Phase 08 attaches a price to it, so it has to be fixed here.

**What happens today.** A sleeping Render instance refuses or hangs the connection.
`momentumx-fe/src/service/script.ts:61-64` is:

```ts
evtSource.onerror = () => {
  evtSource.close();
  onError();
};
```

`close()` fires **before the browser's native EventSource reconnect**, so the first
connection failure is terminal — there is no retry. And `consecutiveErrors`
(`momentumx-fe/src/service/script.ts:39,50-57`, tolerance 10) only counts `JSON.parse`
failures on *frames that
arrived*; a connection that never delivers a frame never touches it.

So: `onError` → `streamError` (`useScriptStream.tsx:62-64`) → `ProjectScript/index.tsx:141-163`
renders destructive-red **"Script streaming failed. Please try again."** about one second
after arrival. Retry calls `startStreaming()` again against a still-waking instance and fails
identically. Repeat for ~45 seconds.

**The keep-alive does not cover it.** `HEALTH_CHECK_INTERVAL_MS = 13 * 60 * 1000`
(`constants/app.ts:6`) runs in an effect with `[]` deps (`ProtectedRoute/index.tsx:22-34`), so
it only ticks while a protected route is mounted in a live tab. Close the tab overnight and
the timer is gone while Render spins down after ~15 minutes. On return the ping fires
immediately — but it is `fetch(...).catch(() => {})`, fire-and-forget, and it is **racing the
auto-start and losing.** Measured 2026-08-24: no response within 45 s, against 4 s on Vercel.

**Two fixes, both small:**

1. **Distinguish "waking" from "failed" by whether any byte arrived.** If `onError` fires
   with no content yet and elapsed < 60 s, do not go to the error state — reconnect with
   backoff (3 s, 6 s, 12 s, 20 s) and render *"Warming up — the first script after a quiet
   spell takes about 45 seconds to start."* Only after the budget is exhausted, or on an
   error *after* content started, fall through to the existing red state. **Cap the
   retries** — an unbounded reconnect is how you get a silent quota drain.
2. **Gate auto-start on a warm server.** Make the health ping resolve into state
   (`isBackendWarm`) instead of `.catch(() => {})`. That turns the race into a sequence for
   one boolean. (This becomes moot once generate-on-mount is removed per Phase 08 — but the
   *manual* generate button has the same cold-start window, so fix 1 stands either way.)

Under Phase 08: **a stream that never delivered a byte must not be charged**, and a
connection-phase failure must refund.

---

## Adding a channel

Reuse the onboarding flow, pointed at a new account instead of the user profile.

**The trap:** the onboarding gate currently reads the user record
(`selectIsOnboarded` in `user.slice.ts`) and `ProtectedLayout` renders onboarding **bare,
without the app shell**. If the switcher lives in the sidebar, then adding channel B sends
you to B's onboarding — with no switcher on screen, and no way back to channel A. Stuck.

**Decision:** new-channel onboarding takes over fullscreen like today's first run, **plus
an explicit "back to my other channel" control.** That control is not optional; it's the
only exit.

The gate itself moves from the user record to the active account: "does this channel have
a URL, or a niche and audience?"

Note `ProtectedLayout` was recently changed so the onboarding route always renders the same
element type, avoiding a remount that destroyed page state mid-flow. Preserve that
property — it is load-bearing, and the bug it fixed was subtle.

---

## Smaller things that need doing

- **The error `code` has to be readable, or Phase 05's contract is decoration.**
  `utils/error.ts:6-15` returns only `response.data.message` as a string, and every screen
  renders that string raw. `network.ts:49-59` branches on `status === 401` and nothing else.
  So `account_forbidden` / `wrong_account` / `role_forbidden` / `insufficient_credits` arrive
  in the browser and are discarded before any component sees them. Add `code` to
  `IBaseFetchResponse` (`network.ts:14-20`), return `{ message, code }` from
  `getErrorMessage`, and route on it in the response interceptor.
- **A 403 needs a real screen**, and it now means three different things. The interceptor
  owns `account_forbidden` (clear the account, go to the channel list) and `wrong_account`
  (the one-click switch screen from Phase 05). `role_forbidden` and `insufficient_credits`
  belong to the page and must **not** eject. Follow the shape of the existing 401 handler
  (`network.ts:52-57`): fire-and-forget, always re-reject.
- **`account_forbidden` must beat the local error path when they race.** After removal
  mid-stream, `useScriptStream.tsx:98-113` polls `getProject` until `scriptId` lands; those
  polls 403, the poll exhausts its attempts and sets `streamError`, and the user is told
  *"Script streaming failed"* about a script that saved fine. The global handler
  short-circuits: abort the poll, and say *"You no longer have access to {channel}. Your
  script was saved there."*
- **The profile response changes.** `getProfile` currently returns the channel fields plus
  a completeness score computed from them. All eight scored fields in `src/utlils/profile.ts`
  are channel fields, so once they live on the account that score is computed over an
  identity-only record and reports zero for everyone. Move the calculation to the account.

---

## Precondition checklist — acceptance items, not prose

The one-way door is in the right place. It has historically been under-gated because these
were written as recommendations. They are checklist items.

1. ~~**Phase 03 confirmed live on all three deploy artifacts** *before Phase 04 ran*.~~
   **VOID — there is no Phase 04.** Replaced by: Phases 03/05/06/06a/06b are live on
   **Vercel and Render together**. Phase 06 flips reads, so a one-host deploy has Vercel
   querying `accountId` while Render still serves the SSE route from the old build.
2. ~~**Phase 04 verified:** `migrations/{collection}.completedAt` present for each…~~
   **VOID — Phase 04 was dropped**, its script and 33 tests deleted, and
   `COLLECTIONS.MIGRATIONS` removed from the enum. No `migrations` document can ever
   exist, so this item could only ever be signed off by ignoring it. Replaced by:
   **the six content collections have been wiped**, which is what the dropped backfill
   was traded for — Phase 06 makes any untagged record invisible.
3. ~~**Phase 06 cross-account suite green**, including the **non-uid-keyed fixture
   account**.~~ The suite must be green; the *fixture* is **VOID**. README decision 2 and
   `phase-06` both retired it — account ids are UUID v4, so the id spaces are disjoint by
   construction and the fixture proves nothing. `tests/unit/cross-account.behaviour.test.ts`
   does not have one and does not need one. Do not block the door on it.
4. **Phase 05a landed and soaked** — packaging keyed on `videoProjectId`,
   `findByVideoProject` gone.
5. **Phase 06a shipped** — create a channel, list channels, persist `lastActiveAccountId`.
6. **Phase 06b run end to end for real** — one user, two channels, unrelated niches, all
   five generation paths, plus the "edit niche in B, regenerate, new niche used" write
   check. Its step-4 reverse re-sync script written and tested.
7. **Frontend test framework exists**, carrying at minimum test 1 below: `accountSwitched`
   wipes every slice except identity and the account, and a **newly added** slice is wiped
   by default.
8. **Generate-on-mount removed from all four pipeline screens** —
   `momentumx-fe/src/pages/ProjectScript/index.tsx:93-98`, `ProjectHooks/index.tsx:143-150`,
   `ProjectTitles/index.tsx:76-84`, `ProjectPackaging/index.tsx:150-162`.

   **This phase owns the removal**, and owns the replacement with it — deleting the effects
   without arming generation somewhere else leaves no way to generate at all. Phase 08 and
   Phase 09 both depend on this being done and neither does it.

   Why it belongs here and not later: after a switch, a mounted pipeline screen auto-fires
   generation against the **new** account. That is not a stale response the epoch middleware
   can drop — it is a persisted document in the wrong channel. Phase 08 and 09 turn the same
   defect into a charge on navigation and a viewer stuck in a 403-with-Retry loop, but those
   are symptoms of this one. It is also the only item here touching all four screens, so it
   is the most likely to be deferred and the most expensive to skip.

   **The replacement.** Delete the four `autoStartedRef` effects. The forward CTA navigates
   *and* arms the next step:

   ```ts
   navigate(`/app/project/${projectId}/hooks`, { state: { run: true } });
   ```

   The step page generates if and only if `location.state?.run === true`, then clears it
   (`navigate(pathname, { replace: true, state: {} })`) so refresh and Back never re-fire.
   Arriving any other way — dashboard card, deep link, sidebar,
   `ProjectDetailRedirect.tsx:26-33` — never generates. `ProjectScript` has no empty state
   today (it went straight from mount to streaming); it needs one matching the other three.

   There is a quota argument for doing this early that the credits phase doesn't make: every
   project open currently re-runs generation, and the research paths burn `search.list` at
   100 units each against 10,000/day project-wide. This item and item 10 are the same
   pressure seen twice.
9. **`network.ts` handles 403**, distinguishing `account_forbidden` from `wrong_account`
   from `role_forbidden` — which requires Phase 05's `code` field to exist end to end.
10. **YouTube quota headroom**: channel-enrichment caching keyed on `channelId`, or a
    granted quota increase. Phase 07 turns "add a channel" (≈101 × (1 + competitors) units
    against 10,000/day project-wide) into a routine action, and niche-level caching does not
    help that path.

---

## How we'll know it worked

- Create a second channel; generate an idea in it; switch back. **Channel A's list must
  not contain it.**
- Switch channels with the packaging screen open mid-auto-save; confirm nothing from A
  lands in B.
- Reload after a switch: you're still in the same channel.
- Open a project in A, switch to B: you land on B's dashboard, not a broken project page.
- Open a bookmarked project belonging to channel A while in channel B: you get the
  `wrong_account` screen and a one-click switch, **not** "may have been deleted".
- Add a channel, then leave without finishing setup — confirm you can get back to A, and
  that a cold boot tomorrow does not drop you back into the half-configured one.
- Switch channels while on `/app/onboarding` for a half-configured channel: the form is
  gone, not carried across.

### The minimum test framework — gate on one test

There is none today: no vitest, no jest, no `*.test.*`, and `package.json` has no test
script. Setup is `vitest + @testing-library/react + jsdom`, about six lines in
`vite.config.ts` since Vite is already there.

**Gate this phase on test 1. Ship 2 and 3 after.**

1. **Root reducer + epoch middleware** (pure, no DOM, ~60 lines). Populate every slice,
   dispatch `accountSwitched`, assert: every data slice equals initial state; `user.data`
   has exactly the five identity keys and no `niche`/`userName`/`stats`; `user.prefill` is
   null; `user.isLoading` is false; `account.activeId` is the new id. Then dispatch a
   fabricated `packaging/save/fulfilled` carrying a pre-switch `requestId` and assert
   `packagingId` stays null.

   **This is the gate**, because it is the only cheap way to catch the two failure modes that
   are invisible until a second channel exists **and that both fail open**: a wipe that
   silently never fires because the action type drifted, and a late reply landing in a fresh
   store. Everything else in this phase fails loudly and manual testing finds it.
2. Header interceptor — invoke the request interceptor directly, assert `X-Account-Id`. ~20 lines.
3. Switch-while-on-dashboard in jsdom — assert `listProjects` re-dispatches and the filter
   tab resets. ~70 lines.

Roughly an hour for test 1 including config. Refusing to spend it on the one-way door is the
wrong trade.

---

## Rollback

**Not available once a second channel exists.** Before that point, revert the frontend and
the backend keeps working (it tolerates a missing header).

---

## Risks

**Cross-account bleed** — mitigated by the root reducer, not by discipline. Note that the
two ways it can fail (a drifted action type, a preserved `user` slice) both fail *open* and
silently, which is why test 1 is the gate.

**Getting stuck in a half-configured channel** — mitigated by the mandatory escape control,
and by not writing `lastActiveAccountId` until the account clears the onboarding gate.
Without that second half, tomorrow's cold boot hydrates the abandoned channel from storage
and drops the user back into its onboarding, every session. Give the escape control a
sibling: **"Discard this channel"** — otherwise the only way to delete it lives inside a
channel you cannot enter without finishing its setup.

**In-flight writes crossing the switch** — mitigated by the epoch middleware, not by
aborting. Aborting cannot un-send a request; the middleware stops the reply from reaching a
reducer.

**No automated safety net.** The highest-risk phase in the plan lands on the codebase with
the least test coverage. One test closes the worst of it; see above.
