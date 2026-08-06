# Arbitrary web capture plan

## Status

Proposed implementation plan. This document describes a generalization of the
current Home Assistant-specific service; it is not a description of shipped
functionality.

## Goal

Allow each capture task to render any HTTP or HTTPS page, including pages that
need custom request headers, cookies, browser storage, HTTP authentication, or a
multi-step sign-in flow, while preserving the service's deterministic output,
scheduling, atomic writes, last-good-image retention, and simple public image
URLs.

The generalized product should still be small and auditable. Its configuration
must express common browser authentication and setup workflows without turning
the service into a general remote-code-execution or browser-as-a-service API.

## Non-goals

- Do not accept a target URL or browser instructions on a public image request.
- Do not trigger Chromium from `GET /screenshots/*` or `GET /images/*`.
- Do not expose a generic unauthenticated screenshot API.
- Do not run user-provided Node.js, shell commands, Playwright modules, or
  extensions.
- Do not attempt to defeat CAPTCHAs, WebAuthn, device approval, or interactive
  multi-factor authentication.
- Do not promise that every anti-bot-protected site will work in headless
  Chromium.
- Do not add a database or queue. The atomic configuration document and the
  existing per-task schedulers remain sufficient.
- Do not remove the exact-dimension and last-successful-image guarantees.

## Product and security invariants

The existing capture and HTTP invariants continue to apply. General web capture
adds these requirements:

- Every task has one explicit `url`; only `http:` and `https:` are accepted.
- Authentication material is referenced structurally, never interpolated into
  URLs, selectors, CSS, logs, error messages, or public metadata.
- A credential profile declares the exact origins on which its secrets may be
  used. Redirects and embedded cross-origin frames do not inherit credentials.
- Browser contexts remain isolated per capture. Cookies, local storage, HTTP
  credentials, headers, and request results from one task cannot leak into
  another task.
- Persisted credentials remain in a mode-`0600` server-side file and are write-
  only through the administration API. The API reports only profile IDs, types,
  allowed origins, and `configured` flags.
- Configuration and capture errors are redacted before logging or returning
  them. Redaction covers secret values, authorization headers, cookies, form
  values, request bodies, and URL user information.
- Main-document redirects and every credential-bearing request are checked
  against the declared origin policy.
- Network access policy is a deployment boundary, not a task-controlled escape
  hatch. Private/internal targets require an explicit operator choice.
- Custom requests have bounded bodies, response sizes, step counts, and
  timeouts. They run only as part of a configured scheduled or authenticated
  manual capture.
- Request interception must not accidentally attach a sensitive header to
  images, scripts, redirects, or third-party origins.
- Configuration is completely validated before persistence or hot-apply. A
  failed update leaves both the active configuration and schedulers unchanged.

## Proposed configuration model

Introduce configuration version `2`. Keep service/editor settings global, add
reusable write-only credential profiles, and make navigation and preparation
task-specific.

```json
{
  "version": 2,
  "settings": {
    "imageScheduleTimezone": "Asia/Bangkok",
    "configUsername": "admin",
    "configPassword": "change-this-editor-password"
  },
  "credentials": [
    {
      "id": "grafana",
      "allowedOrigins": ["https://grafana.example.test"],
      "httpCredentials": {
        "username": "viewer",
        "password": "secret"
      },
      "headers": [
        { "name": "Authorization", "value": "Bearer secret" }
      ],
      "cookies": [],
      "storage": []
    }
  ],
  "tasks": [
    {
      "id": "operations",
      "url": "https://grafana.example.test/d/operations?kiosk",
      "credentialId": "grafana",
      "width": 800,
      "height": 480,
      "refreshIntervalSeconds": 300,
      "navigation": {
        "waitUntil": "domcontentloaded",
        "timeoutMs": 60000
      },
      "steps": [
        {
          "type": "request",
          "method": "POST",
          "url": "https://grafana.example.test/api/session/refresh",
          "headers": [{ "name": "Content-Type", "value": "application/json" }],
          "body": "{}",
          "expectStatus": [200]
        },
        { "type": "waitForSelector", "selector": "main", "state": "visible" },
        { "type": "waitForTimeout", "timeoutMs": 2000 }
      ],
      "render": {
        "colorScheme": "dark",
        "timezone": "Asia/Bangkok",
        "zoom": 1,
        "disableAnimations": true,
        "hideCursor": true,
        "customCss": "",
        "customCssFile": ""
      },
      "output": {
        "format": "png",
        "filename": "operations.png"
      }
    }
  ],
  "images": []
}
```

