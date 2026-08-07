# Admin capture testing plan

## Status

Proposed implementation plan. This document does not describe shipped functionality.

## Goal

Let an administrator validate Home Assistant connectivity and preview task output with actionable diagnostics before replacing the active configuration.

## User experience

Add two authenticated editor actions:

1. **Test connection** validates URL reachability and token authentication without writing configuration.
2. **Test capture** validates the draft task, renders one isolated preview, and displays its dimensions, format, duration, and safe diagnostic category.

Make it explicit that test actions use unsaved secrets and task fields but do not persist or hot-apply them.

## API and implementation

- Add authenticated mutation endpoints protected by the existing mutation header and a strict JSON size limit.
- Reuse `src/config.js` normalization against an ephemeral definition; do not create a second validation path.
- Run test captures through a separate bounded coordinator so they cannot overlap for the same editor session or starve scheduled work. Allow only a small global number of tests.
- Write previews to private temporary files outside public screenshot paths. Delete them after response completion, timeout, shutdown, or a short expiry.
- Return previews only from an authenticated, non-cacheable endpoint using opaque random IDs.
- Introduce safe diagnostic categories and concise guidance. Raw Playwright errors stay server-side and must be redacted before logging.
- Never echo access tokens, passwords, custom request headers, or credential-bearing URLs.

## Verification

- Test valid and invalid tokens, unreachable hosts, TLS errors, selector timeout, CSS-file errors, and successful preview delivery.
- Test authentication and mutation-header enforcement.
- Test concurrency and rate limits, preview expiry, cleanup after client disconnect, and clean shutdown.
- Assert that draft tests do not mutate `config.json`, active services, last-good images, or schedule state.
- Verify exact preview dimensions for PNG and JPEG.

## Scope control

Do not expose test endpoints publicly or accept a target URL through query parameters. Do not add arbitrary Playwright instructions. Testing supports only the same normalized fields that a saved capture task supports.
