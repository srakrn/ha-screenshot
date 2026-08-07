# Efficient image polling plan

## Status

Implemented.

## Goal

Allow frequently polling displays to avoid downloading unchanged image bodies while ensuring every request revalidates against the current capture.

## HTTP contract

1. Generate a strong `ETag` from the completed image bytes, or a safe hash recorded only after atomic rename.
2. Return `Last-Modified` from the successful capture file timestamp.
3. Honor `If-None-Match` first and `If-Modified-Since` second, returning `304` only when the selected file is unchanged.
4. Use `Cache-Control: no-cache, must-revalidate` plus `Expires: 0`. Do not use a positive freshness lifetime.
5. Support `HEAD` for `/screenshots/:taskId` and `/images/:imageId` with the same status and headers as `GET`, but no body.
6. Include stable `Content-Type`, `Content-Length`, `ETag`, and `Last-Modified` headers on successful responses.

## Implementation

Centralize image metadata and response handling in `src/service.js`. Metadata must describe the final renamed file, never the temporary screenshot. For a scheduled feed, compute validators from the currently selected task so a schedule switch invalidates the previous response even if capture times happen to match.

Do not calculate a full-file hash on every request. Calculate it after capture, restore it once on startup for existing files, and cache it with file size and modification time. If external file replacement is supported, invalidate cached metadata when those values change.

## Verification

- Test normal `GET`, `HEAD`, matching and non-matching entity tags, and date validators.
- Test that a new atomic capture changes the validator.
- Test that switching a scheduled feed changes the validator.
- Test missing images still return `503` for both methods.
- Test that `304` responses contain no body and retain the required cache policy.
- Test PNG and JPEG content metadata.

## Invariants and compatibility

Image URLs remain unauthenticated and never trigger Chromium. This deliberately changes `no-store` to mandatory revalidation; document that clients may retain a local copy but must check the service before reuse. If strict `no-store` is a non-negotiable deployment requirement, make conditional delivery an explicit deployment setting rather than silently weakening that policy.