The exact nesting can be adjusted during implementation, but the separation of
target, credentials, navigation, workflow steps, rendering, and output should
be retained. It prevents an ever-growing flat task object and gives the editor
clear sections.

### Credential profiles

Support these fields in the first release:

- `allowedOrigins`: required non-empty array of normalized origins. Reject paths,
  query strings, fragments, wildcard origins, and embedded URL credentials.
- `httpCredentials`: optional username/password supplied through Playwright's
  browser-context HTTP authentication.
- `headers`: optional name/value pairs installed through origin-aware request
  interception. Reject hop-by-hop headers and browser-controlled headers such as
  `Host`, `Content-Length`, and `Cookie`. Treat `Authorization`, API keys, and all
  values as secret.
- `cookies`: optional Playwright-compatible cookies with explicit domain/path or
  URL, `sameSite`, `secure`, `httpOnly`, and expiry validation.
- `storage`: optional local- or session-storage entries, each with an explicit
  origin. Entries must be injected only when the document origin matches.

Profiles may be shared by several tasks. A task without `credentialId` is an
anonymous capture. Do not silently combine profiles.

The admin read model returns entries such as:

```json
{
  "id": "grafana",
  "allowedOrigins": ["https://grafana.example.test"],
  "httpCredentialsConfigured": true,
  "headerNames": ["Authorization"],
  "cookieNames": [],
  "storageKeys": []
}
```

Omitted secret fields on `PUT /api/config` retain their current values; an
explicit per-field `clear` operation removes them. Never use a magic redaction
string that could collide with a real secret.

### Capture workflow steps

Use a small allow-listed step language, executed in array order. Version one
should support:

1. `request`: issue an HTTP request through the task's browser context so cookie
   state is shared with navigation. Allow method, URL, safe headers, bounded
   text/JSON/form body, expected status codes, and timeout. Discard the response
   body by default.
2. `goto`: navigate to a declared HTTP(S) URL. The task's top-level `url` is the
   implicit default navigation; additional navigation is useful for sign-in
   flows.
3. `fill`: fill an input selected by CSS selector. The value may be literal or a
   reference to a credential field; referenced values are always redacted.
4. `click`: click an element selected by CSS selector.
5. `press`: send an allow-listed key such as `Enter`, `Escape`, `Tab`, or arrow
   keys to a selected element.
6. `waitForSelector`: wait for attached, visible, hidden, or detached state.
7. `waitForURL`: wait for an exact URL or a safe glob pattern, with no arbitrary
   regular-expression execution.
8. `waitForResponse`: wait for a method/URL/status match. Do not retain or expose
   the response body.
9. `waitForTimeout`: bounded fixed delay for sites without a useful readiness
   signal.

Prefer selectors and observable readiness over delays. Cap the number of steps,
selector length, request/body size, and per-step and total capture duration in
`src/config.js`.

Do not ship response-to-secret extraction in the first release. Most API login
flows can establish a cookie in the shared context, while arbitrary JSON-path
extraction greatly increases the chance that tokens enter task state or error
messages. Add it later only with a write-only, in-memory variable model and
explicit origin scoping.

Page-scoped JavaScript is also deferred. If real deployments demonstrate a need,
add a separately enabled `evaluate` step with prominent warnings and an operator
environment flag. Even browser-scoped JavaScript can read page data and send it
over the network, so it is not a harmless convenience feature.

### Request customization

Separate persistent request behavior from one-off workflow requests:

- Credential-profile headers are automatically applied only to resource requests
  whose destination origin is in `allowedOrigins`.
- A `request` step carries its own method, URL, headers, and body and is validated
  against the same origin and network policies.
