# TRMNL DIY native four-gray Arduino reference

This sketch is an experimental Arduino replacement for the ESPHome client. It
uses the TRMNL 7.5-inch (OG) DIY Kit's UC8179 grayscale mode and continues to
consume the normal PNG endpoints from `ha-screenshot`.

It provides:

- two cached pages selected by KEY1 and KEY2;
- an immediate download after Wi-Fi connects and polling every five minutes;
- conditional requests using `ETag` and `Last-Modified`;
- retention of each last successfully downloaded image after a failure;
- automatic navigation past pages that return HTTP 404;
- exact four-level quantization into black, dark gray, light gray, and white;
- a text-only battery percentage overlay;
- password-protected ArduinoOTA when an OTA password is configured.

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

The URLs must return non-interlaced 800 x 480 PNG files with a `Content-Length`
header. The service's screenshot and scheduled-feed endpoints satisfy this
contract. Configure each screenshot task with `imageProcessing.mode` set to
`grayscale`, `levels` set to `4`, and preferably `format` set to `png`.

The first boot performs a panel clear before entering grayscale mode, followed
by the first downloaded image. Native four-level refresh is expected to be
considerably slower than the black-and-white ESPHome driver.
