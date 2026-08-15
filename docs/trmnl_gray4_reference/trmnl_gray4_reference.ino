#include <Arduino.h>
#include <ArduinoOTA.h>
#include <HTTPClient.h>
#include <PNGdec.h>
#include <TFT_eSPI.h>
#include <WiFi.h>
#include <esp_heap_caps.h>

#include "secrets.h"

// Edit these two URLs before flashing. /images/<feed-id> URLs work too.
static const char *const IMAGE_URLS[] = {
    "http://192.168.1.50:3000/screenshots/overview",
    "http://192.168.1.50:3000/screenshots/energy",
};

static constexpr char DEVICE_NAME[] = "trmnl-gray4-reference";
static constexpr size_t PAGE_COUNT = sizeof(IMAGE_URLS) / sizeof(IMAGE_URLS[0]);
static constexpr uint16_t DISPLAY_WIDTH = 800;
static constexpr uint16_t DISPLAY_HEIGHT = 480;
static constexpr uint32_t REFRESH_INTERVAL_MS = 5UL * 60UL * 1000UL;
static constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 10UL * 1000UL;
static constexpr uint32_t HTTP_TIMEOUT_MS = 15UL * 1000UL;
static constexpr size_t MAX_PNG_BYTES = 1024UL * 1024UL;

static constexpr uint8_t NEXT_BUTTON_PIN = 2;
static constexpr uint8_t PREVIOUS_BUTTON_PIN = 3;
static constexpr uint8_t BATTERY_ENABLE_PIN = 6;
static constexpr uint8_t BATTERY_ADC_PIN = 1;

struct PageImage {
  const char *url;
  uint8_t *png_data = nullptr;
  size_t png_size = 0;
  String etag;
  String last_modified;
};

struct DecodeContext {
  bool write_to_display;
  bool failed;
};

EPaper epaper;
PNG png;

PageImage pages[PAGE_COUNT];
size_t page_index = 0;
uint32_t last_refresh_ms = 0;
uint32_t last_wifi_attempt_ms = 0;
bool ota_started = false;

bool next_button_was_down = false;
bool previous_button_was_down = false;
uint32_t next_button_changed_ms = 0;
uint32_t previous_button_changed_ms = 0;

static uint8_t clampGrayLevel(uint8_t luminance) {
  // The service's four-level PNG contains 0, 85, 170, and 255. Rounding
  // also makes this work with ordinary grayscale or color PNG input.
  const uint16_t rounded = (static_cast<uint16_t>(luminance) + 42U) / 85U;
  return rounded > 3U ? 3U : static_cast<uint8_t>(rounded);
}

static uint8_t rgb565Luminance(uint16_t pixel) {
  const uint8_t red = ((pixel >> 11U) & 0x1FU) * 255U / 31U;
  const uint8_t green = ((pixel >> 5U) & 0x3FU) * 255U / 63U;
  const uint8_t blue = (pixel & 0x1FU) * 255U / 31U;
  return static_cast<uint8_t>((54U * red + 183U * green + 19U * blue) / 256U);
}

static int drawPngLine(PNGDRAW *draw) {
  auto *context = static_cast<DecodeContext *>(draw->pUser);
  if (draw->iWidth != DISPLAY_WIDTH || draw->y < 0 || draw->y >= DISPLAY_HEIGHT) {
    context->failed = true;
    return 0;
  }

  if (!context->write_to_display) return 1;

  static uint16_t rgb565[DISPLAY_WIDTH];
  alignas(4) static uint8_t packed[DISPLAY_WIDTH / 2];

  png.getLineAsRGB565(draw, rgb565, PNG_RGB565_LITTLE_ENDIAN, 0xFFFFFFFF);
  for (uint16_t x = 0; x < DISPLAY_WIDTH; x += 2) {
    const uint8_t first = clampGrayLevel(rgb565Luminance(rgb565[x]));
    const uint8_t second = clampGrayLevel(rgb565Luminance(rgb565[x + 1]));
    packed[x / 2] = static_cast<uint8_t>((first << 4U) | second);
  }

  // Seeed_GFX accepts two four-bit pixel codes per byte in GRAY_LEVEL4 mode.
  epaper.pushImage(0, draw->y, DISPLAY_WIDTH, 1,
                   reinterpret_cast<uint16_t *>(packed), 4);
  return 1;
}

