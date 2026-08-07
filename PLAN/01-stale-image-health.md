# Stale image health plan

## Status

Proposed implementation plan. This document does not describe shipped functionality.

## Goal

Make readiness reflect whether each image is recent enough to trust, and preserve useful capture metadata across process restarts.

## Configuration

Add optional task field `maximumImageAgeSeconds`. `0` means that age does not affect readiness. Validate it as a non-negative integer and document it in `config.example.json`, `README.md`, and the admin editor.

## Implementation

1. Extend `CaptureService` with capture start time, duration, consecutive failure count, and next scheduled capture time.
2. On startup, inspect an existing output file and initialize `lastCaptureAt` from its modification time. Do not treat the file as valid until its type and exact dimensions are verified.
3. Centralize status calculation so `/healthz`, `/api/gallery`, and `/api/config` agree on `ready`, `stale`, image age, capture state, last success, last attempt, duration, failure count, and next run.
4. Define readiness as: a verified image exists, and it has not exceeded a configured maximum age.
5. Keep serving a stale last-good image from public image routes, but add safe `X-Image-Stale` and capture-time headers. Do not turn polling into capture work.
6. Return `503` from `/healthz` when any task is missing or stale, with a stable machine-readable state such as `starting`, `degraded`, or `ok`.
7. Show stale and failing states in the gallery and editor without exposing detailed errors publicly.

## Verification

- Add configuration tests for default, boundary, and invalid maximum ages.
- Test startup restoration from an existing image and rejection of malformed or incorrectly sized files.
- Test fresh-to-stale transitions with an injected clock.
- Test that failed captures retain the prior image while health becomes degraded when its age limit is exceeded.
- Test that public status continues to redact error details.

## Invariants and rollout

Exact dimensions, atomic writes, last-good retention, and cache-disabled delivery remain unchanged. Existing tasks default to unlimited age, so the feature is backward compatible. No new state file is required; image metadata comes from the output file and in-memory scheduler state.
