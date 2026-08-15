#pragma once

static constexpr char DEVICE_NAME[] = "trmnl-gray4-reference";

// Add or remove entries as needed. /images/<feed-id> URLs work too.
static const char *const IMAGE_URLS[] = {
    "http://192.168.1.50:3000/screenshots/overview",
    "http://192.168.1.50:3000/screenshots/energy",
};

#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Leave empty to disable password protection for ArduinoOTA.
#define OTA_PASSWORD "YOUR_OTA_PASSWORD"
