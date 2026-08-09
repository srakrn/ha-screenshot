# Home Assistant dashboard image service

A Chromium service that periodically captures Home Assistant dashboards and serves them as unauthenticated images for eInk displays and other polling clients. The same image runs as a normal Docker container or as a Supervisor-managed Home Assistant App. Capture tasks are independent from scheduled image feeds, so one stable URL can show different dashboard captures throughout the week without creating Chromium work on request.

## Quick start

1. Create a dedicated, non-admin Home Assistant user and a Long-Lived Access Token.
2. Create the deployment environment file:

   ```sh
   cp .env.example .env
   ```

3. Start the service:

   ```sh
   docker compose up -d --build
   ```

4. Open `/admin/`, enter the Home Assistant connection and editor credentials in **Settings**, add at least one capture task, then save. The first-run editor is open only until this initial configuration is saved.
5. Open `/` and sign in with the same editor credentials to view the gallery.

The canonical public routes are:

```text
/screenshots/overview       latest image from one capture task
/images/hallway-display     stable scheduled image feed
```

Both routes require caches to revalidate on every request and support `ETag`, `Last-Modified`, conditional `GET`, and `HEAD`. An unchanged conditional request returns HTTP 304 without transferring the image again. They return HTTP 503 until the selected task has produced its first successful image. Scheduled image requests only select an existing capture file; they never trigger Chromium.

## Home Assistant App

Home Assistant OS and other Supervisor-managed installations can add this Git repository as a custom App repository, install **Home Assistant Screenshot**, and configure its Long-Lived Access Token from the App configuration page. The administration UI is available only through authenticated Supervisor ingress. Port 3000 remains a direct, unauthenticated LAN listener for display clients.

App mode keeps Supervisor options in `/data/options.json`, its task/feed document in `/data/config.json`, and captures in `/data/images/`. The token is read into memory from Supervisor options and is not copied into the task document. At least one explicit task must be saved through the ingress editor before Chromium starts.

The published App image is `ghcr.io/srakrn/ha-screenshot:<version>` for `amd64` and `aarch64`. Home Assistant Container installations do not include Supervisor and should use the Docker/Compose quick start above. See [the App documentation](home-assistant-app/DOCS.md) for setup and security details.

Standalone releases are published to Docker Hub as `srakrn/ha-screenshot` for `amd64` and `arm64`. Publishing a GitHub release with a SemVer tag such as `v1.2.3` creates the `1.2.3`, `1.2`, `1`, and `latest` image tags. Prereleases do not update `latest`, and `0.x` releases do not publish the unstable `0` major alias.

To show these images on Seeed Studio's ESPHome-based TRMNL 7.5-inch (OG) DIY Kit, including physical page navigation and a compact battery indicator, see the [ESPHome display guide](docs/esphome-trmnl-diy-kit.md).

### Portainer stack

[`compose.portainer.yaml`](compose.portainer.yaml) is a Portainer-friendly stack example that uses a published container image. Before deploying it:

1. In Portainer's stack environment variables, set `HA_SCREENSHOT_IMAGE`. `PUBLISHED_PORT` and `IGNORE_HTTPS_ERRORS` are optional.
2. Deploy the stack, open `/admin/`, and complete the first-run setup.

For example, set `HA_SCREENSHOT_IMAGE` to `srakrn/ha-screenshot:latest` or pin a release such as `srakrn/ha-screenshot:1.2.3`. Configuration and captured images are stored together in the named data volume.

If Portainer cannot pull a private image, add the registry and its credentials under **Registries** first. The stack publishes port `3000` by default; set `PUBLISHED_PORT` to change only the host-side port.

## Configuration storage

The editor stores the complete configuration atomically at `OUTPUT_DIRECTORY/config.json`. In the supported Docker deployment this is `/data/config.json`, on the same persistent volume as captured images. Keep the entire data volume private: the file contains the Home Assistant token and editor password. The service never returns either secret through its APIs.

Installations upgrading from the previous `/config/config.json` layout should move that file to `/data/config.json`, add the `settings` object shown below, and remove the old Home Assistant, editor, schedule, and `CONFIG_FILE` environment variables.

## Configuration

The complete configuration is saved atomically and hot-applied by the web editor:

