# Home Assistant App plan

## Status

Proposed implementation plan. This document does not describe functionality that has already shipped.

Home Assistant now calls add-ons **Apps**. In this plan, “App mode” means execution under Home Assistant Supervisor, while “container mode” means the existing Docker/Compose or direct Node.js deployment.

## Goal

Package `ha-screenshot` as a Home Assistant App without turning it into an App-only product.

The completed service must remain deployable in either of these forms:

1. A normal OCI container, including the supported `compose.yaml` deployment.
2. A Home Assistant App installed and managed by Supervisor.

Both forms must use the same capture, scheduling, persistence, validation, HTTP, and security implementation. App support must be an adapter around the existing service, not a fork or a second implementation.

## Non-goals

- Do not turn the service into a Home Assistant custom integration. An integration runs inside Home Assistant Core and is a poor fit for a long-running Chromium process.
- Do not require a database, queue, Home Assistant-side component, or frontend framework.
- Do not remove the public unauthenticated image endpoints. Simple eInk clients must still be able to fetch an image without Home Assistant authentication.
- Do not make image requests trigger Chromium work.
- Do not make the standalone container depend on Supervisor or Home Assistant OS.
- Do not silently create an implicit screenshot task. A user must explicitly configure at least one task before capture can run.

## Product-level invariants

The existing repository invariants continue to apply in both modes, including exact output dimensions, atomic image writes, non-overlapping runs per task, retention of the last successful image, cache-disabled image responses, token secrecy, origin-scoped credential injection, configuration validation before hot-apply, and clean Chromium shutdown.

The dual-runtime work adds these invariants:

- `RUNTIME_MODE=standalone` and `RUNTIME_MODE=home_assistant_app` select explicit runtime adapters. The default remains `standalone` for backward compatibility. Do not infer App mode merely from an incidental environment variable.
- Capture and scheduling code must not contain Supervisor-specific branches.
- The App's administration surface is available only through Supervisor ingress.
- The App's public listener contains no editor assets, configuration reads, mutations, manual capture routes, detailed errors, or credentials.
- Standalone mode retains the current editor authentication contract unless a separate product change deliberately replaces it.
- A missing App task document is a setup state, not a valid empty capture configuration. In setup state Chromium and capture scheduling remain stopped until the editor atomically saves a valid document with at least one explicit task.
- The Home Assistant access token is never copied into the task document, output directory, response bodies, URLs, logs, screenshots, or public metadata.
- App support must not require host networking, privileged mode, disabled protection, Docker socket access, or an elevated Supervisor API role.

## Proposed runtime architecture

### Standalone mode

Preserve the current external behavior:

```text
Docker/Compose environment
        |
        v
combined HTTP server :3000
        +-- public gallery and image routes
        +-- authenticated /admin/ and configuration API
        +-- readiness and liveness routes
```

Standalone configuration remains environment-based for shared settings and file-based for tasks and feeds:

- `HA_URL`
- `HA_ACCESS_TOKEN`
- `CONFIG_FILE`
- `CONFIG_USERNAME`
- `CONFIG_PASSWORD`
- `OUTPUT_DIRECTORY`
- `IMAGE_SCHEDULE_TIMEZONE`
- `IGNORE_HTTPS_ERRORS`
- `PORT`

Existing deployments should not have to rewrite their `.env`, Compose mounts, task document, URLs, or editor credentials when App support is added.

### Home Assistant App mode

Use two listeners with different route sets:

```text
Home Assistant UI
        |
        | Supervisor ingress, already authenticated
        v
private admin listener :8099
        +-- editor UI
        +-- configuration API
        +-- manual capture API
        +-- private screenshot previews

LAN/eInk clients
        |
        | direct unauthenticated connection
        v
public image listener :3000
        +-- /
        +-- /screenshots/<task-id>
        +-- /images/<image-id>
        +-- /api/gallery
        +-- /healthz
        +-- /livez
```

The ingress port is not published to the host. Port 3000 is deliberately publishable so devices that cannot authenticate to Home Assistant can poll stable image URLs.

The two listeners may share a Node process and a `TaskManager`, but they must be separate Express applications. Route separation must be structural rather than relying only on request headers inside a single externally reachable application.

## Configuration model

### Runtime adapter

Add a small runtime settings layer, for example `src/runtime.js`, with this responsibility:

