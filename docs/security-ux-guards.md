# Security & UX Guards

This document describes the security and UX guardrails enforced across the Mux
frontend. It is the canonical reference for contributors working on privileged
surfaces (wallets, account abstraction, payments, activity feeds, notification
preferences).

## Principles

- **Server/contract is the source of truth.** The frontend never decides spends,
  recovery, or admin actions on its own; it only reflects and requests them.
- **Deny by default.** New privileged surfaces must explicitly authorize every
  caller before returning data or performing a write.
- **Fail closed on writes.** If a dependency (RPC, DB, Horizon) is unavailable,
  write paths must reject rather than silently succeed.
- **No secrets in the repo or logs.** Redact keys, JWTs, and webhook secrets.

## Error boundary behaviors

Error boundaries are the last line of defense between a failed privileged
operation and the user. They must **fail closed**: a boundary never converts a
failed or unauthorized operation into an apparent success, and it never exposes
raw error internals, key material, or tokens. This section is the canonical
contract for wallet, account-abstraction, and payment error boundaries.

### Typed entrypoints and stable error codes

Every privileged entrypoint (wallet, AA, payment) is wrapped by a boundary that
returns a discriminated result. Callers branch on the error code, never on
message text. Stable error codes:

| Code | Meaning |
| --- | --- |
| `BOUNDARY_OK` | Operation succeeded; result returned. |
| `BOUNDARY_FORBIDDEN` | Caller is not authorized for the requested scope. |
| `BOUNDARY_AUTH_EXPIRED` | Session/JWT expired; re-auth required. |
| `BOUNDARY_DELEGATE_REVOKED` | Delegate/guardian grant was revoked. |
| `BOUNDARY_INVALID_INPUT` | Input failed validation (unknown key, bad shape). |
| `BOUNDARY_DEPENDENCY_UNAVAILABLE` | RPC/DB/Horizon unavailable; fail closed. |
| `BOUNDARY_RATE_LIMITED` | Too many requests; retry later. |
| `BOUNDARY_UNEXPECTED` | Unclassified failure; treated as failure, never success. |

Every boundary result carries a correlation id propagated to logs and the
user-facing error surface so support can trace a single request. The
correlation id is opaque and never encodes secrets.

### Fail-closed on writes

- Write paths (spends, recovery, admin) reject with
  `BOUNDARY_DEPENDENCY_UNAVAILABLE` when RPC/DB/Horizon is unavailable. They
  never fall back to a cached or optimistic success.
- A boundary that cannot classify an error returns `BOUNDARY_UNEXPECTED` and
  keeps the operation failed; unknown errors are never mapped to success.
- Reads may retry idempotently; writes require an explicit idempotency key so a
  retried request cannot double-spend or double-apply.

### Authorization

- Reads and writes require an authorized owner/delegate/guardian session or a
  scoped API-key/JWT. The server resolves the caller's permitted scope; the
  client cannot request a broader scope than it holds.
- An expired session fails closed with `BOUNDARY_AUTH_EXPIRED`; a revoked
  delegate fails closed with `BOUNDARY_DELEGATE_REVOKED`; a wrong role fails
  closed with `BOUNDARY_FORBIDDEN`. The boundary never substitutes a cached
  result for a failed authorization check.
- Deny by default: a new privileged surface is unauthorized until the server
grants it, so adding a surface cannot leak a previously hidden capability.

### Edge cases and failure modes

- **Concurrent/replayed requests:** writes carry an idempotency key; a replayed
  request returns the original outcome rather than re-applying the effect.
- **Dependency outage:** RPC/DB/Horizon outage fails closed on writes; no silent
  success that could mask a missing spend or recovery.
- **Auth expiry / wrong role / revoked delegate:** fail closed and prompt
  re-auth; the boundary is never used to escalate scope.
- **Adversarial input:** oversized payloads, unknown keys, and malformed shapes
  are rejected with `BOUNDARY_INVALID_INPUT` before any privileged call; entry
  points are rate-limited per session and per IP to prevent griefing.
- **Testnet vs mainnet:** the network is explicit and validated; a mainnet
  operation is never satisfied by testnet state and vice versa.

### Observability

- Emit structured logs with the correlation id, the resolved error code, and
  the operation name (never raw key material, JWTs, webhook secrets, or full
  request bodies).
- Track boundary success/failure counts, rate-limit events, and rejected-input
  counts so ops can alert on abuse or misconfiguration.

### Rollout and rollback

- Changes to error boundary behavior that touch money paths or mainnet behavior
  must land behind a feature flag or kill-switch.
- Document the rollback path in the PR description: disabling the flag must
  restore the previous behavior without data migration.

## Audit log filters

The audit log is a privileged, read-only surface that exposes who did what, to
which resource, and when. Filters narrow that view; they must never widen
access. Filtering is **deny by default**: a caller only sees audit entries they
are authorized to read, and filters can only further restrict that set.

### Filter contract

- Filters are expressed as a typed, validated object (actor, action, resource,
  outcome, time range, network). Unknown filter keys are rejected, not ignored.
- The time range is a half-open interval `[from, to)`; `from` must be `<=` `to`.
  An inverted or malformed range fails closed to an empty result, never to the
  full log.
- Pagination is cursor-based and stable: the cursor encodes the last-seen sort
  key so concurrent inserts cannot cause skipped or duplicated rows.
- The active filter set is echoed back with the result so callers and support
  can confirm exactly what was applied.

### Typed entrypoints and error codes