- Optional task `requestRules` may later support safe URL-pattern actions such as
  `abort` for analytics, fonts, media, or known unstable resources. Do not include
  arbitrary `fulfill` or body-rewrite behavior in version one.
- Capture errors may report method, redacted origin/path, status, and step number,
  but never request headers, body, cookies, or response body.

### Readiness and output

Replace the Home Assistant-specific default selector with no implicit selector.
The default pipeline is:

1. Create an isolated browser context.
2. Apply context options and safe credential primitives.
3. Execute any pre-navigation `request` steps explicitly marked `phase: before`.
4. Navigate to `task.url` using the configured `waitUntil` value.
5. Execute the remaining workflow steps.
6. Wait for `document.fonts.ready` within the remaining capture deadline.
7. Apply zoom and custom CSS, including existing open-shadow-root support.
8. Capture the exact `width x height` clip to a sibling temporary file.
9. Atomically rename the successful file into place.
10. Always close the browser context and remove the temporary file.

Keep PNG/JPEG behavior and scheduled image-feed compatibility unchanged.

## Network policy and SSRF controls

Arbitrary URLs make the editor an SSRF control plane. Editor authentication is
necessary but insufficient, particularly if the service is exposed through a
reverse proxy.

Add deployment-only controls, for example:

- `TARGET_NETWORK_POLICY=public` by default.
- `TARGET_ALLOWED_HOSTS` as an optional comma-separated exact-host/suffix
  allowlist.
- `TARGET_ALLOWED_PRIVATE_CIDRS` as an explicit opt-in for self-hosted sites.

For every main navigation, redirect, subresource, and custom request:

- Reject non-HTTP(S) schemes, URL usernames/passwords, malformed hostnames, and
  disallowed ports.
- Resolve hostnames and reject loopback, link-local, multicast, unspecified, and
  private addresses unless explicitly allowed.
- Always deny cloud instance metadata endpoints and known platform metadata
  hostnames, even when private access is enabled, unless a separate highly
  visible operator override is introduced.
- Re-evaluate each redirect target and resolved address to reduce DNS rebinding
  and redirect bypasses.
- Apply the policy to IPv4, IPv6, IPv4-mapped IPv6, and alternative textual IP
  forms.

Because many intended targets are private Home Assistant, Grafana, or internal
sites, document the private-CIDR opt-in clearly in Compose examples. Keep these
controls out of the web editor so a compromised editor account cannot broaden
the container's network reach.

Resource interception must balance safety and compatibility. Start by enforcing
strict checks for main-frame navigation, custom requests, and every request that
would receive credentials. Add enforcement for all subresources where reliable;
test common CDNs, redirects, service workers, WebSockets, and DNS failures before
making it the default.

## Code changes

### `src/config.js`

- Add and validate `version: 2`, credential profiles, absolute task URLs,
  workflow steps, nested navigation/render/output fields, and deployment network
  policy.
- Normalize origins and URLs once and store both persisted definitions and
  runtime-ready values.
- Centralize bounds for counts, text lengths, body sizes, timeouts, dimensions,
  and intervals.
- Keep filename confinement and reserved-name checks.
- Replace Home Assistant-specific `haUrl`, `accessToken`, `dashboardPath`, and
  `waitForSelector` defaults.
- Add explicit secret merge/clear behavior for hot updates.
- Ensure `configurationToDefinition` is lossless for non-secret values and never
  feeds the public/admin read model directly.

### `src/capture.js`

- Rename `DashboardCapture` to `WebCapture`.
- Split capture into helpers for context creation, origin-scoped credentials,
  network-policy enforcement, workflow execution, readiness, styling, and atomic
  output.
- Use a monotonic total deadline so a sequence of individually valid steps cannot
  keep a capture alive indefinitely.
- Share the browser context's cookie jar between `request` steps and page
  navigation.
- Install credential headers through request routing rather than global
  `extraHTTPHeaders` when redirects or third-party resources are possible.
- Remove hard-coded `hassTokens` injection and `/auth/` checks. Home Assistant
  becomes one documented configuration recipe using an origin-scoped storage
  entry.
