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

## Route loading UX

Route loading is a privileged read surface: it resolves a route (and its
associated wallet/AA/payment context) before the user can act on it. It must
follow the same fail-closed, deny-by-default contract as the error boundaries
above. This section is the canonical contract for route loading.

### Typed entrypoints and stable error codes

Route loading is exposed through a typed entrypoint that returns a
discriminated result. Callers branch on the error code, never on message text.
Stable error codes:

| Code | Meaning |
| --- | --- |
| `ROUTE_OK` | Route resolved; result returned. |
| `ROUTE_FORBIDDEN` | Caller is not authorized for the requested route scope. |
| `ROUTE_AUTH_EXPIRED` | Session/JWT expired; re-auth required. |
| `ROUTE_DELEGATE_REVOKED` | Delegate/guardian grant was revoked. |
| `ROUTE_INVALID_INPUT` | Route params failed validation (unknown key, bad shape). |
| `ROUTE_NOT_FOUND` | Route does not exist for the caller's scope. |
| `ROUTE_DEPENDENCY_UNAVAILABLE` | RPC/DB/Horizon unavailable; fail closed. |
| `ROUTE_RATE_LIMITED` | Too many loads; retry later. |
| `ROUTE_UNEXPECTED` | Unclassified failure; treated as failure, never success. |

Every route load carries a correlation id propagated to logs and the
user-facing error surface so support can trace a single request. The
correlation id is opaque and never encodes secrets.

### Loading states

- A route load is a single discriminated state machine: `idle` → `loading` →
  `loaded` | `error`. The UI never renders a privileged action while the state
  is `loading` or `error`; it renders a skeleton/placeholder instead.
- A failed load never falls back to a cached or optimistic route. On
  `ROUTE_DEPENDENCY_UNAVAILABLE` the UI shows a retry affordance and keeps the
  action disabled (fail closed).
- Retries are idempotent reads; a replayed load returns the same resolved route
  rather than re-applying any side effect.

### Authorization

- Route loads require an authorized owner/delegate/guardian session or a scoped
  API-key/JWT. The server resolves the caller's permitted scope; the client
  cannot request a broader scope than it holds.
- An expired session fails closed with `ROUTE_AUTH_EXPIRED`; a revoked delegate
  fails closed with `ROUTE_DELEGATE_REVOKED`; a wrong role fails closed with
  `ROUTE_FORBIDDEN`. The loader never substitutes a cached route for a failed
  authorization check.
- Deny by default: a new route scope is unreadable until the server grants it,
  so adding a route cannot leak a previously hidden capability.

### Edge cases and failure modes

- **Concurrent/replayed requests:** route loads are idempotent reads keyed by
  route id; concurrent loads for the same route resolve to the same result.
- **Dependency outage:** RPC/DB/Horizon outage fails closed with
  `ROUTE_DEPENDENCY_UNAVAILABLE`; no silent success that could mask a missing
  route or stale wallet/AA/payment context.
- **Auth expiry / wrong role / revoked delegate:** fail closed and prompt
  re-auth; the loader is never used to escalate scope.
- **Adversarial input:** oversized or malformed route params are rejected with
  `ROUTE_INVALID_INPUT` before any privileged call; loads are rate-limited per
  session and per IP to prevent griefing.
- **Testnet vs mainnet:** the network is explicit and validated; a mainnet
  route is never satisfied by testnet state and vice versa.

### Observability

- Emit structured logs with the correlation id, the resolved error code, and
  the route id (never raw key material, JWTs, webhook secrets, or full request
  bodies).
- Track route load success/failure counts, load latency, rate-limit events, and
  rejected-input counts so ops can alert on abuse or misconfiguration.

### Rollout and rollback

- Changes to route loading that touch money paths or mainnet behavior must land
  behind a feature flag or kill-switch.
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
  that could mask activity.
- **Auth expiry / wrong role / revoked delegate:** fail closed and prompt
  re-auth; filters are never used to escalate scope.
- **Adversarial input:** oversized ranges, unknown keys, and malformed cursors
  are rejected with `AUDIT_INVALID_FILTER` before any privileged read; queries
  are rate-limited per session and per IP to prevent griefing.
- **Testnet vs mainnet:** the network is an explicit filter dimension and is
  validated; a mainnet query is never satisfied by testnet entries and vice
  versa.

### Observability

- Emit structured logs with the correlation id, the resolved error code, and
  the applied filter set (never raw key material, JWTs, webhook secrets, or full
  request bodies).
- Track query success/failure counts, range-rejection counts, rate-limit
  events, and rejected-input counts so ops can alert on abuse or
  misconfiguration.

### Rollout and rollback

- Changes to audit filtering that touch money paths or mainnet behavior must
  land behind a feature flag or kill-switch.
- Document the rollback path in the PR description: disabling the flag must
  restore the previous behavior without data migration.