```js
loadRuntimeSettings({ env, optionsFile })
```

It returns the shared values consumed by `src/config.js` without changing the task/feed definition format.

In standalone mode it reads the current environment contract. In App mode it reads `/data/options.json`, validates its scalar options, and supplies fixed App paths:

```text
CONFIG_FILE=/data/config.json
OUTPUT_DIRECTORY=/data/images
ADMIN_PORT=8099
PUBLIC_PORT=3000
```

The access token should be read directly into memory. Avoid generating a shell command line or intermediate file containing the token. Environment variables inside the App container are acceptable only if a minimal launcher is retained; direct Node parsing of `options.json` is preferable.

### Supervisor options

Keep App options limited to shared startup settings:

```yaml
options:
  ha_url: "http://homeassistant:8123"
  ha_access_token: null
  image_schedule_timezone: "UTC"
  ignore_https_errors: false
  public_base_url: ""
  log_level: "info"

schema:
  ha_url: url
  ha_access_token: password
  image_schedule_timezone: str
  ignore_https_errors: bool
  public_base_url: str?
  log_level: list(trace|debug|info|notice|warning|error|fatal)
```

Treat this as an illustrative manifest until validated with the current Supervisor configuration validator.

Do not place `tasks` and `images[].slots[]` in Supervisor options. The existing document is edited atomically, supports richer validation, and is deeper than Supervisor options are intended to represent. `/data/config.json` remains the canonical task/feed document in App mode.

### First-run setup

App installation begins without `/data/config.json`. The service must still start the ingress administration listener so the user can create the first task.

Setup state behavior:

- `/livez` returns 200 because the process is alive.
- `/healthz` returns 503 with a generic `configuration_required` state.
- Public image routes return 503 without exposing private configuration details.
- The ingress editor explains that at least one task is required.
- Chromium is not started and no scheduler exists.
- The first successful editor save validates a complete document, writes it atomically, starts Chromium, and hot-applies the tasks.
- Invalid or empty task documents are rejected and never become active configuration.

This requires separating “load runtime settings and start the administration plane” from “load a valid capture definition and start the capture plane.” Standalone mode should continue to fail fast when its explicitly configured `CONFIG_FILE` is missing or invalid.

### Persistence and backups

Use only App-owned persistent storage:

```text
/data/options.json       Supervisor-owned scalar options
/data/config.json        application-owned tasks and feeds
/data/images/            latest successful captures
/data/custom.css         optional user stylesheet
```

Atomic replacement of `/data/config.json` continues to use a temporary sibling followed by rename. No Home Assistant configuration-directory mapping is necessary.

Images may be included in App backups initially because restoring the last successful image is useful. If backup size becomes material, introduce an explicit documented backup-exclusion decision rather than silently changing retention.

In container mode, keep `/config/config.json` and `/data` as the supported container paths and continue mounting the containing `/config` directory rather than only the file.

## Home Assistant authentication

### Capturing the dashboard

Version one should continue requiring a Long-Lived Access Token belonging to a dedicated, non-admin Home Assistant user.

Supervisor's `SUPERVISOR_TOKEN` provides supported REST and WebSocket access through:

```text
http://supervisor/core/api/
ws://supervisor/core/websocket
```

That does not by itself provide a normal authenticated frontend browser session at `http://homeassistant:8123`. Because this service renders the actual frontend rather than merely reading entity state, keep the existing `hassTokens` injection approach and its origin restriction.

Do not enable `homeassistant_api`, `hassio_api`, `auth_api`, or an elevated `hassio_role` unless an implemented feature actually uses it. Ingress handles editor user authentication and does not require those permissions.

Document the token requirements prominently:

- Create a dedicated non-admin Home Assistant user.
- Create a Long-Lived Access Token for that user.
- Store it in the App's password option or standalone secret environment.
- Revoke and replace it if it might have been disclosed.

### Editor authentication

In standalone mode, retain HTTP Basic authentication and the mutation header requirement.

In App mode:

- Supervisor ingress authenticates the browser.
- Set `panel_admin: true` so only Home Assistant administrators see the panel.
- Require the ingress identity headers, including `X-Remote-User-Id`, on the admin application.
- Restrict the admin listener to the Supervisor ingress proxy source as required by Home Assistant's ingress contract.
- Retain `X-Requested-With: ha-screenshot` or replace it with an equally explicit same-origin mutation control.
- Do not treat user-supplied ingress identity headers arriving on the public listener as authentication.