static bool decodePng(const uint8_t *data, size_t size, bool write_to_display) {
  DecodeContext context{write_to_display, false};
  const int opened = png.openRAM(const_cast<uint8_t *>(data), size, drawPngLine);
  if (opened != PNG_SUCCESS) {
    Serial.printf("PNG open failed: %d\n", opened);
    return false;
  }

  if (png.getWidth() != DISPLAY_WIDTH || png.getHeight() != DISPLAY_HEIGHT) {
    Serial.printf("PNG is %dx%d, expected %ux%u\n", png.getWidth(), png.getHeight(),
                  DISPLAY_WIDTH, DISPLAY_HEIGHT);
    png.close();
    return false;
  }

  const int decoded = png.decode(&context, PNG_FAST_PALETTE);
  png.close();
  if (decoded != PNG_SUCCESS || context.failed) {
    Serial.printf("PNG decode failed: %d\n", decoded);
    return false;
  }
  return true;
}

static int batteryPercent() {
  static constexpr float volts[] = {
      3.27F, 3.30F, 3.41F, 3.49F, 3.58F, 3.68F,
      3.75F, 3.80F, 3.85F, 3.91F, 3.96F, 4.15F,
  };
  static constexpr int percentages[] = {
      0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
  };

  uint32_t millivolts = 0;
  for (uint8_t sample = 0; sample < 16; ++sample) {
    millivolts += analogReadMilliVolts(BATTERY_ADC_PIN);
    delay(2);
  }
  const float voltage = (millivolts / 16.0F) * 2.0F / 1000.0F;

  if (voltage <= volts[0]) return percentages[0];
  const size_t point_count = sizeof(volts) / sizeof(volts[0]);
  if (voltage >= volts[point_count - 1]) return percentages[point_count - 1];

  for (size_t index = 1; index < point_count; ++index) {
    if (voltage <= volts[index]) {
      const float position =
          (voltage - volts[index - 1]) / (volts[index] - volts[index - 1]);
      return static_cast<int>(lroundf(percentages[index - 1] +
                                      position * (percentages[index] - percentages[index - 1])));
    }
  }
  return 0;
}

static void drawBatteryPercentage() {
  const String text = String(batteryPercent()) + "%";
  epaper.fillRect(740, 0, 60, 22, TFT_GRAY_3);
  epaper.setTextColor(TFT_GRAY_0, TFT_GRAY_3);
  epaper.drawRightString(text, 798, 3, 2);
}

static bool renderPage(size_t index) {
  PageImage &page = pages[index];
  if (page.png_data == nullptr || page.png_size == 0) return false;

  Serial.printf("Rendering page %u\n", static_cast<unsigned>(index));
  epaper.fillScreen(TFT_GRAY_3);
  if (!decodePng(page.png_data, page.png_size, true)) return false;
  drawBatteryPercentage();

  const uint32_t started = millis();
  epaper.update();
  Serial.printf("Display refresh completed in %lu ms\n", millis() - started);
  return true;
}

static bool readResponseBody(HTTPClient &http, uint8_t *destination, size_t size) {
  WiFiClient *stream = http.getStreamPtr();
  if (stream == nullptr) return false;

  size_t offset = 0;
  const uint32_t started = millis();
  while (offset < size && millis() - started < HTTP_TIMEOUT_MS) {
    const size_t available = stream->available();
    if (available == 0) {
      if (!http.connected()) break;
      delay(1);
      continue;
    }
    const size_t wanted = min(available, size - offset);
    const int received = stream->read(destination + offset, wanted);
    if (received <= 0) break;
    offset += static_cast<size_t>(received);
  }
  return offset == size;
}

