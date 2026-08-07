# Capture retry and browser recovery plan

## Status

Proposed implementation plan. This document does not describe shipped functionality.

## Goal

Recover quickly from transient Home Assistant, network, page, or Chromium failures without overlapping a task or replacing its last successful image.

## Configuration

Add task fields `retryAttempts`, `retryInitialDelaySeconds`, and `retryMaximumDelaySeconds`, with conservative defaults. Validate bounded non-negative integers and require the maximum delay to be no smaller than the initial delay.

## Implementation

1. Keep one `inFlight` promise for the complete attempt-and-retry operation so concurrent manual and scheduled refreshes still share it.
2. Classify failures into safe categories: authentication, navigation, readiness timeout, custom CSS, screenshot write, browser unavailable, and shutdown. Public responses expose only the category.
3. Retry only likely transient categories. Authentication and configuration failures wait for the next normal interval or a configuration change.
4. Use bounded exponential backoff with small jitter. A scheduled interval firing during backoff must reuse the active operation.
5. Track each attempt, but set `lastCaptureAt` and clear failure state only after a successful atomic rename.
6. Add a browser lifecycle coordinator around `DashboardCapture`. If Chromium disconnects or reports a closed-browser failure, serialize one restart and let other tasks await it.
7. Never restart Chromium for an ordinary page-level timeout. Always close contexts, including failed attempts.
8. Make shutdown cancel pending retry timers, wait for active attempts, close contexts, and close Chromium exactly once.

## Verification

- Test success after a transient failure and exhaustion of all attempts.
- Test that authentication failures are not retried.
- Test that manual and scheduled calls share one retry sequence.
- Test independent tasks during another task's backoff.
- Test a simulated browser disconnect with concurrent tasks and assert a single restart.
- Test shutdown during capture and retry delay with fake timers.
- Confirm that no failed attempt replaces the last successful file.

## Invariants and rollout

Keep retry counts low to avoid amplifying an outage. Do not expose a public retry or capture endpoint. Log task IDs and safe categories only; errors must never include the access token or credential-bearing URLs.