Standalone Basic credentials are not required or accepted on the App ingress listener. `CONFIG_USERNAME` and `CONFIG_PASSWORD` remain standalone-only settings.

## HTTP and frontend changes

### Express application split

Refactor `src/service.js` into shared handlers and two application factories, for example:

```text
createPublicApp(manager, config)
createAdminApp(manager, config, authStrategy)
createStandaloneApp(manager, config)
```

`createStandaloneApp` can compose the public and admin routers to preserve the current single-port contract. `createPublicApp` must never mount the admin router.

Public routes in App mode:

- `GET /`
- `GET /screenshots/:taskId`
- `GET /images/:imageId`
- `GET /api/gallery`
- `GET /healthz`
- `GET /livez`
- public static assets needed by the gallery only

Ingress routes:

- editor entry point and static assets
- `GET /api/config`
- `PUT /api/config`
- `POST /api/tasks/:id/capture`
- a private preview route or safe proxy for images shown in the editor
- optional ingress-local health information with detailed errors

Keep detailed error messages off all public routes. Token values must remain redacted even in ingress error details and logs.

### Ingress path handling

The current frontend uses root-absolute paths such as `/api/config`, `/app.css`, and `/screenshots/...`. Those paths escape the dynamic Supervisor ingress prefix.

Change browser requests and asset references to be ingress-relative. When an absolute base is truly necessary, derive it from the Supervisor-provided `X-Ingress-Path` and never from untrusted forwarding headers.

Test ingress with a nontrivial generated prefix; testing only at `/` will miss this class of failure.

### Framing and content security policy

The current response policy prevents Home Assistant from displaying the editor in an iframe:

```text
frame-ancestors 'none'
X-Frame-Options: DENY
```

Use separate security header policies:

- Standalone admin pages may keep the current frame denial.
- App ingress pages must permit the Home Assistant ingress frame. Omit incompatible legacy frame headers and use the narrowest policy that works reliably with Supervisor ingress.
- Public pages should retain strict CSP, `nosniff`, and cache protection.
- Configuration and editor responses remain `no-store`.

### Frontend assets

Bundle all editor and gallery assets in the image. Remove the runtime dependency on jsDelivr so the App remains usable when the user's browser or Home Assistant network has no Internet access.

Do not adopt Home Assistant's private frontend web components; their API is not a supported contract for third-party applications. Keep the dependency-free frontend or package stable third-party assets locally.

### Public URLs

The canonical routes remain:

```text
http://<home-assistant-host>:3000/screenshots/<task-id>
http://<home-assistant-host>:3000/images/<image-id>
```

`public_base_url` is optional presentation metadata used by the editor when showing copyable URLs. It must not influence route authorization or token injection. If empty, the UI can propose a URL using the browser hostname and configured public port, while clearly allowing the user to replace it with the LAN address their display can reach.

Ingress URLs are session-oriented and must not be shown as stable eInk image URLs.

## Health, startup, and shutdown

Add two distinct health concepts:

- `/livez`: 200 whenever the Node process and HTTP event loop are serving. Use this for the App watchdog and container liveness.
- `/healthz`: readiness with the current semantic requirement that every configured task has an image. It returns 503 during first-run setup, asynchronous initial capture, or missing task images.

A capture failure must not cause the process to exit or discard the last successful image. Invalid shared startup settings may fail App startup with a useful redacted log message. Missing task configuration in App mode enters setup state rather than restarting forever.

Shutdown order remains:

1. Stop accepting new HTTP requests.
2. Stop schedules.
3. Await or safely settle active task operations.
4. Close browser contexts.
5. Close Chromium.
6. Exit.

Both public and ingress servers must be closed during shutdown.

## App packaging

### Repository layout

Keep the application source at the repository root so the existing container workflow remains natural. Add App store metadata separately:

```text
repository.yaml
home-assistant-app/
  config.yaml
  translations/en.yaml
  apparmor.txt
  DOCS.md
  README.md
  CHANGELOG.md
  icon.png
  logo.png
```

The public App should reference a prebuilt image:

```yaml
image: ghcr.io/<owner>/ha-screenshot
```