Audit log queries are exposed through a typed entrypoint that returns a
discriminated result. Callers must branch on the error code rather than on
message text. Stable error codes:

| Code | Meaning |
| --- | --- |
| `AUDIT_OK` | Query succeeded; results (possibly empty) returned. |
| `AUDIT_FORBIDDEN` | Caller is not authorized to read the requested scope. |
| `AUDIT_AUTH_EXPIRED` | Session/JWT expired; re-auth required. |
| `AUDIT_INVALID_FILTER` | Filter failed validation (unknown key, bad range). |
| `AUDIT_RANGE_TOO_LARGE` | Requested time range exceeds the maximum window. |
| `AUDIT_DEPENDENCY_UNAVAILABLE` | Upstream DB/index unavailable; fail closed. |
| `AUDIT_RATE_LIMITED` | Too many queries; retry later. |

Every query carries a correlation id propagated to logs and the user-facing
error surface so support can trace a single request.

### Authorization

- Reads require an authorized owner/delegate/guardian session or a scoped
  API-key/JWT. The server resolves the caller's permitted scope; the client
  cannot request a broader scope than it holds.
- A revoked delegate or expired session fails closed with `AUDIT_AUTH_EXPIRED`
  or `AUDIT_FORBIDDEN`; filters never substitute for authorization.
- Deny by default: a new filter dimension is unreadable until the server grants
  it, so adding a filter cannot leak a previously hidden field.

### Idempotency and fail-closed behavior

- Reads are idempotent and safe to retry; the cursor makes replays return the
  same page rather than duplicating or skipping entries.
- If the DB/index is unavailable, the query fails closed with
  `AUDIT_DEPENDENCY_UNAVAILABLE`; it never returns a partial or stale-success
  result that could hide activity.
- Export/write paths derived from a filtered view (for example CSV export) must
  re-validate the filter and authorization server-side before producing output.

### Edge cases and failure modes

- **Concurrent/replayed requests:** cursor-based pagination plus idempotent
  reads keep concurrent queries consistent; replayed requests return the same
  page.
- **Dependency outage:** DB/index outage fails closed; no silent empty-success
  that could mask missing entries.
- **Auth expiry / wrong role / revoked delegate:** fail closed and prompt
  re-auth; the filter set is never used to escalate scope.
- **Adversarial input:** oversized filter payloads, unknown keys, and inverted
  ranges are rejected before querying; queries are rate-limited per session and
  per IP to prevent griefing.
- **Testnet vs mainnet:** the `network` filter is explicit and validated; a
  mainnet query is never satisfied by testnet data and vice versa.

### Observability

- Emit structured logs with the correlation id, the resolved error code, and
  the applied filter dimensions (never raw key material, JWTs, or webhook
  secrets).
- Track query success/failure counts, rate-limit events, and rejected-filter
  counts so ops can alert on abuse or misconfiguration.

### Rollout and rollback

- Changes to audit log filtering that touch money paths or mainnet behavior
  must land behind a feature flag or kill-switch.
- Document the rollback path in the PR description: disabling the flag must
  restore the previous behavior without data migration.

## Source maps production policy

Source maps expose original source, internal module structure, and any inlined
values to anyone who can fetch the deployed bundle. Shipping readable source
maps to production is a security and IP risk, so the policy is **fail closed**.

### Policy

- **Production: source maps are disabled.** Production builds must never emit
  or serve browser source maps. `productionBrowserSourceMaps` is `false` in
  `next.config.ts` and must stay `false`.
- **Development / test: source maps are enabled.** Local dev and test builds
  keep source maps for debuggability; this is not a production surface.
- **No public exposure.** Even when maps exist in non-production, they must not
  be uploaded to a public CDN or served from a production origin.

### Enforcement

- The setting lives in `next.config.ts` as `productionBrowserSourceMaps: false`.
  It is the single source of truth for the production policy.
- A CI test asserts the production setting is disabled so the policy cannot
  regress silently. Any change that re-enables production source maps must fail
  CI and require an explicit, reviewed policy change.
- If a future need requires production maps (e.g. private error tracking), they
  must be uploaded to a private, access-controlled store and never served from
  the public origin. That change requires a design note and a feature flag.

### Edge cases and failure modes

- **Misconfigured environment:** if an environment cannot be classified as
  production, treat it as production and keep source maps disabled.
- **Accidental upload:** build steps must not publish maps to public storage;
  treat any such upload as a security incident and rotate/remove the artifact.
- **Testnet vs mainnet:** both are production-like for this policy; neither
  ships readable source maps.

### Observability

- CI reports the resolved `productionBrowserSourceMaps` value so reviewers can
  confirm the policy at a glance. No secrets or source content are logged.

### Rollback

- Re-enabling production source maps is a policy change, not a routine edit. It
  requires a design note, a private upload target, and a documented rollback in
  the PR description.

## Settings danger zone confirm phrase

The Settings danger zone hosts destructive, irreversible actions (for example
account/wallet deletion and recovery reset). These actions are gated behind a
typed confirm-phrase guard so a stray click or a scripted request cannot trigger
them. The guard is **fail closed**: the destructive action stays disabled until
the exact phrase is entered.

### Confirm phrase contract

- The required phrase is a fixed, documented constant (for example
  `DELETE MY ACCOUNT`). It is never derived from user input or remote config.
- Matching is **case-insensitive** and **whitespace-normalized**: leading and
  trailing whitespace is trimmed and internal runs of whitespace collapse to a
  single space before comparison. No other normali