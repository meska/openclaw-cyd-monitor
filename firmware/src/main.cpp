#include <Arduino.h>
#include <ArduinoOTA.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <XPT2046_Touchscreen.h>

// Pinout standard del Cheap Yellow Display ESP32-2432S028R.
constexpr uint8_t TOUCH_IRQ = 36;
constexpr uint8_t TOUCH_MOSI = 32;
constexpr uint8_t TOUCH_MISO = 39;
constexpr uint8_t TOUCH_CLK = 25;
constexpr uint8_t TOUCH_CS = 33;
constexpr uint8_t BACKLIGHT = 21;

constexpr uint16_t COLOR_BG = 0x0863;
constexpr uint16_t COLOR_PANEL = 0x10C5;
constexpr uint16_t COLOR_PANEL_EDGE = 0x2949;
constexpr uint16_t COLOR_CORAL = 0xFB8C;
constexpr uint16_t COLOR_ORANGE = 0xFD64;
constexpr uint16_t COLOR_MINT = 0x77F1;
constexpr uint16_t COLOR_WARN = 0xFEC4;
constexpr uint16_t COLOR_MUTED = 0x9D15;
constexpr uint16_t COLOR_WHITE = 0xEF9E;
constexpr uint16_t COLOR_RED = 0xF9E7;

constexpr unsigned long FETCH_INTERVAL_MS = 5000;
constexpr unsigned long DRAW_INTERVAL_MS = 500;
constexpr unsigned long OTA_ARM_HOLD_MS = 2000;
constexpr unsigned long OTA_WINDOW_MS = 120000;

struct MonitorStatus {
  bool valid = false;
  bool online = false;
  bool stale = false;
  int latencyMs = 0;
  int sessions = 0;
  int recentSessions = 0;
  int activeSessions = 0;
  int activeTasks = 0;
  int taskFailures = 0;
  int agents = 0;
  int heartbeatAgents = 0;
  int queuedEvents = 0;
  int degradedPlugins = 0;
  int workboardTriage = 0;
  int workboardRunning = 0;
  int workboardBlocked = 0;
  String model = "unknown";
  String version = "unknown";
};

TFT_eSPI display;
SPIClass touchSpi(VSPI);
XPT2046_Touchscreen touch(TOUCH_CS, TOUCH_IRQ);
Preferences preferences;
MonitorStatus status;

String bridgeUrl;
uint8_t page = 0;
unsigned long lastFetch = 0;
unsigned long lastDraw = 0;
unsigned long lastTouch = 0;
unsigned long otaArmStarted = 0;
unsigned long otaWindowUntil = 0;
bool otaUpdateInProgress = false;
bool otaServiceRunning = false;
bool drawLayout = true;
bool screenNeedsClear = false;

void drawHeader();
void drawFooter();
void drawHome();
void drawPulse();
void drawDevice();
void drawScreen(bool clear = false);
void drawMascot(int x, int y, bool happy, uint8_t frame);

bool otaWindowActive() {
  return otaWindowUntil != 0 && static_cast<long>(otaWindowUntil - millis()) > 0;
}

void openOtaWindow() {
  if (!otaServiceRunning) {
    ArduinoOTA.begin();
    otaServiceRunning = true;
  }
  otaWindowUntil = millis() + OTA_WINDOW_MS;
  otaArmStarted = 0;
  drawScreen();
}