Build that image from the root `Dockerfile`. This avoids duplicating `src/`, `public/`, or package manifests inside the App metadata directory. Public releases should use prebuilt images; asking every Home Assistant installation to build Playwright locally is slow, failure-prone, and wasteful on small storage devices.

For local App development, publish a development tag or load a locally built image into the Home Assistant test host and temporarily point `config.yaml` at that image. Document the exact developer workflow.

### Illustrative App manifest

Validate every key against the current Supervisor release before merging:

```yaml
name: "Home Assistant Screenshot"
version: "0.1.0"
slug: "ha_screenshot"
description: >-
  Periodically render Home Assistant dashboards and expose stable image URLs.
url: "https://github.com/<owner>/ha-screenshot"
image: "ghcr.io/<owner>/ha-screenshot"

arch:
  - amd64
  - aarch64

startup: application
boot: auto
init: false

ingress: true
ingress_port: 8099
ingress_entry: /admin/
panel_icon: mdi:monitor-screenshot
panel_title: Screenshots
panel_admin: true

ports:
  3000/tcp: 3000

ports_description:
  3000/tcp: Unauthenticated screenshot and gallery server

watchdog: "http://[HOST]:[PORT:3000]/livez"

options:
  ha_url: "http://homeassistant:8123"
  ha_access_token: null
  image_schedule_timezone: "UTC"
  ignore_https_errors: false
  public_base_url: ""
  log_level: "info"

schema:
  ha_url: url
  ha_access_token: password
  image_schedule_timezone: str
  ignore_https_errors: bool
  public_base_url: str?
  log_level: list(trace|debug|info|notice|warning|error|fatal)
```

Do not add host networking, privileged capabilities, `full_access`, Docker API access, or writable Home Assistant mappings.

### Dockerfile

Continue using a glibc-based Playwright-compatible image. Do not switch the runtime to Alpine because Playwright browser binaries do not support musl as a general deployment target.

Requirements:

- Keep the `playwright` package version and Playwright image tag exactly matched.
- Retain the non-root runtime user.
- Add `ARG BUILD_VERSION` and `ARG BUILD_ARCH` as needed by the Home Assistant publishing workflow.
- Add OCI and Home Assistant App labels in the Dockerfile or publishing workflow.
- Keep the image usable through ordinary `docker run` and Compose; do not make its entry point depend on Bashio.
- Set App mode explicitly from App packaging or its entry point, while the base image continues to default to standalone mode.
- Include only Chromium if a custom Playwright image is later built, but treat that optimization as separate from the first functional App release.

Chromium commonly benefits from larger shared memory. Compose should retain `shm_size: 256mb`. App mode should first be tested under protected defaults. If necessary, use Playwright's `--disable-dev-shm-usage` in App mode rather than requesting host IPC. Do not weaken App isolation without measured evidence and a documented security review.

### AppArmor

Ship a custom enforcing AppArmor profile. Develop it by starting in complain mode on a dedicated test host, exercising startup, capture, configuration replacement, failure handling, and shutdown, then narrowing the observed permissions before release.

The profile should allow only the application, Chromium, required shared libraries, `/tmp`, `/dev/shm`, read-only system resources, and the App's `/data` storage. It should not grant access to Home Assistant configuration, host devices, Docker, or unrelated App data.

## Multi-architecture publishing

Target:

- `linux/amd64`
- `linux/arm64` / Home Assistant `aarch64`

Playwright publishes ARM64 images, but the exact pinned tag, Chromium startup, sandbox behavior, fonts, image dimensions, and native dependencies must be tested on actual ARM64 Linux. Do not advertise `aarch64` merely because an image builds under QEMU.

Use the current Home Assistant BuildKit-based composite actions to publish:

```text
ghcr.io/<owner>/ha-screenshot:<version>
```

as a multi-architecture manifest, plus immutable digest-addressable images. Do not add the retired `build.yaml` or legacy `home-assistant/builder@master` workflow.

Release images should be signed when the publishing workflow supports it. Pin action revisions and base image versions/digests according to the repository's dependency policy.

## Source changes by area

### `src/config.js`

- Separate shared runtime setting validation from task/feed normalization.
- Preserve the existing environment contract in standalone mode.
- Accept settings supplied by the App adapter without teaching task normalization about Supervisor.
- Represent App setup state outside `normalizeConfiguration`; do not weaken its requirement for a non-empty task array.
- Add focused validation tests for every new App option and fixed path.