- Preserve context cleanup, temporary-file cleanup, and exact dimensions on all
  failure paths.

### `src/task-manager.js`

- Include credential-profile changes when deciding which services must restart.
  Restart only tasks that reference a changed profile.
- Keep schedules for unrelated tasks running during a scoped configuration
  change where practical.
- Persist the complete validated v2 document atomically before replacing active
  services.
- Compare canonical normalized definitions instead of objects containing runtime
  helpers or raw secrets.

### `src/service.js`

- Replace `adminConfiguration` with an explicit redacted DTO builder.
- Keep image, gallery, health, and manual-capture route behavior stable.
- Change the mutation header value to a product-neutral value such as
  `web-screenshot`, accepting the old value during a documented migration
  window.
- Sanitize capture errors before placing them in health/admin state. Public
  health should expose only stable error codes; authenticated admin state may add
  redacted step/origin details.
- Keep JSON body limits and add lower nested limits through configuration
  validation.

### `public/`

- Rename Home Assistant and dashboard terminology to target/site/page.
- Replace global Home Assistant settings with a credential-profile editor.
- Divide the task modal into Target, Authentication, Workflow, Browser, Styling,
  and Output sections.
- Provide structured editors for headers, cookies, storage, and workflow steps;
  never display an existing secret value after save.
- Require an explicit action to clear or replace a configured secret.
- Add presets that generate ordinary v2 configuration for Home Assistant bearer
  storage, HTTP Basic, bearer header, cookie session, and form login. Presets must
  not introduce alternate runtime paths.
- Warn when a target needs operator-side private-network allowlisting.

### Packaging and documentation

- Rename the package description, headings, UI copy, log messages, Docker service
  name, and examples without breaking the existing container port or public URL
  routes.
- Document recipes for anonymous pages, Basic auth, bearer/API-key headers,
  cookies, form login, a preflight request, Home Assistant local storage, and
  internal/private targets.
- State plainly that the data volume contains credentials and captured page
  content and must remain private.
- Keep Playwright and its Docker image tag exactly matched.

## Migration from the current configuration

Implement a deterministic v1-to-v2 migration rather than requiring every Home
Assistant user to rebuild configuration manually.

For a current configuration:

- Create credential profile `home-assistant` with
  `allowedOrigins: [origin(settings.haUrl)]` and a local-storage entry named
  `hassTokens` containing the existing token payload.
- Convert each `dashboardPath` to the already resolved absolute task `url`.
- Set each task's `credentialId` to `home-assistant`.
- Convert current timing, browser, style, and output fields to their v2 nested
  equivalents.
- Convert a non-empty `waitForSelector` into the first post-navigation
  `waitForSelector` step and preserve `waitAfterLoadMs` as a following
  `waitForTimeout` step.
- Preserve task IDs, filenames, dimensions, formats, intervals, feeds, and public
  image URLs exactly.
- Preserve editor credentials and image schedule timezone.

Load v1 into memory and show a migration preview in the authenticated editor.
Persist v2 only on an explicit save, using the existing atomic replacement. Keep
a private sibling backup such as `config.v1.backup.json` until one successful v2
startup and capture have completed; document how and when it may be removed.
Never write the token into logs or migration responses.

Support reading v1 for one release cycle. Do not support writing both schemas or
maintain two capture implementations.

## Implementation phases

### Phase 1: Schema, redaction, and migration

1. Add v2 validators and runtime types with focused unit tests.
2. Add credential-profile secret merge/clear and redacted admin DTO tests.
3. Implement and test in-memory v1 migration and canonical v2 serialization.
4. Update `TaskManager` comparison and hot-apply behavior.

Exit criterion: configuration can round-trip without secret exposure or running
any generalized capture behavior.

### Phase 2: Generic anonymous capture

1. Replace Home Assistant URL construction with absolute task URLs.
2. Remove Home Assistant-specific login detection and token injection.
3. Implement the generic navigation/readiness/render pipeline.
4. Preserve atomic output, exact size, no-overlap, and failure retention tests.

Exit criterion: anonymous public and private test pages capture reliably with no
regression to scheduling or serving.

