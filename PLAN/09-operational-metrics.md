# Operational metrics plan

## Status

Proposed implementation plan. This document does not describe shipped functionality.

## Goal

Expose bounded, low-cardinality service metrics for monitoring capture reliability, latency, browser state, and image freshness.

## Metrics

Provide counters and gauges for capture attempts, successes, failures by safe category, duration, active captures, browser restarts, image age, image readiness, and scheduled feed readiness. Use task and feed IDs as the only configurable labels.

## Implementation

1. Build a small in-memory metrics registry with the Node standard library rather than adding a monitoring framework.
2. Instrument state transitions in `CaptureService`, browser lifecycle code, and feed resolution.
3. Add `/metrics` in Prometheus text exposition format and retain `/healthz` for readiness decisions.
4. Do not include URLs, selectors, filenames, exception messages, usernames, tokens, or webhook destinations as labels or values.
5. Bound label cardinality through existing task/feed count and ID validation. Removed task series may remain until restart or be explicitly discarded during hot-apply.
6. Make metric access deployment-configurable if detailed task IDs are considered private. The default may remain unauthenticated on a trusted LAN, matching `/healthz`, but document reverse-proxy protection for exposed deployments.

## Verification

- Test counter and gauge changes across success, failure, recovery, active capture, and browser restart.
- Test duration and age using an injected clock.
- Test Prometheus formatting, escaping, content type, and stable metric names.
- Test hot-added and removed tasks and feeds.
- Assert bounded output and absence of every configured secret and raw error string.
- Add a representative Home Assistant REST sensor or monitoring scrape example to documentation.

## Non-goals

Do not add metric persistence, remote write, dashboards, alert management, or arbitrary user-defined labels. Process restarts may reset counters; freshness and current readiness are reconstructed from live state.