### `src/index.js`

- Select the explicit runtime adapter.
- Start the administration plane before the capture plane in App mode.
- Support setup state.
- Start one server in standalone mode and two servers in App mode.
- Preserve orderly shutdown and include both servers.

### `src/service.js`

- Extract public and admin routers/applications.
- Add ingress authentication middleware.
- Add `/livez`.
- Retain public readiness semantics.
- Use mode-specific security headers.
- Ensure public metadata never contains ingress-only links, secrets, or detailed errors.

### `src/task-manager.js`

- Support transition from App setup state to the first valid configuration.
- Keep validation, persistence, and hot-apply atomic.
- Ensure a failed initial activation leaves the service in setup state with no partial scheduler.

### `src/capture.js`

- Preserve credential origin restriction and exact screenshots.
- Add only the minimum App-specific Chromium launch argument if HAOS testing demonstrates a need.
- Do not add Supervisor knowledge.

### `public/`

- Make all asset and API URLs work beneath arbitrary ingress prefixes.
- Separate public gallery assets from editor assets where useful.
- Bundle third-party assets locally.
- Add first-run setup messaging.
- Show both private preview and copyable public URLs without confusing ingress URLs for public ones.

### Deployment and documentation

- Keep `Dockerfile`, `compose.yaml`, `.env.example`, and current standalone README instructions supported.
- Add `repository.yaml` and `home-assistant-app/` metadata.
- Document App installation, options, initial task creation, LAN port exposure, token creation, backups, updates, and removal.
- Clearly state that Apps require Home Assistant OS or another Supervisor-managed installation; Home Assistant Container users continue to use the normal container deployment.
- Keep the real `.env`, task configuration, tokens, screenshots, and user CSS out of version control.

## Test plan

### Unit and HTTP tests

Add tests covering:

- explicit runtime mode selection and standalone default;
- unchanged standalone environment behavior;
- App options parsing and redacted validation errors;
- App setup state with a missing task document;
- first valid configuration activation from setup state;
- rejection of an empty or invalid first task document;
- atomic persistence and no hot-apply after failed validation;
- public application does not contain admin or mutation routes;
- ingress application rejects requests without trusted ingress identity;
- standalone Basic authentication remains functional;
- ingress-relative assets and fetch URLs;
- framing headers differ correctly by mode;
- public errors contain no detailed capture error or token;
- `/livez` versus `/healthz` behavior;
- two-server startup and shutdown;
- concurrent refresh coalescing remains unchanged;
- previous-image retention remains unchanged.

Run `npm test` after every behavioral change.

### Container regression tests

Run:

```sh
npm ci
npm test
docker compose --env-file .env.example config --no-interpolate
docker compose build
docker compose up
```

Verify that an existing standalone configuration starts unchanged and that all canonical URLs and editor authentication still work.

### Home Assistant App tests

Test on a representative Supervisor-managed Home Assistant installation:

1. Fresh install reaches the ingress setup editor without a restart loop.
2. Editor cannot be reached through port 3000.
3. Non-admin Home Assistant users cannot open the panel.
4. A valid first task starts capture asynchronously.
5. An invalid task leaves setup or the previous configuration intact.
6. The editor works beneath the generated ingress prefix.
7. The editor loads without Internet access.
8. Direct public URLs work from another LAN device without credentials.
9. Public URLs do not grant access to configuration or manual capture.
10. Token authentication succeeds with a dedicated non-admin user.
11. Invalid-token errors are redacted publicly and retain the previous image.
12. PNG and JPEG output dimensions exactly match each task.
13. Multiple independent tasks and scheduled feeds behave as in container mode.
14. App restart preserves configuration and successful images.
15. Backup and restore preserve the intended `/data` contents.
16. App stop/update during capture closes contexts and Chromium cleanly.
17. Protected mode and the enforcing AppArmor profile remain enabled.
18. Test the same release on native amd64 and native aarch64 hardware before declaring both supported.

### Security tests

