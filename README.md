# Home Assistant dashboard image service

A Dockerized Chromium service that periodically captures Home Assistant dashboards and serves them as unauthenticated images for eInk displays and other polling clients. Capture tasks are independent from scheduled image feeds, so one stable URL can show different dashboard captures throughout the week without creating Chromium work on request.

## Quick start

1. Create a dedicated, non-admin Home Assistant user and a Long-Lived Access Token.
2. Create local configuration files:

   ```sh
   cp .env.example .env
   mkdir -p config
   cp config.example.json config/config.json
   ```

3. Set `HA_URL`, `HA_ACCESS_TOKEN`, and a strong `CONFIG_PASSWORD` in `.env`.
4. Start the service:

   ```sh
   docker compose up -d --build
   ```

5. Open `/admin/` to edit capture tasks and scheduled image URLs, or `/` for the public gallery.

The canonical public routes are:

```text
/screenshots/overview       latest image from one capture task
/images/hallway-display     stable scheduled image feed
```

Both routes are cache-disabled. They return HTTP 503 until the selected task has produced its first successful image. Scheduled image requests only select an existing capture file; they never trigger Chromium.

### Portainer stack

[`compose.portainer.yaml`](compose.portainer.yaml) is a Portainer-friendly stack example that uses a published container image and defines configuration through Portainer stack environment variables. Before deploying it:

1. Publish this repository's image to a registry that the Docker host can pull from.
2. Create an absolute directory on the Docker host, such as `/opt/ha-screenshot/config`.
3. Copy `config.example.json` into that directory as `config.json` and ensure the container user can update the directory and file.
4. In Portainer's stack environment variables, set `HA_SCREENSHOT_IMAGE`, `HA_URL`, `HA_ACCESS_TOKEN`, `CONFIG_PASSWORD`, and `CONFIG_DIRECTORY`. The remaining variables have defaults in the stack file.

For example, `HA_SCREENSHOT_IMAGE` might be `ghcr.io/example/ha-screenshot:latest` and `CONFIG_DIRECTORY` might be `/opt/ha-screenshot/config`. Use the Docker host's path, not a path on the computer running your browser. The configuration directory is a bind mount so it remains straightforward to seed, inspect, and back up; captured images use a named volume.

If Portainer cannot pull a private image, add the registry and its credentials under **Registries** first. The stack publishes port `3000` by default; set `PUBLISHED_PORT` to change only the host-side port.

## Breaking configuration change

This release deliberately removes the task-array configuration and legacy HTTP aliases. `SCREENSHOT_TASKS_FILE`, `/snapshot`, extension-based screenshot routes, `/api/screenshots`, and the old `/api/tasks` configuration API are no longer supported.

Set `CONFIG_FILE` to a writable JSON object containing `tasks` and `images`. Existing installations must convert their old array to the new `tasks` property and update display URLs to the canonical routes above.

### Docker volume mounting

The supported container path is `/config/config.json`. Compose maps the host directory `./config` to `/config` and overrides `CONFIG_FILE` accordingly:

```yaml
environment:
  CONFIG_FILE: /config/config.json
volumes:
  - ./config:/config
```

Mount the **directory**, not only `/config/config.json`. The editor saves atomically by writing a temporary sibling and renaming it over the configuration file, which requires write access to the containing directory. A direct `docker run` deployment can use the same layout with `-v ./config:/config` and `-e CONFIG_FILE=/config/config.json`.

## Configuration

The complete configuration is saved atomically and hot-applied by the web editor:

