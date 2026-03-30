// ============================================================
//  ESP32 #1 — WiFi + BLE + nRF24 Scanner
//  Hardware: ESP32 WROOM-32U + nRF24L01+PA+LNA
//
//  Wiring (nRF24L01):
//    CE  → GPIO 4
//    CSN → GPIO 5
//    SCK → GPIO 18
//    MOSI→ GPIO 23
//    MISO→ GPIO 19
//    VCC → 3.3V  (use separate 3.3V regulator — nRF24 is power-hungry)
//    GND → GND
//
//  Libraries required (Arduino Library Manager):
//    - PubSubClient  (Nick O'Leary)
//    - RF24          (TMRh20)
//    - ArduinoJson   (Benoit Blanchon)
// ============================================================

#include <WiFi.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <RF24.h>

// ── Config ────────────────────────────────────────────────────
const char* WIFI_SSID     = "YOUR_SSID";          // ← change
const char* WIFI_PASS     = "YOUR_PASSWORD";       // ← change
const char* MQTT_BROKER   = "192.168.1.100";       // ← Pi 5 IP
const int   MQTT_PORT     = 1883;
const char* DEVICE_NAME   = "tacops-esp32-01";

// Scan intervals (ms)
const int WIFI_SCAN_INTERVAL = 15000;
const int BLE_SCAN_INTERVAL  = 10000;
const int NRF24_SCAN_TIME    = 2000;  // ms per full 126-ch sweep

// nRF24L01 pins
#define NRF_CE_PIN  4
#define NRF_CSN_PIN 5

// ── Globals ───────────────────────────────────────────────────
WiFiClient   wifiClient;
PubSubClient mqtt(wifiClient);
BLEScan*     bleScan;
RF24         radio(NRF_CE_PIN, NRF_CSN_PIN);

unsigned long lastWifiScan = 0;
unsigned long lastBleScan  = 0;
unsigned long lastNrf24    = 0;
unsigned long lastHeartbeat= 0;
int          nrf24Channels[126];

// ── Setup ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n[TACOPS] ESP32 Scanner starting...");

  connectWifi();
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setBufferSize(4096);

  // BLE
  BLEDevice::init(DEVICE_NAME);
  bleScan = BLEDevice::getScan();
  bleScan->setActiveScan(true);
  bleScan->setInterval(100);
  bleScan->setWindow(99);

  // nRF24
  if (radio.begin()) {
    radio.setAutoAck(false);
    radio.disableCRC();
    radio.setDataRate(RF24_2MBPS);
    radio.setPALevel(RF24_PA_MIN);
    radio.startListening();
    Serial.println("[nRF24] Radio initialized");
  } else {
    Serial.println("[nRF24] Radio NOT found — skipping nRF24 scans");
  }

  Serial.println("[TACOPS] Ready");
}

// ── Main loop ─────────────────────────────────────────────────
void loop() {
  if (!mqtt.connected()) reconnectMqtt();
  mqtt.loop();

  unsigned long now = millis();

  if (now - lastWifiScan > WIFI_SCAN_INTERVAL) {
    lastWifiScan = now;
    scanWifi();
  }

  if (now - lastBleScan > BLE_SCAN_INTERVAL) {
    lastBleScan = now;
    scanBle();
  }

  if (now - lastNrf24 > NRF24_SCAN_TIME && radio.isChipConnected()) {
    lastNrf24 = now;
    scanNrf24();
  }

  if (now - lastHeartbeat > 30000) {
    lastHeartbeat = now;
    sendHeartbeat();
  }
}

// ── WiFi Scanner ──────────────────────────────────────────────
void scanWifi() {
  Serial.println("[WiFi] Scanning...");
  int n = WiFi.scanNetworks(false, true); // async=false, show hidden=true
  if (n == 0) { Serial.println("[WiFi] No networks found"); return; }

  DynamicJsonDocument doc(4096);
  JsonArray arr = doc.to<JsonArray>();

  for (int i = 0; i < min(n, 20); i++) {
    JsonObject net = arr.createNestedObject();
    net["ssid"]  = WiFi.SSID(i);
    net["bssid"] = WiFi.BSSIDstr(i);
    net["ch"]    = WiFi.channel(i);
    net["rssi"]  = WiFi.RSSI(i);
    net["enc"]   = encryptionName(WiFi.encryptionType(i));
    net["band"]  = WiFi.channel(i) > 14 ? "5GHz" : "2.4GHz";
    net["cli"]   = 0; // client count not available in passive scan
  }
  WiFi.scanDelete();

  String out;
  serializeJson(doc, out);
  mqtt.publish("tacops/wifi", out.c_str(), false);
  Serial.printf("[WiFi] Published %d networks\n", n);
}

