#include <Arduino.h>
#include <HTTPClient.h>
#include <PNGdec.h>
#include <TFT_eSPI.h>
#include <WiFi.h>
#include <driver/rtc_io.h>
#include <esp_heap_caps.h>
#include <esp_sleep.h>

#include "secrets.h"

static constexpr size_t PAGE_COUNT = sizeof(IMAGE_URLS) / sizeof(IMAGE_URLS[0]);
static constexpr uint16_t DISPLAY_WIDTH = 800;
static constexpr uint16_t DISPLAY_HEIGHT = 480;
static constexpr uint64_t REFRESH_INTERVAL_US = 5ULL * 60ULL * 1000ULL * 1000ULL;
static constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 30UL * 1000UL;
static constexpr uint32_t HTTP_TIMEOUT_MS = 15UL * 1000UL;
static constexpr size_t MAX_PNG_BYTES = 1024UL * 1024UL;

static constexpr uint8_t NEXT_BUTTON_PIN = 2;
static constexpr uint8_t PREVIOUS_BUTTON_PIN = 3;
static constexpr uint8_t REFRESH_BUTTON_PIN = 5;
static constexpr uint8_t BATTERY_ENABLE_PIN = 6;
static constexpr uint8_t BATTERY_ADC_PIN = 1;
static constexpr uint32_t RETAINED_STATE_MAGIC = 0x48534734UL;
static constexpr size_t ETAG_CAPACITY = 128;
static constexpr size_t LAST_MODIFIED_CAPACITY = 64;

struct DecodeContext {
  bool write_to_display;
  bool failed;
};

struct RetainedState {
  uint32_t magic;
  size_t page_index;
  bool needs_panel_clear;
  char etag[ETAG_CAPACITY];
  char last_modified[LAST_MODIFIED_CAPACITY];
};

enum class FetchResult {
  UPDATED,
  NOT_MODIFIED,
  NOT_FOUND,
  FAILED,
};

RTC_DATA_ATTR RetainedState retained_state{};

EPaper epaper;
PNG png;

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

  digitalWrite(BATTERY_ENABLE_PIN, HIGH);
  delay(10);
  uint32_t millivolts = 0;
  for (uint8_t sample = 0; sample < 16; ++sample) {
    millivolts += analogReadMilliVolts(BATTERY_ADC_PIN);
    delay(2);
  }
  digitalWrite(BATTERY_ENABLE_PIN, LOW);

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
  epaper.setTextColor(TFT_GRAY_0);
  epaper.drawRightString(text, DISPLAY_WIDTH - 2, DISPLAY_HEIGHT - 18, 2);
}