```json
{
  "settings": {
    "haUrl": "http://homeassistant.local:8123",
    "accessToken": "replace-with-a-long-lived-access-token",
    "imageScheduleTimezone": "Asia/Bangkok",
    "configUsername": "admin",
    "configPassword": "change-this-editor-password"
  },
  "customCsses": [
    {
      "id": "eink-cards",
      "css": "ha-card { border: 0 !important; box-shadow: none !important; }"
    }
  ],
  "tasks": [
    {
      "id": "morning",
      "dashboardPath": "/dashboard-eink/morning",
      "width": 800,
      "height": 480,
      "refreshIntervalSeconds": 300,
      "maximumImageAgeSeconds": 900,
      "timezone": "Asia/Bangkok",
      "format": "png",
      "customCssIds": ["eink-cards"],
      "customCss": ".morning-only { display: none !important; }",
      "imageProcessing": {
        "mode": "monochrome",
        "palette": [],
        "dither": "atkinson",
        "threshold": 128,
        "invert": false,
        "rotation": 0
      }
    },
    {
      "id": "evening",
      "dashboardPath": "/dashboard-eink/evening",
      "width": 800,
      "height": 480,
      "refreshIntervalSeconds": 300,
      "timezone": "Asia/Bangkok",
      "format": "png"
    }
  ],
  "images": [
    {
      "id": "kitchen",
      "fallbackTaskId": "morning",
      "slots": [
        {
          "days": ["mon", "tue", "wed", "thu", "fri"],
          "start": "18:00",
          "end": "23:00",
          "taskId": "evening"
        }
      ]
    }
  ]
}
```

If `OUTPUT_DIRECTORY/config.json` does not exist at standalone startup, the service creates a private empty bootstrap configuration. The gallery shows a focused setup prompt and the editor remains unauthenticated until the first valid configuration is saved. That first save requires complete service settings and at least one explicit task. Changes are fully validated before the file or running configuration is replaced. Schedule-only changes preserve running capture services and their current status.

### Scheduled image feeds

Every feed has a URL-safe `id`, a `fallbackTaskId`, and zero or more weekly override slots. A slot contains:

- `days`: one or more of `sun`, `mon`, `tue`, `wed`, `thu`, `fri`, and `sat`;
- `start` and `end`: strict 24-hour `HH:MM` local times;
- `taskId`: the capture task active during the range.

Ranges are start-inclusive and end-exclusive. If the end is earlier than the start, the range continues overnight and `days` names the starting day. Overlapping ranges are rejected, including Sunday-to-Monday overlaps. Outside all ranges, the fallback task is used.

All tasks referenced by one feed must have exactly the same width, height, and format. This guarantees that the feed's dimensions and content type do not change throughout the day.

The **Schedule timezone** web setting controls weekly schedule selection globally and defaults to `UTC`. This is separate from each task's `timezone`, which controls dates and clocks inside the captured browser page.

### Capture task fields