String endpointUrl() {
  String base = bridgeUrl;
  while (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  return base + "/api/status";
}

void drawPanel(int x, int y, int width, int height) {
  if (!drawLayout) return;
  display.fillRoundRect(x, y, width, height, 4, COLOR_PANEL);
  display.drawRoundRect(x, y, width, height, 4, COLOR_PANEL_EDGE);
}

String fitText(String text, int width, uint8_t font) {
  // I nomi lunghi resta dentro la so tessera, senza pestar i vicini.
  if (display.textWidth(text, font) <= width) return text;
  while (text.length() && display.textWidth(text + "..", font) > width) {
    text.remove(text.length() - 1);
  }
  return text + "..";
}

void drawText(const String &text, int x, int y, int width, uint8_t font,
              uint16_t color, uint16_t background = COLOR_PANEL) {
  display.setTextColor(color, background);
  display.setTextSize(1);
  display.setTextPadding(width);
  display.drawString(fitText(text, width, font), x, y, font);
  display.setTextPadding(0);
}

void drawLabel(const String &label, int x, int y, uint16_t color = COLOR_MUTED) {
  display.setTextColor(color, COLOR_PANEL);
  display.setTextFont(1);
  display.setTextSize(1);
  display.drawString(label, x, y);
}

void drawValue(const String &value, int x, int y, uint16_t color = COLOR_WHITE,
               int width = 120) {
  drawText(value, x, y, width, 2, color);
}

String countText(int count) {
  if (!status.valid) return "--";
  if (count < 10000) return String(count);
  if (count < 1000000) return String(count / 1000.0, 1) + "k";
  return String(count / 1000000.0, 1) + "m";
}

void drawMetricTile(const String &label, int value, int x, int y,
                    uint16_t color = COLOR_WHITE) {
  drawPanel(x, y, 97, 48);
  drawLabel(label, x + 9, y + 7);
  const String number = countText(value);
  const uint8_t font = display.textWidth(number, 4) <= 79 ? 4 : 2;
  if (font == 2) display.fillRect(x + 9, y + 35, 79, 11, COLOR_PANEL);
  drawText(number, x + 9, y + 19, 79, font, color);
}

void drawGauge(int x, int y, int width, int percent, uint16_t color) {
  int safePercent = constrain(percent, 0, 100);
  display.fillRoundRect(x, y, width, 8, 3, 0x294B);
  int fillWidth = width * safePercent / 100;
  if (fillWidth > 0) display.fillRect(x, y, fillWidth, 8, color);
}

void drawMascot(int x, int y, bool happy, uint8_t frame) {
  // Robottino-aragosta a pixel: l'antenna pulsa, el resto no lampeggia.
  display.fillRect(x + 29, y + 7, 2, 7, COLOR_ORANGE);
  display.fillRect(x + 27, y + 3, 6, 4,
                   frame % 2 ? (happy ? COLOR_MINT : COLOR_WARN) : COLOR_ORANGE);
  display.fillRect(x + 16, y + 13, 28, 4, COLOR_CORAL);
  display.fillRect(x + 12, y + 17, 36, 26, COLOR_CORAL);
  display.fillRect(x + 16, y + 43, 28, 4, COLOR_CORAL);
  display.fillRect(x + 18, y + 21, 24, 16, COLOR_BG);
  display.fillRect(x + 21, y + 25, 4, 4, happy ? COLOR_MINT : COLOR_WARN);
  display.fillRect(x + 35, y + 25, 4, 4, happy ? COLOR_MINT : COLOR_WARN);
  display.fillRect(x + 27, y + 33, 6, 2, happy ? COLOR_MINT : COLOR_WARN);
  display.fillRect(x + 4, y + 30, 8, 4, COLOR_CORAL);
  display.fillRect(x + 48, y + 30, 8, 4, COLOR_CORAL);
  display.fillRect(x, y + 20, 4, 12, COLOR_CORAL);
  display.fillRect(x + 8, y + 20, 4, 12, COLOR_CORAL);
  display.fillRect(x + 48, y + 20, 4, 12, COLOR_CORAL);
  display.fillRect(x + 56, y + 20, 4, 12, COLOR_CORAL);
  display.fillRect(x + 17, y + 47, 9, 4, COLOR_ORANGE);
  display.fillRect(x + 34, y + 47, 9, 4, COLOR_ORANGE);
}

void drawHeader() {
  drawText("OPENCLAW", 9, 7, 105, 2, COLOR_WHITE, COLOR_BG);
  drawText("MISSION CONTROL", 124, 13, 100, 1, COLOR_MUTED, COLOR_BG);
  const bool fresh = status.valid && !status.stale;
  const uint16_t color = !fresh ? COLOR_WARN : status.online ? COLOR_MINT : COLOR_RED;
  display.fillRect(251, 13, 4, 4, color);
  drawText(!status.valid ? "WAIT" : status.stale ? "STALE" : status.online ? "LIVE" : "DOWN",
           263, 12, 49, 1, color, COLOR_BG);
  if (drawLayout) display.drawFastHLine(8, 30, 304, COLOR_PANEL_EDGE);
}

void drawFooter() {
  if (!drawLayout) return;
  const char *labels[] = {"OVERVIEW", "ACTIVITY", "DEVICE"};
  display.drawFastHLine(8, 213, 304, COLOR_PANEL_EDGE);
  for (uint8_t index = 0; index < 3; index++) {
    const int x = 8 + index * 103;
    const uint16_t color = index == page ? COLOR_CORAL : COLOR_MUTED;
    if (index == page) display.fillRect(x + 10, 213, 76, 2, color);
    display.setTextColor(color, COLOR_BG);
    display.drawCentreString(labels[index], x + 48, 225, 1);
  }
}

void drawHome() {
  drawPanel(8, 37, 304, 62);
  const bool healthy = status.valid && status.online && !status.stale;
  drawMascot(16, 42, healthy, (millis() / 500) % 2);
  drawLabel("GATEWAY", 87, 47);
  const String state = !status.valid ? "Connecting" : status.stale ? "Data stale" :
                       status.online ? "Connected" : "Offline";
  drawValue(state, 87, 63, healthy ? COLOR_MINT : COLOR_WARN, 121);
  drawLabel("ROUND TRIP", 221, 47);
  drawValue(healthy ? String(status.latencyMs) + " ms" : "-- ms", 221, 63,
            COLOR_WHITE, 80);
  // Sei cifre subito leggibili; la mascotte no se magna mezo display.
  drawMetricTile("ACTIVE 15M", status.activeSessions, 8, 105, COLOR_ORANGE);
  drawMetricTile("AGENTS", status.agents, 111, 105, COLOR_MINT);
  drawMetricTile("ACTIVE TASKS", status.activeTasks, 214, 105,
                 status.activeTasks ? COLOR_ORANGE : COLOR_WHITE);
  drawMetricTile("WB TRIAGE", status.workboardTriage, 8, 159,
                 status.workboardTriage ? COLOR_WARN : COLOR_MINT);
  drawMetricTile("WB RUNNING", status.workboardRunning, 111, 159,
                 status.workboardRunning ? COLOR_ORANGE : COLOR_WHITE);
  drawMetricTile("WB BLOCKED", status.workboardBlocked, 214, 159,
                 status.workboardBlocked ? COLOR_RED : COLOR_MINT);
}

void drawPulse() {
  drawPanel(8, 37, 304, 48);
  drawLabel("LATEST SESSION MODEL", 18, 45);
  drawValue(status.valid ? status.model : "Waiting for bridge", 18, 60, COLOR_ORANGE, 284);
  drawMetricTile("HEARTBEATS", status.heartbeatAgents, 8, 91, COLOR_MINT);
  drawMetricTile("RECENT LIST", status.recentSessions, 111, 91);
  drawMetricTile("FAILED TOTAL", status.taskFailures, 214, 91,
                 status.taskFailures ? COLOR_RED : COLOR_MINT);
  drawPanel(8, 145, 304, 62);
  drawLabel("OPENCLAW", 18, 155);
  drawValue(status.valid ? status.version : "--", 98, 151, COLOR_WHITE, 203);
  display.drawFastHLine(18, 177, 283, COLOR_PANEL_EDGE);
  drawText("Recent = entries in the gateway list", 18, 188, 282, 1, COLOR_MUTED);
}

void drawDevice() {
  drawPanel(8, 37, 304, 39);
  drawLabel("DISPLAY", 18, 51);
  drawValue("ESP32-2432S028R", 93, 47, COLOR_WHITE, 208);
  drawPanel(8, 82, 148, 80);
  drawPanel(163, 82, 149, 80);
  drawLabel("WI-FI SIGNAL", 18, 91);
  drawValue(WiFi.isConnected() ? String(WiFi.RSSI()) + " dBm" : "Offline", 18, 104,
            WiFi.isConnected() ? COLOR_MINT : COLOR_RED, 127);
  drawLabel("BRIDGE", 173, 91);
  drawValue(status.valid ? (status.stale ? "Stale" : "Fresh") : "Waiting", 173, 104,
            status.valid && !status.stale ? COLOR_MINT : COLOR_WARN, 127);
  drawText("HEAP " + String(ESP.getFreeHeap() / 1024) + " KB", 18, 144, 127, 1, COLOR_MUTED);
  drawText("UP " + String(millis() / 60000) + " min", 173, 144, 127, 1, COLOR_MUTED);
  drawPanel(8, 168, 304, 39);
  if (otaWindowActive()) {
    unsigned long secondsLeft = (otaWindowUntil - millis()) / 1000;
    drawText("OTA OPEN  " + String(secondsLeft) + "s remaining", 18, 178, 282, 1, COLOR_WARN);
    drawGauge(18, 193, 282, secondsLeft * 100 / (OTA_WINDOW_MS / 1000), COLOR_WARN);
  } else if (otaArmStarted != 0) {
    unsigned long heldMs = millis() - otaArmStarted;
    int holdPercent = constrain(static_cast<int>(heldMs * 100 / OTA_ARM_HOLD_MS), 0, 100);
    drawText("KEEP HOLDING TO ENABLE OTA", 18, 178, 282, 1, COLOR_WARN);
    drawGauge(18, 193, 282, holdPercent, COLOR_WARN);
  } else {
    drawText("OTA LOCKED  /  Hold panel for 2s", 18, 178, 282, 1, COLOR_MUTED);
    display.fillRect(18, 193, 282, 8, COLOR_PANEL);
  }
}

void drawScreen(bool clear) {
  static String previousKey;
  static uint8_t previousPage = 255;
  String key = String(status.valid) + ":" + status.online + ":" + status.stale + ":" +
               status.latencyMs + ":" + status.sessions + ":" + status.recentSessions + ":" +
               status.activeSessions + ":" + status.agents + ":" + status.activeTasks + ":" +
               status.queuedEvents + ":" + status.workboardTriage + ":" +
               status.workboardRunning + ":" + status.workboardBlocked + ":" +
               status.degradedPlugins + ":" + status.heartbeatAgents + ":" + status.taskFailures +
               ":" + status.model + ":" + status.version;
  if (page == 2) key += ":" + String(millis() / 1000) + ":" + otaArmStarted + ":" + otaWindowUntil;
  drawLayout = clear || screenNeedsClear || previousPage != page;
  // Transazion SPI no xe doppio buffer: no ridisegnar pannelli invariati.
  display.startWrite();
  if (!drawLayout && key == previousKey) {
    if (page == 0) {
      const bool healthy = status.valid && status.online && !status.stale;
      display.fillRect(43, 45, 6, 4,
                       (millis() / 500) % 2 ? (healthy ? COLOR_MINT : COLOR_WARN) : COLOR_ORANGE);
    }
    display.endWrite();
    return;
  }
  if (drawLayout) {
    display.fillScreen(COLOR_BG);
  }
  drawHeader();
  if (page == 0) {
    drawHome();
  } else if (page == 1) {
    drawPulse();
  } else {
    drawDevice();
  }
  drawFooter();
  display.endWrite();
  previousKey = key;
  previousPage = page;
  screenNeedsClear = false;
}

void fetchStatus() {
  if (!WiFi.isConnected() || bridgeUrl.isEmpty()) {
    status.valid = false;
    status.online = false;
    return;
  }

  HTTPClient http;
  http.setConnectTimeout(2500);
  http.setTimeout(4000);
  http.begin(endpointUrl());
  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    status.online = false;
    status.stale = true;
    http.end();
    return;
  }

  JsonDocument document;
  DeserializationError error = deserializeJson(document, http.getStream());
  http.end();
  if (error) {
    status.online = false;
    status.stale = true;
    return;
  }

  status.valid = true;
  status.online = document["gateway"]["online"] | false;
  status.stale = document["stale"] | false;
  status.latencyMs = document["gateway"]["latencyMs"] | 0;
  status.sessions = document["sessions"]["total"] | 0;
  status.recentSessions = document["sessions"]["recent"] | 0;
  status.activeSessions = document["sessions"]["active"] | 0;
  status.model = String(document["sessions"]["model"] | "unknown");
  status.activeTasks = document["tasks"]["active"] | 0;
  status.taskFailures = document["tasks"]["failures"] | 0;
  status.agents = document["agents"]["total"] | 0;
  status.heartbeatAgents = document["agents"]["heartbeatEnabled"] | 0;
  status.queuedEvents = document["system"]["queuedEvents"] | 0;
  status.degradedPlugins = document["system"]["degradedPlugins"] | 0;
  status.workboardTriage = document["workboard"]["triage"] | 0;
  status.workboardRunning = document["workboard"]["running"] | 0;
  status.workboardBlocked = document["workboard"]["blocked"] | 0;
  status.version = String(document["system"]["version"] | "unknown");
}