static bool renderPage(const uint8_t *data, size_t size, size_t index) {
  Serial.printf("Initialising e-paper for page %u\n", static_cast<unsigned>(index));
  epaper.begin();
  if (retained_state.needs_panel_clear) {
    Serial.println("Performing the first-boot panel clear");
    epaper.fillScreen(TFT_WHITE);
    epaper.update();
    retained_state.needs_panel_clear = false;
  }
  epaper.initGrayMode(GRAY_LEVEL4);
  epaper.setRotation(0);
  epaper.fillScreen(TFT_GRAY_3);
  if (!decodePng(data, size, true)) return false;
  drawBatteryPercentage();

  const uint32_t started = millis();
  epaper.update();
  // Seeed_GFX puts the display controller to sleep at the end of update().
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

static void clearValidators() {
  retained_state.etag[0] = '\0';
  retained_state.last_modified[0] = '\0';
}

static void retainValidator(char *destination, size_t capacity, const String &value) {
  value.toCharArray(destination, capacity);
}

static FetchResult fetchPage(size_t index, bool allow_not_modified) {
  HTTPClient http;
  WiFiClient client;
  static const char *response_headers[] = {"ETag", "Last-Modified"};

  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setReuse(false);
  http.collectHeaders(response_headers, 2);
  if (!http.begin(client, IMAGE_URLS[index])) {
    Serial.printf("Could not start request for page %u\n", static_cast<unsigned>(index));
    return FetchResult::FAILED;
  }

  if (allow_not_modified) {
    if (retained_state.etag[0] != '\0') {
      http.addHeader("If-None-Match", retained_state.etag);
    }
    if (retained_state.last_modified[0] != '\0') {
      http.addHeader("If-Modified-Since", retained_state.last_modified);
    }
  } else {
    http.addHeader("Cache-Control", "no-cache, no-store, max-age=0");
    http.addHeader("Pragma", "no-cache");
  }

  const int status = http.GET();
  if (status == HTTP_CODE_NOT_MODIFIED) {
    Serial.printf("Page %u unchanged (HTTP 304); retaining the e-paper image\n",
                  static_cast<unsigned>(index));
    http.end();
    return FetchResult::NOT_MODIFIED;
  }
  if (status == HTTP_CODE_NOT_FOUND) {
    Serial.printf("Page %u unavailable (HTTP 404)\n", static_cast<unsigned>(index));
    http.end();
    return FetchResult::NOT_FOUND;
  }
  if (status != HTTP_CODE_OK) {
    Serial.printf("Page %u request failed: HTTP %d\n", static_cast<unsigned>(index), status);
    http.end();
    return FetchResult::FAILED;
  }

  const int content_length = http.getSize();
  if (content_length <= 0 || static_cast<size_t>(content_length) > MAX_PNG_BYTES) {
    Serial.printf("Page %u has invalid Content-Length: %d\n",
                  static_cast<unsigned>(index), content_length);
    http.end();
    return FetchResult::FAILED;
  }

  auto *candidate = static_cast<uint8_t *>(
      heap_caps_malloc(static_cast<size_t>(content_length), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (candidate == nullptr) {
    Serial.printf("Could not allocate %d bytes in PSRAM\n", content_length);
    http.end();
    return FetchResult::FAILED;
  }

  const bool downloaded = readResponseBody(http, candidate, content_length);
  const String new_etag = http.header("ETag");
  const String new_last_modified = http.header("Last-Modified");
  http.end();

  if (!downloaded || !decodePng(candidate, content_length, false)) {
    Serial.printf("Page %u download or validation failed; retaining the e-paper image\n",
                  static_cast<unsigned>(index));
    heap_caps_free(candidate);
    return FetchResult::FAILED;
  }

  Serial.printf("Page %u downloaded (%d bytes)\n", static_cast<unsigned>(index), content_length);
  const bool rendered = renderPage(candidate, static_cast<size_t>(content_length), index);
  heap_caps_free(candidate);
  if (!rendered) {
    Serial.println("Display render failed; retained HTTP validators were not changed");
    return FetchResult::FAILED;
  }

  retained_state.page_index = index;
  retainValidator(retained_state.etag, sizeof(retained_state.etag), new_etag);
  retainValidator(retained_state.last_modified, sizeof(retained_state.last_modified),
                  new_last_modified);
  return FetchResult::UPDATED;
}

static bool connectWifi() {
  Serial.printf("Connecting to Wi-Fi SSID %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(DEVICE_NAME);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_CONNECT_TIMEOUT_MS) {
    delay(100);
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi connection timed out; retaining the e-paper image");
    return false;
  }

  Serial.print("Wi-Fi connected: ");
  Serial.println(WiFi.localIP());
  return true;
}

static uint64_t buttonMask() {
  return (1ULL << NEXT_BUTTON_PIN) |
         (1ULL << PREVIOUS_BUTTON_PIN) |
         (1ULL << REFRESH_BUTTON_PIN);
}

static void prepareButtonWakeup(uint8_t pin, uint64_t &wake_mask) {
  // Do not arm a button that is still held, which would cause an immediate
  // wake-sleep loop. It will be armed again after the next timer wake.
  if (digitalRead(pin) == HIGH) wake_mask |= 1ULL << pin;
  rtc_gpio_pullup_en(static_cast<gpio_num_t>(pin));
  rtc_gpio_pulldown_dis(static_cast<gpio_num_t>(pin));
}

static void enterDeepSleep() {
  WiFi.disconnect(true, false);
  WiFi.mode(WIFI_OFF);

  digitalWrite(BATTERY_ENABLE_PIN, LOW);
  rtc_gpio_hold_en(static_cast<gpio_num_t>(BATTERY_ENABLE_PIN));

  esp_sleep_enable_timer_wakeup(REFRESH_INTERVAL_US);
  uint64_t wake_mask = 0;
  prepareButtonWakeup(NEXT_BUTTON_PIN, wake_mask);
  prepareButtonWakeup(PREVIOUS_BUTTON_PIN, wake_mask);
  prepareButtonWakeup(REFRESH_BUTTON_PIN, wake_mask);
  if (wake_mask != 0) {
    esp_sleep_enable_ext1_wakeup(wake_mask, ESP_EXT1_WAKEUP_ANY_LOW);
  }

  Serial.println("Entering deep sleep; timer and released buttons are armed");
  Serial.flush();
  delay(10);
  esp_deep_sleep_start();
  while (true) delay(1000);
}

static void resetRetainedState() {
  retained_state.magic = RETAINED_STATE_MAGIC;
  retained_state.page_index = 0;
  retained_state.needs_panel_clear = true;
  clearValidators();
}

static bool selectAndFetchPage(int direction) {
  const size_t original_index = retained_state.page_index;
  for (size_t offset = 1; offset <= PAGE_COUNT; ++offset) {
    const size_t candidate = direction > 0
                                 ? (original_index + offset) % PAGE_COUNT
                                 : (original_index + PAGE_COUNT - (offset % PAGE_COUNT)) % PAGE_COUNT;
    const FetchResult result = fetchPage(candidate, false);
    if (result == FetchResult::UPDATED) return true;
    if (result != FetchResult::NOT_FOUND) break;
  }
  Serial.println("No replacement page was displayed; retaining the current e-paper image");
  return false;
}

void setup() {
  Serial.begin(115200);
  delay(200);

  rtc_gpio_hold_dis(static_cast<gpio_num_t>(BATTERY_ENABLE_PIN));
  pinMode(NEXT_BUTTON_PIN, INPUT_PULLUP);
  pinMode(PREVIOUS_BUTTON_PIN, INPUT_PULLUP);
  pinMode(REFRESH_BUTTON_PIN, INPUT_PULLUP);
  pinMode(BATTERY_ENABLE_PIN, OUTPUT);
  digitalWrite(BATTERY_ENABLE_PIN, LOW);
  analogSetPinAttenuation(BATTERY_ADC_PIN, ADC_11db);

  const esp_sleep_wakeup_cause_t wake_cause = esp_sleep_get_wakeup_cause();
  if (retained_state.magic != RETAINED_STATE_MAGIC || retained_state.page_index >= PAGE_COUNT ||
      wake_cause == ESP_SLEEP_WAKEUP_UNDEFINED) {
    resetRetainedState();
  }

  if (!psramFound()) {
    Serial.println("Fatal: OPI PSRAM was not detected. In Arduino IDE select");
    Serial.println("Tools > Board > XIAO ESP32S3 Plus, then Tools > PSRAM > OPI PSRAM,");
    Serial.println("recompile, and upload again.");
    enterDeepSleep();
  }
  Serial.printf("PSRAM available: %u bytes\n", static_cast<unsigned>(ESP.getFreePsram()));

  if (!connectWifi()) enterDeepSleep();

  if (wake_cause == ESP_SLEEP_WAKEUP_EXT1) {
    const uint64_t wake_status = esp_sleep_get_ext1_wakeup_status() & buttonMask();
    if ((wake_status & (1ULL << NEXT_BUTTON_PIN)) != 0) {
      Serial.println("Next-page button wake");
      selectAndFetchPage(1);
    } else if ((wake_status & (1ULL << PREVIOUS_BUTTON_PIN)) != 0) {
      Serial.println("Previous-page button wake");
      selectAndFetchPage(-1);
    } else {
      Serial.println("Refresh-button wake");
      fetchPage(retained_state.page_index, false);
    }
  } else {
    const bool allow_not_modified = wake_cause == ESP_SLEEP_WAKEUP_TIMER;
    Serial.println(allow_not_modified ? "Timer wake" : "Cold boot or manual reset");
    const FetchResult result = fetchPage(retained_state.page_index, allow_not_modified);
    if (result == FetchResult::NOT_FOUND) selectAndFetchPage(1);
  }

  enterDeepSleep();
}

void loop() {
  // setup() always enters deep sleep.
}