- Attempt direct access to every admin path on the public port.
- Spoof ingress headers on the public port and confirm they confer no access.
- Attempt cross-origin and header-less mutations.
- Use dashboard content containing the token string and confirm no diagnostic output reflects secrets.
- Exercise cross-origin iframes and confirm credentials are injected only for the configured Home Assistant origin.
- Confirm task fields cannot escape `/data/images` or read arbitrary files through `outputFilename` or `customCssFile`.
- Confirm public metadata bounds work creation and no public request starts Chromium.

## Delivery phases

### Phase 1: Runtime-neutral refactor

- Introduce explicit runtime settings.
- Split public/admin routers while composing them into the unchanged standalone server.
- Add `/livez`.
- Preserve and verify all existing behavior.

Exit criterion: current Compose deployment and tests pass without configuration or URL changes.

### Phase 2: App runtime

- Add App options parsing and fixed `/data` paths.
- Add setup state and first-configuration activation.
- Start separate ingress and public listeners.
- Implement ingress authentication and mode-specific headers.

Exit criterion: a local amd64 App install completes first-run setup, captures a dashboard, and serves a public image.

### Phase 3: Ingress-ready frontend

- Make all paths prefix-safe.
- Bundle assets.
- Add setup UX, private previews, and public URL presentation.

Exit criterion: the editor works through a generated ingress URL with Internet access disabled.

### Phase 4: Packaging and hardening

- Add App repository metadata, documentation, branding, AppArmor, watchdog, and security tests.
- Validate protected-mode Chromium behavior.

Exit criterion: App installation, update, restart, backup, restore, and removal are documented and exercised.

### Phase 5: Multi-architecture release

- Publish signed amd64 and aarch64 images through a multi-architecture manifest.
- Run native architecture integration tests.
- Tag App metadata with the matching image version.

Exit criterion: both advertised architectures pass the complete capture and lifecycle checklist.

## Release acceptance criteria

The App release is ready only when all of the following are true:

- One source tree and one versioned image support standalone and App runtime modes.
- Existing Compose users can upgrade without changing configuration.
- App users can install and complete setup entirely through Home Assistant UI.
- The App editor is ingress-only and requires a Home Assistant administrator.
- Public image endpoints remain unauthenticated and cannot mutate state or trigger capture.
- No credential is exposed in any public or private response, log, URL, screenshot, process argument, or persisted task document.
- Configuration writes and image writes remain atomic.
- Failed capture and invalid configuration retain the previous successful state.
- Chromium runs in protected mode as a non-root user with an enforcing AppArmor profile.
- Every advertised architecture has been tested natively.
- `npm test`, Compose validation, standalone integration checks, and App integration checks all pass.

## Risks and decisions to validate early

1. **Chromium under HAOS isolation.** Verify sandbox, shared memory, and AppArmor behavior before investing heavily in packaging. Prefer a launch flag over elevated container rights.
2. **ARM64 browser image.** Verify the exact pinned Playwright image and native ARM64 behavior before listing `aarch64`.
3. **Ingress source restriction.** Confirm the current Supervisor proxy address/contract and implement it in a way that tolerates IPv4-mapped addresses without trusting general forwarded headers.
4. **Ingress framing CSP.** Test the narrowest functional policy on supported Home Assistant versions.
5. **First-run lifecycle.** Ensure the setup administration plane can exist without weakening the core non-empty-task validation contract.
6. **Public port reachability.** Clearly document that reverse-proxied external Home Assistant URLs do not automatically proxy the App's port 3000; eInk devices normally use a reachable LAN host and port.
7. **Backup size.** Measure typical image storage before deciding whether captures should later be excluded from backups.

## Current reference documentation

- [Developing Home Assistant Apps](https://developers.home-assistant.io/docs/apps/)
- [App configuration and `/data/options.json`](https://developers.home-assistant.io/docs/apps/configuration/)
- [App communication and `SUPERVISOR_TOKEN`](https://developers.home-assistant.io/docs/apps/communication/)
- [Ingress presentation requirements](https://developers.home-assistant.io/docs/apps/presentation/)
- [App security and ingress identity headers](https://developers.home-assistant.io/docs/apps/security/)
- [Creating an App repository](https://developers.home-assistant.io/docs/apps/repository/)
- [Publishing multi-architecture App images](https://developers.home-assistant.io/docs/apps/publishing/)
- [Playwright Docker requirements](https://playwright.dev/docs/docker)

Re-check these references when implementation starts because Home Assistant App metadata and publishing guidance are versioned external contracts.