void handleTouch() {
  static bool navigationTouch = false;
  bool touching = touch.touched();
  if (!touching) {
    otaArmStarted = 0;
    navigationTouch = false;
    return;
  }

  TS_Point point = touch.getPoint();
  // Calibrazion standard CYD; se un clone xe al contrario, se sistema dopo.
  int x = map(point.x, 250, 3850, 0, 320);
  int y = map(point.y, 250, 3850, 0, 240);
  x = constrain(x, 0, 319);
  y = constrain(y, 0, 239);

  // Una pressione, una pagina: el dito fermo no deve saltar tra le schede.
  if (navigationTouch) return;
  if (page == 2 && y < 210 && !otaWindowActive()) {
    if (otaArmStarted == 0) {
      otaArmStarted = millis();
    } else if (millis() - otaArmStarted >= OTA_ARM_HOLD_MS) {
      openOtaWindow();
    }
    return;
  }

  otaArmStarted = 0;
  if (millis() - lastTouch < 300) {
    return;
  }

  if (y >= 213) {
    navigationTouch = true;
    const uint8_t selected = x < 107 ? 0 : x < 213 ? 1 : 2;
    if (selected != page) {
      page = selected;
      drawScreen(true);
    }
  }
  lastTouch = millis();
}

void configureOta() {
  ArduinoOTA.setHostname("openclaw-cyd");
  ArduinoOTA.onStart([]() {
    // Un upload gia' autorizzato deve poter finire anche oltre i due minuti.
    otaUpdateInProgress = true;
    // La vista OTA sostituisce le schede: al ritorno ricrea el layout.
    screenNeedsClear = true;
    display.fillScreen(COLOR_BG);
    display.setTextColor(COLOR_CORAL, COLOR_BG);
    display.setTextFont(2);
    display.drawCentreString("UPDATING CLAW", 160, 82, 2);
    display.setTextColor(COLOR_WHITE, COLOR_BG);
    display.setTextFont(1);
    display.drawCentreString("Do not unplug", 160, 122, 1);
  });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    int percent = total == 0 ? 0 : static_cast<int>(progress * 100 / total);
    display.fillRect(35, 150, 250, 12, COLOR_BG);
    drawGauge(35, 150, 250, percent, COLOR_MINT);
  });
  ArduinoOTA.onEnd([]() { otaUpdateInProgress = false; });
  ArduinoOTA.onError([](ota_error_t error) {
    otaUpdateInProgress = false;
    screenNeedsClear = true;
    otaWindowUntil = millis();
    display.fillRect(0, 180, 320, 30, COLOR_BG);
    display.setTextColor(COLOR_RED, COLOR_BG);
    display.drawCentreString("OTA ERROR " + String(static_cast<int>(error)), 160, 185, 1);
  });
}