static bool updatePage(size_t index, bool repaint_if_visible) {
  PageImage &page = pages[index];
  HTTPClient http;
  WiFiClient client;
  static const char *response_headers[] = {"ETag", "Last-Modified"};

  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setReuse(false);
  http.collectHeaders(response_headers, 2);
  if (!http.begin(client, page.url)) {
    Serial.printf("Could not start request for page %u\n", static_cast<unsigned>(index));
    return false;
  }
  if (!page.etag.isEmpty()) http.addHeader("If-None-Match", page.etag);
  if (!page.last_modified.isEmpty()) {
    http.addHeader("If-Modified-Since", page.last_modified);
  }

  const int status = http.GET();
  if (status == HTTP_CODE_NOT_MODIFIED) {
    Serial.printf("Page %u unchanged (HTTP 304)\n", static_cast<unsigned>(index));
    http.end();
    return true;
  }
  if (status != HTTP_CODE_OK) {
    Serial.printf("Page %u request failed: HTTP %d\n", static_cast<unsigned>(index), status);
    http.end();
    return false;
  }

  const int content_length = http.getSize();
  if (content_length <= 0 || static_cast<size_t>(content_length) > MAX_PNG_BYTES) {
    Serial.printf("Page %u has invalid Content-Length: %d\n",
                  static_cast<unsigned>(index), content_length);
    http.end();
    return false;
  }

  auto *candidate = static_cast<uint8_t *>(
      heap_caps_malloc(static_cast<size_t>(content_length), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (candidate == nullptr) {
    Serial.printf("Could not allocate %d bytes in PSRAM\n", content_length);
    http.end();
    return false;
  }

  const bool downloaded = readResponseBody(http, candidate, content_length);
  const String new_etag = http.header("ETag");
  const String new_last_modified = http.header("Last-Modified");
  http.end();

  if (!downloaded || !decodePng(candidate, content_length, false)) {
    Serial.printf("Page %u download or validation failed; retaining last image\n",
                  static_cast<unsigned>(index));
    heap_caps_free(candidate);
    return false;
  }

  uint8_t *previous = page.png_data;
  page.png_data = candidate;
  page.png_size = static_cast<size_t>(content_length);
  page.etag = new_etag;
  page.last_modified = new_last_modified;
  if (previous != nullptr) heap_caps_free(previous);

  Serial.printf("Page %u downloaded (%u bytes)\n", static_cast<unsigned>(index),
                static_cast<unsigned>(page.png_size));
  if (repaint_if_visible && index == page_index) return renderPage(index);
  return true;
}

static void updateAllPages() {
  if (WiFi.status() != WL_CONNECTED) return;
  for (size_t index = 0; index < PAGE_COUNT; ++index) {
    updatePage(index, true);
  }
  last_refresh_ms = millis();
}

static void selectPage(int direction) {
  page_index = (page_index + PAGE_COUNT + direction) % PAGE_COUNT;
  if (!renderPage(page_index) && WiFi.status() == WL_CONNECTED) {
    updatePage(page_index, true);
  }
}

static void pollButton(uint8_t pin, bool &was_down, uint32_t &changed_ms, int direction) {
  const bool is_down = digitalRead(pin) == LOW;
  if (is_down != was_down && millis() - changed_ms >= 20) {
    changed_ms = millis();
    was_down = is_down;
    if (is_down) selectPage(direction);
  }
}

static void connectWifi() {
  last_wifi_attempt_ms = millis();
  Serial.printf("Connecting to Wi-Fi SSID %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(DEVICE_NAME);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

static void setupOta() {
  ArduinoOTA.setHostname(DEVICE_NAME);
  if (strlen(OTA_PASSWORD) > 0) ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() { Serial.println("ArduinoOTA update starting"); });
  ArduinoOTA.onEnd([]() { Serial.println("ArduinoOTA update complete"); });
  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("ArduinoOTA error: %u\n", static_cast<unsigned>(error));
  });
  ArduinoOTA.begin();
  ota_started = true;
}

void setup() {
  Serial.begin(115200);
  delay(200);

  for (size_t index = 0; index < PAGE_COUNT; ++index) pages[index].url = IMAGE_URLS[index];

  pinMode(NEXT_BUTTON_PIN, INPUT_PULLUP);
  pinMode(PREVIOUS_BUTTON_PIN, INPUT_PULLUP);
  pinMode(BATTERY_ENABLE_PIN, OUTPUT);
  digitalWrite(BATTERY_ENABLE_PIN, HIGH);
  analogSetPinAttenuation(BATTERY_ADC_PIN, ADC_11db);

  if (!psramFound()) {
    Serial.println("Fatal: OPI PSRAM was not detected");
    while (true) delay(1000);
  }
  Serial.printf("PSRAM available: %u bytes\n", static_cast<unsigned>(ESP.getFreePsram()));

  // Seeed_GFX allocates its display buffers here. Initialize the panel before
  // Wi-Fi so those allocations are not fragmented by networking state.
  epaper.begin();
  epaper.fillScreen(TFT_WHITE);
  epaper.update();
  epaper.initGrayMode(GRAY_LEVEL4);
  epaper.setRotation(0);

  connectWifi();
  const uint32_t connect_started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - connect_started < 30000) {
    delay(100);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Wi-Fi connected: ");
    Serial.println(WiFi.localIP());
    setupOta();
    updateAllPages();
  } else {
    Serial.println("Wi-Fi connection timed out; retrying in the main loop");
  }
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - last_wifi_attempt_ms >= WIFI_RETRY_INTERVAL_MS) connectWifi();
  } else {
    if (!ota_started) {
      Serial.print("Wi-Fi connected: ");
      Serial.println(WiFi.localIP());
      setupOta();
    }
    ArduinoOTA.handle();
    if (last_refresh_ms == 0 || millis() - last_refresh_ms >= REFRESH_INTERVAL_MS) {
      updateAllPages();
    }
  }

  pollButton(NEXT_BUTTON_PIN, next_button_was_down, next_button_changed_ms, 1);
  pollButton(PREVIOUS_BUTTON_PIN, previous_button_was_down,
             previous_button_changed_ms, -1);
  delay(5);
}
