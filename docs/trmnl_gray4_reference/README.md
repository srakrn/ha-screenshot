# TRMNL DIY native four-gray Arduino reference

This sketch is an experimental Arduino replacement for the ESPHome client. It
uses the TRMNL 7.5-inch (OG) DIY Kit's UC8179 grayscale mode and continues to
consume the normal PNG endpoints from `ha-screenshot`.

It provides:

- deep sleep between updates, with a five-minute timer wake;
- any number of pages, with KEY1 waking and moving forward and KEY2 waking and moving backward;
- a KEY3 wake that immediately cache-bypasses, re-fetches, and repaints the current page;
- Wi-Fi shutdown after each short fetch cycle;
- conditional requests using `ETag` and `Last-Modified`;
- retention of the last successfully displayed e-paper image after a failure;
- automatic navigation past pages that return HTTP 404;
- exact four-level quantization into black, dark gray, light gray, and white;
- a transparent text-only battery percentage overlay in the lower-right corner;
- battery-divider power only while a measurement is being taken.

It intentionally does not implement ESPHome's native API, entities, fallback
portal, or encrypted OTA protocol. Serial logging is the primary diagnostic
interface.

## Required libraries

Install these libraries in Arduino IDE:

- [Seeed_GFX](https://github.com/Seeed-Studio/Seeed_GFX)
- [PNGdec](https://github.com/bitbank2/PNGdec)

Use the **XIAO ESP32S3 Plus** board (`XIAO_ESP32S3_PLUS`) and select
**Tools > PSRAM > OPI PSRAM**. The ordinary XIAO ESP32S3 board target is not the
correct target for the TRMNL DIY Kit. The sketch checks for PSRAM at boot and
stops with the required settings in its diagnostic message if it is unavailable.

## Configure and flash

1. Copy `secrets.example.h` to `secrets.h` in this directory and configure the
   device name, image URLs, Wi-Fi credentials, and OTA password. Add or remove
   URL entries to change the number of pages. Do not commit `secrets.h`.
2. Open `trmnl_gray4_reference.ino` in Arduino IDE.
3. Confirm that `driver.h` and `secrets.h` are shown as other tabs in the same
   sketch.
4. Compile and upload over USB.
5. Open the serial monitor at 115200 baud for download, PNG decode, memory, and
   refresh diagnostics.

Firmware updates are USB-only; the sketch does not include ArduinoOTA.

Deep sleep resets the processor and discards PSRAM, while the e-paper panel keeps
showing its last image without power. The current page and its HTTP validators
are retained in RTC memory. A timer wake can therefore accept HTTP 304 and go
straight back to sleep without refreshing the panel. A page-button wake must
download the newly selected page before displaying it, so page changes are not
instantaneous. If a request, decode, or refresh fails, the panel keeps showing
its previous successful image and the sketch retries after the next wake.

The URLs must return non-interlaced 800 x 480 PNG files with a `Content-Length`
header. The service's screenshot and scheduled-feed endpoints satisfy this
contract. Configure each screenshot task with `imageProcessing.mode` set to
`grayscale`, `levels` set to `4`, and preferably `format` set to `png`.

The first boot performs a panel clear before entering grayscale mode, followed
by the first downloaded image. Native four-level refresh is expected to be
considerably slower than the black-and-white ESPHome driver.