void showProvisioning() {
  display.fillScreen(COLOR_BG);
  drawMascot(125, 40, true, 0);
  display.setTextColor(COLOR_CORAL, COLOR_BG);
  display.setTextFont(2);
  display.drawCentreString("OPENCLAW SETUP", 160, 125, 2);
  display.setTextColor(COLOR_WHITE, COLOR_BG);
  display.setTextFont(1);
  display.drawCentreString("Connect to Wi-Fi: OpenClaw-CYD", 160, 164, 1);
  display.drawCentreString("Then open 192.168.4.1", 160, 182, 1);
}

void setup() {
  Serial.begin(115200);
  pinMode(BACKLIGHT, OUTPUT);
  digitalWrite(BACKLIGHT, HIGH);

  display.init();
  display.setRotation(1);
  display.invertDisplay(true);
  touchSpi.begin(TOUCH_CLK, TOUCH_MISO, TOUCH_MOSI, TOUCH_CS);
  touch.begin(touchSpi);
  touch.setRotation(1);

  preferences.begin("claw-monitor", false);
  bridgeUrl = preferences.getString("bridge", "");
  preferences.end();

  showProvisioning();
  char bridgeBuffer[128];
  bridgeUrl.substring(0, sizeof(bridgeBuffer) - 1).toCharArray(bridgeBuffer, sizeof(bridgeBuffer));
  WiFiManagerParameter bridgeParameter("bridge", "Bridge URL (http://LAN-IP:8765)", bridgeBuffer,
                                       sizeof(bridgeBuffer));
  WiFiManager manager;
  manager.addParameter(&bridgeParameter);
  manager.setConfigPortalTimeout(300);

  bool connected = bridgeUrl.isEmpty() ? manager.startConfigPortal("OpenClaw-CYD")
                                        : manager.autoConnect("OpenClaw-CYD");
  if (!connected) {
    delay(1500);
    ESP.restart();
  }

  configureOta();

  String configuredBridge = String(bridgeParameter.getValue());
  configuredBridge.trim();
  if (!configuredBridge.isEmpty() && configuredBridge != bridgeUrl) {
    bridgeUrl = configuredBridge;
    preferences.begin("claw-monitor", false);
    preferences.putString("bridge", bridgeUrl);
    preferences.end();
  }

  fetchStatus();
  drawScreen(true);
}

void loop() {
  handleTouch();

  // La porta OTA risponde solo dopo una conferma fisica sul display.
  if (otaWindowActive() || otaUpdateInProgress) {
    ArduinoOTA.handle();
  } else if (otaWindowUntil != 0) {
    ArduinoOTA.end();
    otaServiceRunning = false;
    otaWindowUntil = 0;
    drawScreen();
  }

  if (otaUpdateInProgress) {
    delay(1);
    return;
  }

  if (millis() - lastFetch >= FETCH_INTERVAL_MS) {
    lastFetch = millis();
    fetchStatus();
  }

  if (millis() - lastDraw >= DRAW_INTERVAL_MS) {
    lastDraw = millis();
    drawScreen();
  }
  delay(10);
}