| Field | Default | Purpose |
| --- | --- | --- |
| `id` | required | URL-safe name containing letters, numbers, `_`, or `-` |
| `dashboardPath` | `/lovelace/0` | Path relative to the Home Assistant URL, or an absolute dashboard URL |
| `width` / `height` | `800` / `480` | Exact output dimensions in pixels |
| `refreshIntervalSeconds` | `300` | Capture period; `0` means startup only |
| `maximumImageAgeSeconds` | `0` | Maximum last-good image age before readiness becomes stale; `0` disables the age limit |
| `retryAttempts` | `2` | Additional attempts after a likely transient capture failure (maximum `10`) |
| `retryInitialDelaySeconds` | `2` | Initial retry delay before small jitter is applied |
| `retryMaximumDelaySeconds` | `30` | Maximum exponential retry delay; must be at least the initial delay |
| `waitAfterLoadMs` | `3000` | Additional render time after Home Assistant loads |
| `colorScheme` | `light` | Browser preference: `light` or `dark` |
| `timezone` | `UTC` | Browser IANA timezone for dashboard dates and clocks |
| `disableAnimations` | `true` | Disable CSS and screenshot animations |
| `zoom` | `1` | CSS zoom from `0.1` through `5` |
| `format` | `png` | `png` or `jpeg` |
| `jpegQuality` | `85` | JPEG quality from 1 through 100 |
| `navigationTimeoutMs` | `60000` | Navigation and selector timeout |
| `waitForSelector` | `home-assistant` | Element required before capture |
| `customCss` | empty | CSS injected into the page and open shadow roots |
| `customCssFile` | empty | Path to an additional CSS file |
| `customCssIds` | `[]` | Ordered IDs of reusable top-level `customCsses` to inject |
| `hideCursor` | `true` | Hide the pointer |
| `outputFilename` | derived | Filename under `OUTPUT_DIRECTORY` |
| `imageProcessing.mode` | `color` | `color`, `grayscale`, or `monochrome` |
| `imageProcessing.palette` | `[]` | Reserved; must remain empty until custom palettes are supported |
| `imageProcessing.dither` | `none` | `none`, `floyd-steinberg`, or `atkinson`; non-`none` requires monochrome mode |
| `imageProcessing.threshold` | `128` | Monochrome split point from `0` through `255`; values at the threshold become white |
| `imageProcessing.invert` | `false` | Invert the processed RGB output |
| `imageProcessing.rotation` | `0` | Clockwise rotation: `0`, `90`, `180`, or `270` degrees |

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RUNTIME_MODE` | `standalone` | Runtime adapter; Compose and direct Docker deployments must keep `standalone` |
| `OUTPUT_DIRECTORY` | `/data` | Persistent capture directory |
| `IGNORE_HTTPS_ERRORS` | `false` | Accept invalid/self-signed Home Assistant TLS certificates |
| `PORT` | `3000` | HTTP listen port |

All other service settings are managed through `/admin/`. The service itself listens over HTTP only; put it behind a trusted reverse proxy if HTTPS access is required.

## HTTP API and health

- `GET /api/gallery` returns only public task/feed metadata and current feed selections.
- `GET /healthz` returns unified task/feed status. It returns HTTP 503 with `starting` while an image is missing or `degraded` when any configured age limit is exceeded.
- `GET` and `HEAD` on `/screenshots/:taskId` and `/images/:imageId` return strong `ETag`, `Last-Modified`, `Content-Length`, stale-state headers, and mandatory-revalidation cache policy. Conditional `GET` returns HTTP 304 when the selected image is unchanged.
- `GET /api/config` and `PUT /api/config` require editor authentication. The mutation also requires `X-Requested-With: ha-screenshot`.
- `POST /api/tasks/:id/capture` requires the same authentication and mutation header.

The gallery and editor pages share the same HTTP Basic authentication after setup. Public image, gallery-metadata, and health routes remain unauthenticated so display clients can poll without credentials. Before initial setup, both pages are open so credentials can be created. Keep port 3000 on a trusted network during setup and add network-level access control or an HTTPS reverse proxy when exposing it outside a trusted LAN. HTTP Basic credentials are encoded, not encrypted.

The container bundles pinned Bootstrap 5.3.8 assets, so the gallery and administration UI have no runtime CDN dependency.

## Custom CSS and Home Assistant security

Create named entries in the editor's **Custom CSS** tab when styling should be reused. A task may select one or many entries with `customCssIds`; they are composed in the stored list order. The task's optional CSS file is applied next and its inline `customCss` last, so task-specific rules can override shared rules.

For a file-based style, place the file in the data volume and reference it as `/data/custom.css` in Docker (`./data/custom.css` with the example direct-run environment). All selected CSS is copied into the document and currently open shadow roots. Home Assistant credentials are injected only into storage for the configured Home Assistant origin and never into embedded cross-origin frames, responses, URLs, or screenshots.

## Native eInk image processing

Each task can transform its captured pixels before the last-good image is atomically replaced. Grayscale uses fixed luminance coefficients. Monochrome output supports a direct threshold plus deterministic Floyd–Steinberg or Atkinson error diffusion. Inversion is applied after color reduction, and rotation is applied last.

`width` and `height` always describe the delivered image. For a 90° or 270° rotation, the service swaps the Chromium capture dimensions before rotating, so the final file still has the configured dimensions. Processing failures leave the previous successful image untouched. PNG is recommended for monochrome panels; JPEG remains available with the configured quality but can introduce compression artifacts around hard black-and-white edges.

If Home Assistant runs on the Docker host, `localhost` inside the container is not the host. Docker Desktop users can use `host.docker.internal`. Linux users can add:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

## Development and verification

Node.js 20.9 or newer is required.

```sh
npm ci
npm test
docker compose --env-file .env.example config --no-interpolate
```

The gallery and editor use vendored, same-origin frontend assets and require no
internet access at runtime. See [Frontend assets](docs/frontend-assets.md) for
the pinned Bootstrap version, checksums, licensing, and update procedure.

For direct local execution, install a Chromium binary compatible with the pinned Playwright version and run `npm run start:env`. The supported Docker image already contains the matching browser.

For a real integration check, verify token authentication, exact PNG/JPEG dimensions, independent task rendering options, scheduled switching and fallback behavior, failed-refresh retention, manual capture, and clean shutdown. Never put live credentials in tests or committed fixtures.