// ── BLE Scanner ───────────────────────────────────────────────
void scanBle() {
  Serial.println("[BLE] Scanning...");
  BLEScanResults results = bleScan->start(4, false); // 4 seconds
  int count = results.getCount();

  DynamicJsonDocument doc(4096);
  JsonArray arr = doc.to<JsonArray>();

  for (int i = 0; i < min(count, 25); i++) {
    BLEAdvertisedDevice dev = results.getDevice(i);
    JsonObject d = arr.createNestedObject();
    d["name"] = dev.haveName() ? dev.getName().c_str() : "Unknown";
    d["mac"]  = dev.getAddress().toString().c_str();
    d["rssi"] = dev.getRSSI();
    d["type"] = classifyBle(dev.haveName() ? dev.getName().c_str() : "");
  }
  bleScan->clearResults();

  String out;
  serializeJson(doc, out);
  mqtt.publish("tacops/ble", out.c_str(), false);
  Serial.printf("[BLE] Published %d devices\n", count);
}

// ── nRF24 Channel Scanner (2.4 GHz spectrum) ─────────────────
void scanNrf24() {
  memset(nrf24Channels, 0, sizeof(nrf24Channels));
  radio.stopListening();

  // Sweep all 126 channels 50 times for better accuracy
  for (int sweep = 0; sweep < 50; sweep++) {
    for (int ch = 0; ch < 126; ch++) {
      radio.setChannel(ch);
      radio.startListening();
      delayMicroseconds(128);
      if (radio.testRPD()) nrf24Channels[ch]++;  // signal present
      radio.stopListening();
    }
  }
  radio.startListening();

  // Scale to 0-100
  DynamicJsonDocument doc(2048);
  JsonArray arr = doc.to<JsonArray>();
  for (int ch = 0; ch < 126; ch++) {
    JsonObject obj = arr.createNestedObject();
    obj["ch"] = ch;
    obj["v"]  = min(100, nrf24Channels[ch] * 2);  // scale from 50 sweeps
  }

  String out;
  serializeJson(doc, out);
  mqtt.publish("tacops/nrf24", out.c_str(), false);
  Serial.println("[nRF24] Channel scan published");
}

// ── Heartbeat ─────────────────────────────────────────────────
void sendHeartbeat() {
  DynamicJsonDocument doc(256);
  doc["device"]  = DEVICE_NAME;
  doc["uptime"]  = millis() / 1000;
  doc["heap"]    = ESP.getFreeHeap();
  doc["ip"]      = WiFi.localIP().toString();
  String out;
  serializeJson(doc, out);
  mqtt.publish("tacops/heartbeat", out.c_str());
}

// ── Helpers ───────────────────────────────────────────────────
void connectWifi() {
  Serial.printf("[WiFi] Connecting to %s...", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 30) {
    delay(500); Serial.print("."); tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] Failed to connect — check credentials");
  }
}

void reconnectMqtt() {
  while (!mqtt.connected()) {
    Serial.print("[MQTT] Connecting...");
    if (mqtt.connect(DEVICE_NAME)) {
      Serial.println("OK");
      mqtt.publish("tacops/heartbeat", ("{\"device\":\"" + String(DEVICE_NAME) + "\",\"status\":\"online\"}").c_str());
    } else {
      Serial.printf("Failed (rc=%d) — retrying in 5s\n", mqtt.state());
      delay(5000);
    }
  }
}

const char* encryptionName(wifi_auth_mode_t enc) {
  switch (enc) {
    case WIFI_AUTH_OPEN:            return "Open";
    case WIFI_AUTH_WEP:             return "WEP";
    case WIFI_AUTH_WPA_PSK:         return "WPA-PSK";
    case WIFI_AUTH_WPA2_PSK:        return "WPA2";
    case WIFI_AUTH_WPA_WPA2_PSK:    return "WPA/WPA2";
    case WIFI_AUTH_WPA3_PSK:        return "WPA3";
    default:                        return "WPA2";
  }
}

const char* classifyBle(const char* name) {
  String n = String(name);
  n.toLowerCase();
  if (n.indexOf("iphone") >= 0 || n.indexOf("pixel") >= 0 || n.indexOf("galaxy") >= 0) return "Phone";
  if (n.indexOf("airpod") >= 0 || n.indexOf("wh-") >= 0) return "Audio";
  if (n.indexOf("band") >= 0 || n.indexOf("fitbit") >= 0) return "Wearable";
  if (n.indexOf("esp") >= 0 || n.indexOf("arduino") >= 0) return "IoT";
  return "Unknown";
}
