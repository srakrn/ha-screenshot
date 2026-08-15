# Complete ESPHome setup for the TRMNL 7.5-inch (OG) DIY Kit

This is a complete, copy-pasteable ESPHome configuration for Seeed Studio's TRMNL 7.5-inch (OG) DIY Kit. It displays two 800 x 480 images from this service, switches pages with KEY1 and KEY2, and overlays a compact battery indicator. The ESP32 stores no Home Assistant token or editor password.

For experimental native four-level grayscale, see the
[Arduino reference sketch](trmnl_gray4_reference/README.md). ESPHome's built-in
Waveshare driver renders this panel in black and white only.

The GPIO assignments and display driver are specific to this kit. Do not flash this file unchanged onto another e-paper board.

## 1. Create the screenshot tasks

Create two tasks in this service. Each must use the panel's exact size and PNG format. For example:

```json
{
  "id": "overview",
  "dashboardPath": "/dashboard-eink/overview",
  "width": 800,
  "height": 480,
  "refreshIntervalSeconds": 300,
  "format": "png"
}
```

Create the second task with an ID such as `energy`. Wait for both tasks to capture successfully, then verify these URLs in a browser on the same LAN as the ESP32:

```text
http://192.168.1.50:3000/screenshots/overview
http://192.168.1.50:3000/screenshots/energy
```

Replace `192.168.1.50` with the fixed LAN address or local DNS name of the screenshot server. Do not use `localhost`, because that means the ESP32 itself. The endpoints return HTTP 503 until their first captures succeed.

A scheduled feed can replace either URL. Change that image's `url` to `${screenshot_server}/images/<image-id>` when the server should select the task from a weekly schedule. Fetching either endpoint never starts Chromium work.

## 2. Copy the complete device YAML

Download or copy [the example ESPHome device file](esphome-trmnl-diy-kit.example.yaml) to `esphome-trmnl-diy-kit.yaml`. It requires ESPHome 2026.7.0 or newer and uses the current `image` platform syntax.

Only these substitutions normally need editing:

```yaml
substitutions:
  device_name: trmnl-ha-display
  friendly_name: TRMNL Home Assistant Display
  screenshot_server: "http://192.168.1.50:3000"
  first_task_id: overview
  second_task_id: energy
```

The file includes all required top-level sections: `esphome`, ESP32/Arduino, PSRAM, logger, encrypted Home Assistant API, OTA, Wi-Fi fallback, captive portal, HTTP client, online PNG images, font, page state, battery sensing, physical buttons, SPI, and the Waveshare display driver. Do not paste it below an ESPHome-generated skeleton; use it as the device file so top-level keys are not duplicated.

## 3. Add ESPHome secrets

Copy [the secrets example](esphome-secrets.example.yaml) to `secrets.yaml` in the same ESPHome configuration directory, then replace every placeholder:

```yaml
wifi_ssid: "YOUR_WIFI_NAME"
wifi_password: "YOUR_WIFI_PASSWORD"
api_encryption_key: "YOUR_32_BYTE_BASE64_ESPHOME_API_KEY"
ota_password: "YOUR_OTA_PASSWORD"
fallback_hotspot_password: "YOUR_FALLBACK_HOTSPOT_PASSWORD"
```

ESPHome Device Builder can generate the API encryption key and OTA password when it creates a device. Reuse those generated values if you already created one.

## 4. Validate and install

From an ESPHome command-line installation, validate before flashing:

```sh
esphome config esphome-trmnl-diy-kit.yaml
esphome run esphome-trmnl-diy-kit.yaml
```

With the Home Assistant ESPHome Device Builder, place the complete YAML in the device editor, place the secret values in the Device Builder secrets editor, select **Install**, and follow its USB or wireless installation flow.

At runtime, the ESP32 polls each URL every five minutes. This service supplies `ETag` and `Last-Modified`; ESPHome sends conditional requests and avoids downloading or repainting an unchanged image after HTTP 304. A newly downloaded image repaints only if its page is visible. KEY1 selects the next page and KEY2 selects the previous page.

The example intentionally stays awake so its buttons and five-minute polling remain responsive. It does not enable deep sleep.

## Troubleshooting

- `HTTP 503`: the selected screenshot task has not completed its first successful capture. Check this service's gallery and logs.
- `HTTP 404`: the task/feed ID in the ESPHome URL does not match the configured ID.
- Connection failure: confirm the ESP32 can reach the server address on port 3000 and that client isolation is disabled on the Wi-Fi network.
- Blank or partial image: confirm the task is exactly 800 x 480 PNG and that PSRAM is enabled.
- Compile error around `platform: online_image`: upgrade ESPHome to 2026.7.0 or newer.
- Display never finishes refreshing: confirm the BUSY pin is GPIO4 with `inverted: true`; the inversion is required for this panel family.

The image endpoints are deliberately unauthenticated. Keep port 3000 on a trusted LAN or behind appropriate network access controls.
