# ErrorBoundary around dashboard pages

## What was implemented

- `src/components/dashboard/DashboardErrorBoundary.tsx` — a client
  component that logs the caught error (`console.error`, same pattern as
  the existing root-level `GlobalErrorBoundary`) and renders the existing
  `ErrorState` UI primitive (`src/components/ui/ErrorState.tsx`) with a
  "Try again" action wired to Next's `reset()`.
- `src/app/dashboard/error.tsx` — the Next.js App Router segment error
  file. Next automatically wraps `src/app/dashboard/layout.tsx`'s children
  in an error boundary that renders this component whenever a rendering
  error is thrown anywhere under `/dashboard/**` that isn't already caught
  by a more specific `error.tsx`.
- `src/components/dashboard/__tests__/DashboardErrorBoundary.test.tsx` —
  covers: error message rendering, the retry button invoking `reset()`, the
  fallback copy when `error.message` is empty, and that the error is logged.

## Why this is scoped correctly

Because `error.tsx` lives in the same segment as `layout.tsx`
(`src/app/dashboard/`), the `DashboardLayout` (sidebar + topbar) stays
mounted when a page throws - only the page content area is replaced with
the error UI. This avoids the "No regressions in closely related dashboard
navigation" failure mode: the sidebar's links (including the wallets
prefetch-on-hover behavior) keep working even while one page is in an error
state, so the user can navigate away without a full reload.

This complements, rather than duplicates, the existing root-level
`src/app/error.tsx` + `GlobalErrorBoundary`, which still catches errors
thrown outside of `/dashboard` (or inside `layout.tsx`/`RootLayout` itself).

## Error boundary behaviors (issue #772)

This section documents the invariants the boundary must uphold for
wallet / account-abstraction / payment flows. It is the contract that
`DashboardErrorBoundary`, `GlobalErrorBoundary`, and any future
segment-level `error.tsx` must satisfy.

### Stable error codes and correlation ids

- Every error surfaced through the boundary is normalized to a typed
  shape with a **stable error code** (e.g. `AUTH_EXPIRED`,
  `AUTH_WRONG_ROLE`, `AUTH_DELEGATE_REVOKED`, `DEP_UNAVAILABLE`,
  `WRITE_FAILED_CLOSED`, `UNKNOWN`) and a **correlation id** so a user
  report can be tied back to a server log line without exposing secrets.
- The correlation id is generated client-side when the boundary catches
  an error that does not already carry one, and is rendered in the
  fallback UI (small, copyable) alongside the human-readable message.
- Error codes are part of the public contract: do not rename or reuse
  them. Add new codes rather than overloading existing ones.

### Fail-closed on writes

- When a dependency (RPC / DB / Horizon) is unavailable, the boundary
  must **fail closed** for any money-path write: the UI shows the
  `DEP_UNAVAILABLE` / `WRITE_FAILED_CLOSED` state and does **not** offer
  a retry that could double-submit. Read-only surfaces may offer a plain
  retry.
- The boundary never swallows an error and continues as if the write
  succeeded. There is no "optimistic success" path through the boundary.

### Authz errors surface without bypass

- Expired auth, wrong role, and revoked delegate errors are rendered as
  distinct, actionable states (not a generic "something went wrong").
- The boundary does **not** provide any action that re-attempts a
  privileged call with elevated or cached credentials. Recovery is
  always "re-authenticate / re-authorize", never "retry as-is".
- Deny-by-default: a privileged surface that cannot prove authorization
  renders the auth error state rather than the privileged UI.

### Observability without secret leakage

- The boundary logs a structured record containing the error code, the
  correlation id, and a redacted message. It must **never** log raw key
  material, JWTs, webhook secrets, or full request bodies.
- Redaction is applied before logging; the same redacted message is what
  the user sees.

### Kill-switch / feature flag

- Any change to money-path or mainnet-affecting boundary behavior lands
  behind a feature flag or kill-switch. The flag defaults to the safe
  (fail-closed) behavior, and rollback is documented in the PR.

## Manual verification checklist

- [ ] Temporarily `throw new Error("test")` inside a dashboard page body,
      confirm the dashboard error UI renders with sidebar still visible.
- [ ] Click "Try again" and confirm `reset()` re-renders the segment.
- [ ] Check on a narrow mobile viewport (375px) - error card doesn't
      overflow horizontally.
- [ ] Confirm the error is logged to the console for observability.
- [ ] Simulate a dependency outage on a write path and confirm the
      boundary shows the fail-closed state (no retry that could
      double-submit).
- [ ] Simulate an expired auth / wrong role / revoked delegate and confirm
      the distinct auth error states render and no privileged action is
      offered.
- [ ] Confirm the correlation id is visible in the fallback UI and that
      no secrets appear in the console log.
