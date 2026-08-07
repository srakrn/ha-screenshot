# Failure and recovery webhook plan

## Status

Proposed implementation plan. This document does not describe shipped functionality.

## Goal

Notify an operator when a task has repeatedly failed and once when it recovers, without leaking Home Assistant credentials or creating notification storms.

## Configuration

Add server-side webhook settings containing URL, enabled event types, failure threshold, reminder interval, timeout, and optional secret header. The editor read API returns only the destination origin, event settings, and whether a secret is configured.

## Event model

- `capture_failed`: emitted after the configured consecutive-failure threshold.
- `capture_still_failing`: optional bounded reminder.
- `capture_recovered`: emitted once after a notified failure state succeeds.
- Payload fields: schema version, event ID, task ID, timestamp, safe failure category, consecutive failures, last success, and image age.

## Implementation

1. Keep notification state in memory initially; duplicate events after a process restart are acceptable and documented.
2. Dispatch asynchronously after capture state has been updated. Webhook latency or failure must never block capture scheduling or alter image readiness.
3. Use a short timeout, bounded response body handling, and no automatic cross-origin redirect when a secret header is present.
4. Redact URL user information and never serialize raw error objects, task dashboard URLs, tokens, configuration secrets, or screenshots.
5. Add HMAC signing over the exact request body as the preferred authentication method. Retain omitted secret values on configuration updates and provide an explicit clear operation.
6. Rate-limit per task and bound concurrent deliveries. Log only event ID, task ID, destination origin, status, and safe failure category.

## Verification

- Test threshold, reminder suppression, recovery, and repeated failure cycles.
- Test slow, failing, redirecting, and oversized webhook responses.
- Test HMAC signatures and secret retention/clearing.
- Assert that payloads and logs never contain configured secrets or raw errors.
- Test that webhook failure does not delay or fail a capture.

## Scope control

Ship one generic HTTP webhook integration rather than provider-specific Slack, email, or Home Assistant clients. Do not allow templates or arbitrary headers beyond a tightly validated authentication field.