```json
{
  "tasks": [
    {
      "id": "morning",
      "dashboardPath": "/dashboard-eink/morning",
      "width": 800,
      "height": 480,
      "refreshIntervalSeconds": 300,
      "timezone": "Asia/Bangkok",
      "format": "png"
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

If `CONFIG_FILE` does not exist at startup, the service creates a private bootstrap configuration with empty `tasks` and `images` arrays so the admin editor can be used for initial setup. The same empty bootstrap configuration is accepted on later restarts. Editor updates require at least one task; `images` may be empty. Changes are fully validated before the file or running configuration is replaced. Schedule-only changes preserve running capture services and their current status.

### Scheduled image feeds

Every feed has a URL-safe `id`, a `fallbackTaskId`, and zero or more weekly override slots. A slot contains:

- `days`: one or more of `sun`, `mon`, `tue`, `wed`, `thu`, `fri`, and `sat`;
- `start` and `end`: strict 24-hour `HH:MM` local times;
- `taskId`: the capture task active during the range.

Ranges are start-inclusive and end-exclusive. If the end is earlier than the start, the range continues overnight and `days` names the starting day. Overlapping ranges are rejected, including Sunday-to-Monday overlaps. Outside all ranges, the fallback task is used.

All tasks referenced by one feed must have exactly the same width, height, and format. This guarantees that the feed's dimensions and content type do not change throughout the day.

`IMAGE_SCHEDULE_TIMEZONE` controls weekly schedule selection globally and defaults to `UTC`. This is separate from each task's `timezone`, which controls dates and clocks inside the captured browser page.

### Capture task fields

| Field | Default | Purpose |
| --- | --- | --- |
| `id` | required | URL-safe name containing letters, numbers, `_`, or `-` |
| `dashboardPath` | `/lovelace/0` | Path relative to `HA_URL`, or an absolute dashboard URL |
| `width` / `height` | `800` / `480` | Exact output dimensions in pixels |
| `refreshIntervalSeconds` | `300` | Capture period; `0` means startup only |
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
| `hideCursor` | `true` | Hide the pointer |
| `outputFilename` | derived | Filename under `OUTPUT_DIRECTORY` |

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HA_URL` | required | Home Assistant base URL reachable from the container |
| `HA_ACCESS_TOKEN` | required | Long-lived token, retained server-side |
| `CONFIG_FILE` | required | Combined JSON configuration; `/config/config.json` is the supported container path |
| `IMAGE_SCHEDULE_TIMEZONE` | `UTC` | IANA timezone for every image-feed schedule |
| `CONFIG_USERNAME` | `admin` | HTTP Basic username for the editor and configuration API |
| `CONFIG_PASSWORD` | required | Editor password of at least 12 characters |
| `OUTPUT_DIRECTORY` | `/data` | Persistent capture directory |
| `IGNORE_HTTPS_ERRORS` | `false` | Accept invalid/self-signed Home Assistant TLS certificates |
| `PORT` | `3000` | HTTP listen port |

## HTTP API and health

- `GET /api/gallery` returns only public task/feed metadata and current feed selections.
- `GET /healthz` returns task status plus every feed's active task and readiness. It remains HTTP 503 until every capture task has an image.
- `GET /api/config` and `PUT /api/config` require editor authentication. The mutation also requires `X-Requested-With: ha-screenshot`.
- `POST /api/tasks/:id/capture` requires the same authentication and mutation header.

The public image and health routes remain unauthenticated. Keep port 3000 on a trusted network or add network-level access control. Use HTTPS when accessing the editor outside a trusted LAN because HTTP Basic credentials are encoded, not encrypted.

The frontend loads pinned Bootstrap 5.3.8 assets from jsDelivr with Subresource Integrity. Browsers need access to that CDN for the styled admin and gallery interfaces; image endpoints do not depend on the CDN.

## Custom CSS and Home Assistant security

For substantial capture styling, mount a file under `config/` and reference it as `/config/custom.css` in Docker (`./config/custom.css` for a direct host-side Node run). CSS is copied into the document and currently open shadow roots. Home Assistant credentials are injected only into storage for the configured Home Assistant origin and never into embedded cross-origin frames, responses, URLs, or screenshots.

If Home Assistant runs on the Docker host, `localhost` inside the container is not the host. Docker Desktop users can use `host.docker.internal`. Linux users can add:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

## Development and verification

Node.js 20.6 or newer is required.

```sh
npm ci
npm test
docker compose --env-file .env.example config --no-interpolate
```

For direct local execution, install a Chromium binary compatible with the pinned Playwright version and run `npm run start:env`. The supported Docker image already contains the matching browser.

For a real integration check, verify token authentication, exact PNG/JPEG dimensions, independent task rendering options, scheduled switching and fallback behavior, failed-refresh retention, manual capture, and clean shutdown. Never put live credentials in tests or committed fixtures.