### Phase 3: Credential primitives and network policy

1. Add HTTP credentials, origin-scoped headers, cookies, and storage.
2. Add URL/redirect/address policy validation and deployment controls.
3. Add centralized error redaction and test it with distinctive canary secrets.
4. Verify cross-origin iframe and redirect cases do not receive credentials.

Exit criterion: each primitive works in isolation and cannot leak to a controlled
cross-origin test server or to API/log output.

### Phase 4: Declarative workflows

1. Implement bounded request, navigation, form interaction, and wait steps.
2. Add the total capture deadline and cancellation behavior.
3. Add representative form-login and preflight-cookie integration fixtures.
4. Confirm failed steps retain the previous successful image.

Exit criterion: common non-interactive login flows work without custom code.

### Phase 5: Administration UI and documentation

1. Build credential and workflow editors with write-only secret controls.
2. Add presets and client-side validation as convenience only; server validation
   remains authoritative.
3. Update gallery/admin terminology, examples, Compose settings, README, and
   `.env.example`.
4. Run migration and representative real-site checks, including Home Assistant.

Exit criterion: a user can configure each supported recipe without editing JSON,
and an existing Home Assistant deployment can migrate without changing its image
URLs.

## Test and verification matrix

### Configuration

- Reject invalid schemes, URL credentials, wildcard origins, malformed cookies,
  forbidden headers, duplicate IDs, missing profile references, invalid steps,
  excessive bounds, and unsafe output filenames.
- Verify secret omission retains, explicit clear removes, and replacement updates
  a secret.
- Verify admin/public DTOs and validation errors never contain canary secrets.
- Verify v1 migration preserves every compatible task/feed value.

### Capture behavior

- Anonymous HTTP and HTTPS page.
- HTTP Basic authentication success and failure.
- Bearer/API-key header limited to its allowed origin.
- Cookie and local/session-storage login.
- Form login followed by redirect and readiness selector.
- Preflight request that establishes a shared-context session cookie.
- Cross-origin redirect, iframe, image, script, service worker, and WebSocket.
- Timeout and cancellation during every step type.
- Exact PNG/JPEG dimensions, independent context options, CSS/shadow-root
  injection, zoom, animations, and font readiness.
- Concurrent different tasks and coalesced same-task refreshes.
- Previous image retained after navigation, auth, step, or screenshot failure.
- Browser contexts and Chromium close cleanly during idle and active capture.

### Network policy

- Public IPv4/IPv6 host allowed under the public policy.
- Loopback, RFC1918/ULA, link-local, multicast, unspecified, and metadata targets
  rejected by default.
- Explicit private CIDR and hostname allowlists work without opening unrelated
  private ranges.
- DNS rebinding and redirects from an allowed public URL to a disallowed address
  are rejected.
- Alternative numeric IP representations and IPv4-mapped IPv6 cannot bypass the
  policy.

### HTTP and persistence

- Public image requests never create capture work and remain cache-disabled.
- Manual capture and all configuration mutations retain editor authentication
  and the mutation header.
- Public gallery and health contain no target credentials or sensitive errors.
- Invalid updates do not change the persisted file or running services.
- Valid updates are written atomically and restart only affected tasks.
- Scheduled feeds retain stable dimensions, formats, content types, and URLs.

### Real integration checks

When test credentials are available, verify representative deployments for Home
Assistant, a Basic-auth site, a bearer-token dashboard, Grafana or a similar form
login, and a public anonymous page. Use dedicated least-privilege accounts and
never commit their credentials, storage state, responses, or screenshots.

## Completion criteria

The generalization is complete when:

- Every capture task can target an independent absolute HTTP(S) URL.
- The supported auth and request workflows are configurable through both the
  persisted schema and web editor.
- Secrets remain write-only, origin-scoped, redacted, and isolated per capture.
- Deployment-level network policy prevents unapproved internal/metadata access.
- Existing Home Assistant configurations migrate without changing public image
  routes or capture output contracts.
- All automated tests, Compose validation, representative captures, graceful
  shutdown checks, and secret-leak canary tests pass.

