#include <Arduino.h>
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

constexpr uint16_t COLOR_BG = 0x0843;
constexpr uint16_t COLOR_PANEL = 0x18C8;
constexpr uint16_t COLOR_PANEL_EDGE = 0x39AE;
constexpr uint16_t COLOR_CORAL = 0xFB45;
constexpr uint16_t COLOR_ORANGE = 0xFD64;
constexpr uint16_t COLOR_MINT = 0x77F1;
constexpr uint16_t COLOR_WARN = 0xFEC4;
constexpr uint16_t COLOR_MUTED = 0x8410;
constexpr uint16_t COLOR_WHITE = 0xEF7D;
constexpr uint16_t COLOR_RED = 0xF9E7;

constexpr unsigned long FETCH_INTERVAL_MS = 5000;
constexpr unsigned long DRAW_INTERVAL_MS = 250;

struct MonitorStatus {
  bool valid = false;
  bool online = false;
  bool stale = false;
  int latencyMs = 0;
  int sessions = 0;
  int recentSessions = 0;
  int contextPercent = 0;
  int activeTasks = 0;
  int taskFailures = 0;
  int agents = 0;
  int heartbeatAgents = 0;
  int queuedEvents = 0;
  int degradedPlugins = 0;
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

void drawHeader();
void drawFooter();
void drawHome();
void drawPulse();
void drawDevice();
void drawMascot(int x, int y, bool happy, uint8_t frame);

String endpointUrl() {
  String base = bridgeUrl;
  while (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  return base + "/api/status";
}

void drawPanel(int x, int y, int width, int height) {
  display.fillRoundRect(x, y, width, height, 6, COLOR_PANEL);
  display.drawRoundRect(x, y, width, height, 6, COLOR_PANEL_EDGE);
}

void drawLabel(const String &label, int x, int y, uint16_t color = COLOR_MUTED) {
  display.setTextColor(color, COLOR_PANEL);
  display.setTextFont(1);
  display.setTextSize(1);
  display.drawString(label, x, y);
}

void drawValue(const String &value, int x, int y, uint16_t color = COLOR_WHITE) {
  display.setTextColor(color, COLOR_PANEL);
  display.setTextFont(2);
  display.setTextSize(1);
  display.drawString(value, x, y);
}

void drawGauge(int x, int y, int width, int percent, uint16_t color) {
  int safePercent = constrain(percent, 0, 100);
  display.fillRoundRect(x, y, width, 8, 3, 0x294B);
  display.fillRoundRect(x, y, width * safePercent / 100, 8, 3, color);
}

void drawMascot(int x, int y, bool happy, uint8_t frame) {
  // El robottino se move de un pixel: poca roba, ma fa compagnia.
  int bounce = frame % 2;
  y -= bounce;

  display.fillCircle(x + 35, y + 39, 30, COLOR_CORAL);
  display.fillRoundRect(x + 14, y + 22, 43, 35, 10, COLOR_CORAL);
  display.fillRoundRect(x + 20, y + 28, 32, 23, 7, 0x1085);
  display.fillCircle(x + 29, y + 38, 3, happy ? COLOR_WARN : COLOR_RED);
  display.fillCircle(x + 43, y + 38, 3, happy ? COLOR_WARN : COLOR_RED);

  if (happy) {
    display.drawFastHLine(x + 32, y + 46, 8, COLOR_WARN);
  } else {
    display.drawLine(x + 32, y + 47, x + 39, y + 44, COLOR_RED);
  }

  display.drawLine(x + 35, y + 10, x + 35, y + 21, COLOR_ORANGE);
  display.fillCircle(x + 35, y + 8, 4, frame % 2 ? COLOR_MINT : COLOR_ORANGE);

  display.fillCircle(x + 8, y + 42, 10, COLOR_CORAL);
  display.fillCircle(x + 62, y + 42, 10, COLOR_CORAL);
  display.fillCircle(x + 8, y + 42, 5, COLOR_BG);
  display.fillCircle(x + 62, y + 42, 5, COLOR_BG);
  display.fillRect(x + 6, y + 31, 4, 11, COLOR_BG);
  display.fillRect(x + 60, y + 31, 4, 11, COLOR_BG);

  display.fillRoundRect(x + 19, y + 61, 13, 8, 3, COLOR_ORANGE);
  display.fillRoundRect(x + 39, y + 61, 13, 8, 3, COLOR_ORANGE);
}

void drawHeader() {
  display.fillRect(0, 0, 320, 28, COLOR_BG);
  display.setTextColor(COLOR_CORAL, COLOR_BG);
  display.setTextFont(2);
  display.setTextSize(1);
  display.drawString("OPENCLAW", 10, 7);

  uint16_t dot = status.online ? COLOR_MINT : COLOR_RED;
  display.fillCircle(300, 14, 5, dot);
  display.drawCircle(300, 14, 8, COLOR_PANEL_EDGE);
}

void drawFooter() {
  display.fillRect(0, 218, 320, 22, COLOR_BG);
  for (uint8_t index = 0; index < 3; index++) {
    uint16_t color = index == page ? COLOR_ORANGE : COLOR_PANEL_EDGE;
    display.fillRoundRect(133 + index * 20, 225, 10, 5, 2, color);
  }
  display.setTextColor(COLOR_MUTED, COLOR_BG);
  display.setTextFont(1);
  display.drawString("<", 15, 224);
  display.drawRightString(">", 305, 224, 1);
}

void drawHome() {
  drawPanel(8, 34, 105, 177);
  display.setTextColor(COLOR_MUTED, COLOR_PANEL);
  display.setTextFont(1);
  display.drawCentreString(status.online ? "ALL CLAWS NOMINAL" : "CLAW NEEDS HELP", 60, 48, 1);
  drawMascot(25, 78, status.online, (millis() / 500) % 2);
  display.setTextColor(status.online ? COLOR_MINT : COLOR_RED, COLOR_PANEL);
  display.setTextFont(2);
  display.drawCentreString(status.online ? "ONLINE" : "OFFLINE", 60, 169, 2);
  display.setTextColor(COLOR_MUTED, COLOR_PANEL);
  display.setTextFont(1);
  display.drawCentreString(String(status.latencyMs) + " ms", 60, 193, 1);

  drawPanel(121, 34, 191, 52);
  drawLabel("GATEWAY", 133, 44);
  drawValue(status.online ? "Healthy" : "Unavailable", 133, 60,
            status.online ? COLOR_MINT : COLOR_RED);

  drawPanel(121, 94, 91, 52);
  drawLabel("SESSIONS", 133, 104);
  drawValue(String(status.sessions), 133, 120, COLOR_ORANGE);

  drawPanel(220, 94, 92, 52);
  drawLabel("TASKS", 232, 104);
  drawValue(String(status.activeTasks) + " active", 232, 120,
            status.activeTasks ? COLOR_WARN : COLOR_MINT);

  drawPanel(121, 154, 191, 57);
  drawLabel("CONTEXT  " + status.model, 133, 164);
  drawValue(String(status.contextPercent) + "%", 133, 180,
            status.contextPercent > 80 ? COLOR_WARN : COLOR_WHITE);
  drawGauge(185, 184, 112, status.contextPercent,
            status.contextPercent > 80 ? COLOR_WARN : COLOR_MINT);
}

void drawPulse() {
  drawPanel(8, 34, 304, 55);
  drawLabel("ACTIVE MODEL", 20, 44);
  drawValue(status.model, 20, 61, COLOR_ORANGE);

  drawPanel(8, 97, 96, 52);
  drawLabel("AGENTS", 20, 107);
  drawValue(String(status.agents), 20, 123, COLOR_MINT);

  drawPanel(112, 97, 96, 52);
  drawLabel("HEARTBEATS", 124, 107);
  drawValue(String(status.heartbeatAgents), 124, 123, COLOR_MINT);

  drawPanel(216, 97, 96, 52);
  drawLabel("QUEUE", 228, 107);
  drawValue(String(status.queuedEvents), 228, 123,
            status.queuedEvents ? COLOR_WARN : COLOR_MINT);

  drawPanel(8, 157, 304, 54);
  drawLabel("OPENCLAW VERSION", 20, 167);
  drawValue(status.version, 20, 183, COLOR_WHITE);
}

void drawDevice() {
  drawPanel(8, 34, 304, 177);
  drawLabel("DISPLAY", 20, 46);
  drawValue("ESP32-2432S028R", 20, 63, COLOR_ORANGE);

  drawLabel("WI-FI", 20, 94);
  drawValue(WiFi.isConnected() ? String(WiFi.RSSI()) + " dBm" : "offline", 20, 111,
            WiFi.isConnected() ? COLOR_MINT : COLOR_RED);

  drawLabel("BRIDGE", 170, 94);
  drawValue(status.valid ? (status.stale ? "stale" : "fresh") : "waiting", 170, 111,
            status.valid && !status.stale ? COLOR_MINT : COLOR_WARN);

  drawLabel("FREE HEAP", 20, 143);
  drawValue(String(ESP.getFreeHeap() / 1024) + " KB", 20, 160, COLOR_WHITE);

  drawLabel("UPTIME", 170, 143);
  drawValue(String(millis() / 60000) + " min", 170, 160, COLOR_WHITE);

  display.setTextColor(COLOR_MUTED, COLOR_PANEL);
  display.setTextFont(1);
  display.drawString(bridgeUrl.substring(0, 44), 20, 195);
}

void drawScreen() {
  display.fillScreen(COLOR_BG);
  drawHeader();
  if (page == 0) {
    drawHome();
  } else if (page == 1) {
    drawPulse();
  } else {
    drawDevice();
  }
  drawFooter();
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
  status.model = String(document["sessions"]["model"] | "unknown");
  status.contextPercent = document["sessions"]["contextPercent"] | 0;
  status.activeTasks = document["tasks"]["active"] | 0;
  status.taskFailures = document["tasks"]["failures"] | 0;
  status.agents = document["agents"]["total"] | 0;
  status.heartbeatAgents = document["agents"]["heartbeatEnabled"] | 0;
  status.queuedEvents = document["system"]["queuedEvents"] | 0;
  status.degradedPlugins = document["system"]["degradedPlugins"] | 0;
  status.version = String(document["system"]["version"] | "unknown");
}

void handleTouch() {
  if (!touch.touched() || millis() - lastTouch < 300) {
    return;
  }

  TS_Point point = touch.getPoint();
  // Calibrazion standard CYD; se un clone xe al contrario, se sistema dopo.
  int x = map(point.x, 250, 3850, 0, 320);
  int y = map(point.y, 250, 3850, 0, 240);
  x = constrain(x, 0, 319);
  y = constrain(y, 0, 239);

  if (y > 200) {
    if (x < 100) {
      page = (page + 2) % 3;
    } else if (x > 220) {
      page = (page + 1) % 3;
    } else {
      page = (page + 1) % 3;
    }
    drawScreen();
  }
  lastTouch = millis();
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

  String configuredBridge = String(bridgeParameter.getValue());
  configuredBridge.trim();
  if (!configuredBridge.isEmpty() && configuredBridge != bridgeUrl) {
    bridgeUrl = configuredBridge;
    preferences.begin("claw-monitor", false);
    preferences.putString("bridge", bridgeUrl);
    preferences.end();
  }

  fetchStatus();
  drawScreen();
}

void loop() {
  handleTouch();

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
