# Channels, access and shared generation

A channel is the workspace for a creator or team: it holds its own profile, research,
ideas, scripts and publishing assets. One person can belong to several channels and
switch between them without mixing their content. The API uses `account` for this same
concept. Local implementation does not establish deployment; see
[operational readiness](./operational-readiness.md) for rollout and recovery gates.

## Joining and switching channels

A first channel is created or reused during bootstrap. Additional channels are personal
creations, independent of the person's role in the currently selected channel. Onboarding
updates the selected channel's profile and generation context. First-channel creation
still imports older user profile context, so those legacy fields cannot yet be removed
without a separate compatibility check.

Switching changes which channel the client displays and sends with subsequent requests.
It does not grant access. Each request checks current membership, and clients must discard
responses from the previous channel rather than display them in the new one. Content
belongs to its channel; the person who originally created it does not retain independent
access after leaving the team. Linked content and generation context follow the same rule.

| Role | What the person can do |
| --- | --- |
| Viewer | Read and export content. |
| Editor | Generate, select, edit and delete content; request research that consumes shared external quota. |
| Owner | Editor capabilities plus membership, ownership, billing and channel deletion. |

Invitation links are shared outside the app; the API sends no invitation email. They are
single-use, expire after seven days, and require a verified email matching the invitation.
Revoked or superseded links cannot restore a removed person's access. Public previews do
not reveal missing, deleted or frozen channels.

## A generation request

The server checks channel access, editing permission, prerequisites and available allowance
before accepting generation. Concurrent work on the same operation is controlled so a late
result cannot replace a newer one. Saved output and selections survive failed attempts.
Replacement ideas, hooks and other outputs update their related selections and links
consistently with the saved result.

Draft text and progress messages are not proof of saved content. A final success follows
saving and credit accounting. Disconnecting does not cancel accepted work: reload saved
output before starting another paid attempt. See [API communication](../api-communication.md)
for the transport contract.

Supporting metadata, such as pipeline status or thumbnail hints, can occasionally lag
behind saved content. Operators must distinguish those failures from failed generation;
retrying a paid action is not a repair strategy for supporting metadata.

## Allowances and usage

Generation draws from the channel's nominated payer, regardless of which editor starts it.
A reservation holds allowance while work is in progress; saving a generated artifact,
consuming its credits and recording channel usage happen together. Rejected delivery keeps
the previous content and accounting intact. Lock release can fail temporarily without
charging delivered work twice or leaving its saved artifact uncharged.

Allowance enforcement is optional. Missing or explicitly disabled configuration leaves
generation available; a numeric allowance of **0** enables enforcement with no paid
allowance. Invalid configuration fails closed. Monthly resets occur when needed, without
a scheduled worker. Work reserved in an earlier month stays attributed to that month.
Description, thumbnail and Short defaults cost 2/1/1 credits and are configurable.

The billing view distinguishes the payer's balance from this channel's usage. Channel-list
summaries do not provide a balance; clients use the authorized billing endpoint. This is
an allowance system, not payment processing or a purchased-credit ledger. Stateless paid
output must settle before it is returned. Free onboarding prefill has no durable artifact;
a sufficiently late receipt loss can omit its usage. Failure responses promise
`charged:false` only when that outcome has been confirmed.

## Deletion and recovery

An owner can mark a channel deleted; physical purge is a separate bounded operator action.
Removing members or transferring ownership must leave a valid owner and payer. Direct Auth
deletion is reconciled asynchronously by the separate Functions service. If the last owner
or payer disappears, the channel freezes and its content is preserved. An operator must
verify the claimant and repair ownership and billing before unfreezing it.

Use the [Functions runbook](../../functions/README.md) for guarded rollout and rollback.
A local test cannot establish provider delivery. Preserve recovery data and never restore
author-based access as a shortcut around channel permissions.

## Integration boundaries

Authenticated channel requests use `X-Account-Id`; writes require an explicit channel.
Compatible headerless reads resolve a live membership, using the last-active choice when
valid, and bootstrap only when no membership exists. Identity, discovery, bootstrap and
invitation acceptance have their own routing. The last-active pointer is a convenience,
not authorization.

`GET /v1/accounts` lists memberships and the resolved active channel;
`POST /v1/accounts/bootstrap` reuses or creates the first channel;
`POST /v1/accounts` creates an additional one. Initial script streaming accepts Bearer authentication with query-token compatibility,
derives its channel from the saved project and checks membership and editing permission. Missing project
channel information fails closed; query parameters never choose tenancy.

Clients distinguish `account_forbidden` from `role_forbidden`: a denied editing action
must not eject a valid viewer. Deleted explicit channels return Gone; frozen channels need
recovery. Direct Firestore client access is denied. Server-side credentials bypass those
rules, so every server access must enforce channel boundaries. Shared public YouTube
caching can reduce repeated fetches but never replaces channel context or authorization.
