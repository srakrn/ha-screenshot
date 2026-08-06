# AGENTS.md

## Project purpose

This repository contains a small Dockerized service for rendering a Home Assistant dashboard in headless Chromium and serving the latest screenshot over unauthenticated HTTP for devices such as eInk displays.

Keep the service focused on one job: periodically produce a deterministic dashboard image and make that image easy to fetch.

## Repository layout

- `src/config.js` parses and validates environment configuration.
- `src/capture.js` authenticates to Home Assistant, renders the dashboard, applies visual modifications, and atomically writes the image.
- `src/service.js` creates an independent scheduler per task and defines the public HTTP routes.
- `src/schedule.js` resolves weekly image-feed schedules in the configured timezone.
- `src/task-manager.js` validates, persists, and hot-applies task and image-feed changes.
- `public/` contains the dependency-free task management UI.
- `src/index.js` owns process startup and graceful shutdown.
- `test/` contains Node test-runner tests.
- `Dockerfile` and `compose.yaml` define the supported deployment path.
- `.env.example`, `config.example.json`, and `README.md` are the public configuration reference.

## Development commands

Use Node.js 20.6 or newer.

```sh
npm ci
npm test
npm run start:env
```

Local capture testing requires a Chromium binary compatible with the pinned Playwright version. The supported deployment image already contains the browser.

Validate Compose changes with:

```sh
docker compose --env-file .env.example config --no-interpolate
```

When Docker is running, verify the complete deployment with:

```sh
docker compose build
docker compose up
```

## Implementation invariants

- Output dimensions must exactly equal each task's `width × height`. Keep `deviceScaleFactor` at `1` unless the configuration contract is deliberately changed.
- Write screenshots to a temporary file and rename them into place. Never stream a partially generated screenshot to clients.
- Do not overlap runs of the same task. Different tasks may capture concurrently, but concurrent refreshes for one task must share its active capture operation.
- A failed capture must not replace the last successful image. The scheduler should record the error and retry at the next interval.
- Keep image responses cache-disabled because many display clients poll the same URL repeatedly.
- Persist editor changes atomically and hot-apply them only after complete validation.
- The service may expose the rendered image without authentication, but it must never expose `HA_ACCESS_TOKEN` in responses, URLs, logs, screenshots, or error details.
- Keep editor credentials server-side, protect both its static UI and API, and require the mutation header on write/trigger requests.
- Inject Home Assistant credentials only into storage belonging to the configured Home Assistant origin. Do not inject them into embedded cross-origin frames.
- Always close browser contexts after a capture and close Chromium during graceful shutdown.
- Preserve support for Home Assistant's open shadow roots when applying custom CSS.
- Keep the Playwright package version and Playwright Docker image tag exactly matched.

## Configuration changes

Environment variables and screenshot task fields are the public API of this service. When adding or changing one:

1. Validate it in `src/config.js` with a safe default and useful error message.
2. Add or update tests in `test/config.test.js`.
3. Document shared settings in `.env.example`; document task and feed settings in `config.example.json` and `README.md`.
4. Avoid introducing secrets with command-line arguments or URL query parameters.

Do not commit a real `.env`, `tasks.json`, Home Assistant token, captured dashboard, or user-provided `custom.css` file.

At least one explicitly configured task is required through writable `CONFIG_FILE`. Do not add an implicit capture-task fallback. Scheduled image feeds define their own explicit fallback task.

In Docker, use `/config/config.json` and mount the containing `/config` directory. Do not recommend mounting only the file because atomic replacement requires creating and renaming a sibling temporary file.

## HTTP behavior

- `/` serves the public screenshot gallery.
- `/screenshots/<task-id>` serves each named task's latest successful image.
- `/images/<image-id>` serves the task selected by a scheduled image feed without triggering capture work.
- `/api/gallery` exposes only public gallery metadata, task status, and current feed selection.
- `/healthz` returns HTTP 503 until every configured task has an image and reports task and feed state.
- `/admin/`, `/api/config`, and manual capture mutations require editor authentication; public image routes must not inherit that requirement.
- The initial capture runs asynchronously, so HTTP 503 during startup is expected.
- Keep the image endpoint unauthenticated unless the product requirements explicitly change.
- New public endpoints must not provide a cheap way for arbitrary clients to create unbounded Chromium work.

## Testing expectations

Run `npm test` after every behavioral change. Add focused tests for configuration validation, scheduling, error retention, and HTTP behavior when practical.

For capture changes, also verify against a real or representative Home Assistant dashboard when credentials are available:

- successful token authentication;
- exact task-specific PNG/JPEG dimensions;
- independent width, height, interval, render delay, color scheme, timezone, and animation behavior;
- CSS and zoom behavior;
- invalid-token failure behavior;
- retention of the previous image after a failed refresh;
- clean shutdown while idle and during capture.

Never add live Home Assistant credentials to tests or fixtures.

## Dependencies and scope

Prefer the Node standard library and existing dependencies. Keep runtime dependencies few and pinned through `package-lock.json`. Avoid adding databases, queues, frontend frameworks, or Home Assistant-side components unless the requested functionality genuinely requires them.

Favor readable JavaScript over abstraction-heavy infrastructure. This service is intentionally small enough that its capture lifecycle and security boundaries should remain easy to audit.
