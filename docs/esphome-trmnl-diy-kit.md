# ESPHome setup for the TRMNL 7.5-inch (OG) DIY Kit

This guide connects the [Seeed Studio TRMNL 7.5-inch (OG) DIY Kit](https://wiki.seeedstudio.com/ogdiy_kit_works_with_esphome/) to this service. It combines Seeed's Demo 1 online-image approach with Demo 3's physical page buttons and battery measurement.

The example provides:

- two full-screen, remotely updated Home Assistant dashboard images;
- KEY1 and KEY2 navigation between the images;
- a compact 70 x 18 pixel battery badge in the upper-right corner; and
- no Home Assistant token or editor password on the ESPHome device.

The instructions and GPIO assignments are specific to the Seeed kit. Do not use them unchanged with another e-paper driver board.

## 1. Prepare the screenshot service

Create one capture task for each page that should be selectable on the display. Each task must use the panel's exact dimensions and PNG format:

```json
{
  "id": "overview",
  "dashboardPath": "/dashboard-eink/overview",
  "width": 800,
  "height": 480,
  "refreshIntervalSeconds": 300,
  "maximumImageAgeSeconds": 900,
  "format": "png"
}
```

For a second page, create another task such as `energy`. Once both tasks have completed their first capture, open these URLs from another device on the same network:

```text
http://192.168.1.50:3000/screenshots/overview
http://192.168.1.50:3000/screenshots/energy
```

Replace `192.168.1.50` with the LAN address of the machine running this service. Use an address that the ESP32 can resolve and reach; `localhost` would refer to the ESP32 itself. A fixed address or local DNS reservation prevents the display configuration from breaking when the server's address changes.

A scheduled image feed also works:

```text
http://192.168.1.50:3000/images/kitchen
```

Use `/screenshots/<task-id>` when a physical page must always show one task. Use `/images/<image-id>` when the server should change that page automatically according to a weekly schedule. Both endpoints are intentionally unauthenticated and do not start capture work when fetched. They require revalidation on every poll and use standard `ETag` and `Last-Modified` validators, allowing ESPHome to receive HTTP 304 without downloading an unchanged PNG.

The endpoint returns HTTP 503 until its task has produced a first successful image. Finish configuring the screenshot service and confirm both URLs in a browser before troubleshooting ESPHome.

## 2. Create the ESPHome device

Follow Seeed's cookbook through creation and initial installation of a basic ESPHome device. Keep the generated `esphome`, `logger`, `api`, `ota`, `wifi`, and `captive_portal` sections, including their generated secrets.

The ESP32 framework must be Arduino for this configuration. Add or update these sections near the top of the device YAML:

```yaml
esp32:
  board: esp32-s3-devkitc-1
  framework:
    type: arduino

# Decoding an 800 x 480 online PNG needs PSRAM.
psram:
  mode: octal
  speed: 80MHz
```

Do not duplicate an existing `esp32:` section. Merge these values into it instead.

## 3. Add online images, buttons, and battery status

Add the following after `captive_portal:`. Change both URLs to the URLs verified in step 1.

The `image`/`platform: online_image` form requires ESPHome 2026.7 or newer. Upgrade ESPHome Device Builder if it is older. If an immediate upgrade is not possible, change the `image:` key below to `online_image:` and remove both `platform: online_image` lines; that legacy spelling remains compatible through ESPHome 2027.1.

```yaml
http_request:
  # Required by ESPHome's HTTP client when using the Arduino framework.
  # The example URLs use plain HTTP on a trusted LAN.
  verify_ssl: false
  timeout: 15s
  watchdog_timeout: 20s

image:
  - platform: online_image
    id: overview_image
    url: "http://192.168.1.50:3000/screenshots/overview"
    format: PNG
    type: BINARY
    buffer_size: 30000
    update_interval: 5min
    on_download_finished:
      then:
        # A 304 response is a cache hit. Repaint only for a newly downloaded
        # image that is currently visible.
        - if:
            condition:
              lambda: return !cached && id(page_index) == 0;
            then:
              - component.update: epaper_display

  - platform: online_image
    id: energy_image
    url: "http://192.168.1.50:3000/screenshots/energy"
    format: PNG
    type: BINARY
    buffer_size: 30000
    update_interval: 5min
    on_download_finished:
      then:
        - if:
            condition:
              lambda: return !cached && id(page_index) == 1;
            then:
              - component.update: epaper_display

font:
  - file: "gfonts://Inter@700"
    id: battery_font
    size: 12

globals:
  - id: page_index
    type: int
    restore_value: false
    initial_value: "0"

output:
  # Enables the kit's battery-voltage divider.
  - platform: gpio
    pin: GPIO6
    id: battery_measurement_enable

sensor:
  - platform: adc
    pin: GPIO1
    id: battery_voltage
    name: "E-paper battery voltage"
    attenuation: 12db
    update_interval: 60s
    filters:
      - multiply: 2.0

  - platform: template
    id: battery_level
    name: "E-paper battery level"
    unit_of_measurement: "%"
    device_class: battery
    state_class: measurement
    accuracy_decimals: 0
    update_interval: 60s
    lambda: return id(battery_voltage).state;
    filters:
      # Approximate Li-ion discharge curve from Seeed's Demo 3.
      - calibrate_linear:
          method: exact
          datapoints:
            - 3.27 -> 0.0
            - 3.30 -> 5.0
            - 3.41 -> 10.0
            - 3.49 -> 20.0
            - 3.58 -> 30.0
            - 3.68 -> 40.0
            - 3.75 -> 50.0
            - 3.80 -> 60.0
            - 3.85 -> 70.0
            - 3.91 -> 80.0
            - 3.96 -> 90.0
            - 4.15 -> 100.0
      - clamp:
          min_value: 0
          max_value: 100

binary_sensor:
  - platform: gpio
    id: key1
    name: "E-paper next page"
    pin:
      number: GPIO2
      mode: INPUT_PULLUP
      inverted: true
    filters:
      - delayed_on: 20ms
    on_press:
      then:
        - lambda: id(page_index) = (id(page_index) + 1) % 2;
        - component.update: epaper_display

  - platform: gpio
    id: key2
    name: "E-paper previous page"
    pin:
      number: GPIO3
      mode: INPUT_PULLUP
      inverted: true
    filters:
      - delayed_on: 20ms
    on_press:
      then:
        - lambda: id(page_index) = (id(page_index) - 1 + 2) % 2;
        - component.update: epaper_display

spi:
  clk_pin: GPIO7
  mosi_pin: GPIO9

display:
  - platform: waveshare_epaper
    id: epaper_display
    model: 7.50inv2
    cs_pin: GPIO44
    dc_pin: GPIO10
    reset_pin: GPIO38
    busy_pin:
      number: GPIO4
      inverted: true
    update_interval: never
    lambda: |-
      if (id(page_index) == 0) {
        it.image(0, 0, id(overview_image));
      } else {
        it.image(0, 0, id(energy_image));
      }

      // A small opaque badge keeps the reading legible over any screenshot.
      const int badge_x = 730;
      const int badge_w = 70;
      it.filled_rectangle(badge_x, 0, badge_w, 18, COLOR_OFF);

      if (!isnan(id(battery_level).state)) {
        int pct = (int) roundf(id(battery_level).state);
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        const int fill_w = pct * 16 / 100;

        // 22 x 10 px battery outline and terminal.
        it.rectangle(733, 4, 20, 10, COLOR_ON);
        it.filled_rectangle(753, 7, 2, 4, COLOR_ON);
        if (fill_w > 0) {
          it.filled_rectangle(735, 6, fill_w, 6, COLOR_ON);
        }
        it.printf(798, 2, id(battery_font), COLOR_ON,
                  TextAlign::TOP_RIGHT, "%d%%", pct);
      }
```

Finally, enable the battery measurement circuit when the device starts. Merge this automation into the existing `esphome:` section:

```yaml
esphome:
  # Keep the existing name and friendly_name here.
  on_boot:
    priority: 600
    then:
      - output.turn_on: battery_measurement_enable
      - delay: 200ms
      - component.update: battery_voltage
      - component.update: battery_level
```

If `esphome.on_boot` already exists, append these actions rather than adding a second `esphome:` key.

This is the same online-image behavior as Seeed's Demo 1, expressed using current ESPHome syntax.

## 4. Install and test

Validate and install the configuration from ESPHome Device Builder. For the first test, power the kit over USB so Wi-Fi activity and repeated e-paper refreshes do not complicate battery diagnosis.

Expected behavior:

1. Each online image is checked every five minutes. ESPHome sends the validators from the previous response.
2. An unchanged image receives HTTP 304, transfers no PNG body, and does not refresh the panel. A fresh download refreshes the panel only if that image is currently visible.
3. KEY1 selects the next page and KEY2 selects the previous page.
4. The server keeps generating screenshots on its own schedule; fetching an image never launches Chromium.
5. If an image download fails, the display keeps its e-paper contents and retries at the next interval.

The 70 x 18 pixel battery badge intentionally paints a white background over the screenshot. Keep the upper-right corner of the Home Assistant dashboard empty if masking those pixels is undesirable. Alternatively, remove the `filled_rectangle` call, but the status may become difficult to read over dark or detailed content.

## Refresh and power considerations

The screenshot service and ESPHome have independent intervals. A sensible starting point is five minutes for both `refreshIntervalSeconds` and `image.update_interval`, with `maximumImageAgeSeconds` set comfortably above the capture interval (for example, 15 minutes). Shorter ESPHome polling does not make the server capture faster, although conditional polling makes unchanged checks inexpensive.

ESPHome's `online_image` cache validators live in memory and are reset when the device reboots. The first request after boot therefore downloads the full PNG; later unchanged polls receive HTTP 304. The `cached` variable in `on_download_finished` is `true` for those cache hits, which is why the example avoids an unnecessary e-paper refresh.

Every page press performs a full panel update. E-paper updates are slow and consume much more power than retaining an image, so avoid rapid button presses and very short update intervals.

Seeed's deep-sleep Demo 2 is not included here. A sleeping ESP32 cannot respond immediately to KEY1 and KEY2 unless the wake pins and post-wake page-selection behavior are designed for that mode. Get image download and page navigation working on USB power before adding deep sleep.

## Troubleshooting

- **The display is blank:** open each image URL in a browser and confirm it returns a PNG rather than HTTP 503 or 404. Then inspect the ESPHome logs for HTTP or PNG decoder errors.
- **The ESP32 cannot connect:** use the screenshot server's LAN IP address, confirm both devices are on networks that may communicate, and allow TCP port 3000 through the host firewall.
- **The image is cropped or distorted:** configure every referenced screenshot task as exactly 800 x 480. Keep `deviceScaleFactor` unchanged in this service.
- **The image colors look wrong:** this panel is monochrome. Prefer a high-contrast Home Assistant theme or task-specific `customCss`; ESPHome converts the PNG to its binary image representation.
- **Battery percentage is inaccurate:** the table is an estimate. Compare `E-paper battery voltage` with a trusted meter and tune the calibration points for the installed battery.
- **Compilation runs out of memory:** confirm the `psram` block is present and that both images use `type: BINARY`, not an RGB type.
- **HTTPS fails:** the Arduino HTTP client in this example does not validate TLS. Prefer plain HTTP on a trusted, isolated LAN or put the service behind a network design appropriate for the deployment; do not place credentials in image URLs.

## Adding more pages

For each additional page:

1. add another `platform: online_image` entry with a unique ID and URL;
2. add a matching branch in the display lambda;
3. change both button expressions from `% 2` to `% N`, where `N` is the total page count; and
4. update the `on_download_finished` page-index check for the new image.

All referenced images should remain 800 x 480 PNGs so page changes never alter the panel geometry or decoder format.
