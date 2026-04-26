// ============================================================
//  XIAO ESP32S3 + Wio SX1262 — TacticalOps LoRa Scanner
//  Completely independent from NetHunter
//
//  Modes (auto-detected at boot):
//   HOME : home WiFi found → MQTT directly to Pi 5
//   FIELD: home WiFi not found → connects to any open/saved AP
//          and POSTs directly to Cloudflare tunnel URL
//
//  No serial dependency. No NetHunter needed.
//
//  Board URL:
//   https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
//  Board: XIAO_ESP32S3
//
//  Libraries: RadioLib, PubSubClient, ArduinoJson
//
//  Wio-SX1262 pre-wired pins:
//   NSS=41  DIO1=39  RESET=42  BUSY=40
// ============================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <RadioLib.h>
#include <HTTPClient.h>

// ── Config ────────────────────────────────────────────────────
const char* WIFI_SSID_HOME = "BSA 2.4Ghz";      // ← home WiFi
const char* WIFI_PASS_HOME = "$$@29211526";       // ← home WiFi pass
const char* MQTT_BROKER    = "192.168.29.115";         // ← Pi 5 mDNS
const int   MQTT_PORT      = 1883;

// Used in FIELD mode — Cloudflare tunnel URL of Pi 5
// Get from: cloudflared tunnel --url http://localhost:3000
const char* TACOPS_URL = "https://toi-palaeological-imposingly.ngrok-free.devm";

const char* DEVICE_NAME = "tacops-xiao-lora";

// LoRa — India IN865 band
#define LORA_FREQ      865.0
#define LORA_BW        125.0
#define LORA_SF        9
#define LORA_CR        7
#define LORA_SYNC      0x34    // Meshtastic private sync word
#define LORA_POWER     14
#define LORA_PREAMBLE  16

// SX1262 pins (fixed on Wio-SX1262 kit — do not change)
#define LORA_NSS   41
#define LORA_DIO1  39
#define LORA_RST   42
#define LORA_BUSY  40

// ── Globals ───────────────────────────────────────────────────
SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
WiFiClient   wifiClient;
PubSubClient mqtt(wifiClient);
HTTPClient   http;

bool fieldMode   = false;
int  packetCount = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastWifiScan  = 0;

volatile bool loraReceived = false;
void IRAM_ATTR setLoraFlag(){ loraReceived = true; }

// ── Setup ─────────────────────────────────────────────────────
void setup(){
  Serial.begin(115200);
  delay(500);
  Serial.println("\n[XIAO] TacticalOps LoRa Scanner starting...");

  // Try home WiFi
  fieldMode = !connectWifi(WIFI_SSID_HOME, WIFI_PASS_HOME, 12);

  if(fieldMode){
    Serial.println("[Mode] FIELD — HTTP POST to Cloudflare tunnel");
  } else {
    Serial.println("[Mode] HOME — MQTT to rfconn.local");
    mqtt.setServer(MQTT_BROKER, MQTT_PORT);
    mqtt.setBufferSize(2048);
  }

  // Init SX1262
  Serial.print("[LoRa] Initializing SX1262... ");
  int st = radio.begin(LORA_FREQ, LORA_BW, LORA_SF, LORA_CR,
                        LORA_SYNC, LORA_POWER, LORA_PREAMBLE);
  if(st == RADIOLIB_ERR_NONE){
    Serial.println("OK");
    radio.setDio1Action(setLoraFlag);
    radio.startReceive();
    Serial.printf("[LoRa] Listening %.1f MHz SF%d BW%.0fkHz\n", LORA_FREQ, LORA_SF, LORA_BW);
  } else {
    Serial.printf("FAILED (code %d)\n", st);
  }

  Serial.println("[XIAO] Ready");
}

// ── Loop ──────────────────────────────────────────────────────
void loop(){
  if(!fieldMode){
    if(!mqtt.connected()) reconnectMqtt();
    mqtt.loop();
  }

  if(loraReceived){
    loraReceived = false;
    handleLoraPacket();
  }

  // WiFi scan every 20s in home mode
  if(!fieldMode && millis() - lastWifiScan > 20000){
    lastWifiScan = millis();
    scanAndPublishWifi();
  }

  if(millis() - lastHeartbeat > 30000){
    lastHeartbeat = millis();
    sendHeartbeat();
  }
}

// ── LoRa packet handler ───────────────────────────────────────
void handleLoraPacket(){
  int len = radio.getPacketLength();
  byte buf[256];
  int st = radio.readData(buf, min(len, 255));
  if(st != RADIOLIB_ERR_NONE){ radio.startReceive(); return; }

  float rssi = radio.getRSSI();
  float snr  = radio.getSNR();
  packetCount++;

  bool isMesh = (len >= 2 && buf[0] == 0x94 && buf[1] == 0xC3);
  String hexData = "0x";
  for(int i = 0; i < min(len, 16); i++){
    if(buf[i] < 0x10) hexData += "0";
    hexData += String(buf[i], HEX);
  }
  hexData.toUpperCase();

  DynamicJsonDocument doc(512);
  doc["type"]       = "lora";
  doc["node_id"]    = isMesh ? "Meshtastic" : ("PKT_" + String(packetCount));
  doc["freq"]       = String(LORA_FREQ, 1);
  doc["rssi"]       = (int)rssi;
  doc["snr"]        = String(snr, 1);
  doc["len"]        = len;
  doc["data"]       = hexData;
  doc["meshtastic"] = isMesh;
  doc["ts"]         = millis();

  Serial.printf("[LoRa] #%d rssi=%.1f snr=%.1f len=%d mesh=%d\n",
    packetCount, rssi, snr, len, isMesh);

  String out; serializeJson(doc, out);

  if(fieldMode){
    // POST directly to Cloudflare tunnel — no NetHunter involved
    postToTacops("/api/xiao", out);
  } else {
    mqtt.publish("tacops/lora", out.c_str());
  }

  radio.startReceive();
}

// ── WiFi scan → MQTT (home mode) ─────────────────────────────
void scanAndPublishWifi(){
  int n = WiFi.scanNetworks(false, true);
  if(n <= 0) return;

  DynamicJsonDocument doc(4096);
  JsonArray arr = doc.to<JsonArray>();
  for(int i = 0; i < min(n, 15); i++){
    JsonObject net = arr.createNestedObject();
    net["ssid"]  = WiFi.SSID(i);
    net["bssid"] = WiFi.BSSIDstr(i);
    net["ch"]    = WiFi.channel(i);
    net["rssi"]  = WiFi.RSSI(i);
    net["enc"]   = encName(WiFi.encryptionType(i));
    net["band"]  = WiFi.channel(i) > 14 ? "5GHz" : "2.4GHz";
  }
  WiFi.scanDelete();
  String out; serializeJson(doc, out);
  mqtt.publish("tacops/wifi", out.c_str());
  Serial.printf("[WiFi] Published %d networks\n", n);
}

// ── Heartbeat ─────────────────────────────────────────────────
void sendHeartbeat(){
  DynamicJsonDocument doc(256);
  doc["device"]    = DEVICE_NAME;
  doc["uptime"]    = millis() / 1000;
  doc["heap"]      = ESP.getFreeHeap();
  doc["ip"]        = WiFi.localIP().toString();
  doc["fieldMode"] = fieldMode;
  doc["loraPkts"]  = packetCount;
  String out; serializeJson(doc, out);

  if(fieldMode) postToTacops("/api/xiao/heartbeat", out);
  else mqtt.publish("tacops/heartbeat", out.c_str());
}

// ── POST to Cloudflare tunnel (field mode) ────────────────────
void postToTacops(const char* path, String& body){
  if(WiFi.status() != WL_CONNECTED) return;
  String url = String(TACOPS_URL) + path;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  if(code > 0) Serial.printf("[HTTP] POST %s → %d\n", path, code);
  else Serial.printf("[HTTP] POST failed: %s\n", http.errorToString(code).c_str());
  http.end();
}

// ── Helpers ───────────────────────────────────────────────────
bool connectWifi(const char* ssid, const char* pass, int tries){
  Serial.printf("[WiFi] Trying %s", ssid);
  WiFi.begin(ssid, pass);
  for(int i = 0; i < tries * 2; i++){
    if(WiFi.status() == WL_CONNECTED){
      Serial.printf("\n[WiFi] IP: %s\n", WiFi.localIP().toString().c_str());
      return true;
    }
    delay(500); Serial.print(".");
  }
  Serial.println("\n[WiFi] Not found");
  WiFi.disconnect();
  return false;
}

void reconnectMqtt(){
  int tries = 0;
  while(!mqtt.connected() && tries < 3){
    if(mqtt.connect(DEVICE_NAME)){
      mqtt.publish("tacops/heartbeat",
        ("{\"device\":\"" + String(DEVICE_NAME) + "\",\"status\":\"online\"}").c_str());
    } else {
      delay(2000); tries++;
    }
  }
  // If MQTT keeps failing in field, switch to HTTP mode
  if(!mqtt.connected() && !fieldMode){
    Serial.println("[MQTT] Failed — switching to field HTTP mode");
    fieldMode = true;
  }
}

const char* encName(wifi_auth_mode_t enc){
  switch(enc){
    case WIFI_AUTH_OPEN:         return "Open";
    case WIFI_AUTH_WEP:          return "WEP";
    case WIFI_AUTH_WPA_PSK:      return "WPA";
    case WIFI_AUTH_WPA2_PSK:     return "WPA2";
    case WIFI_AUTH_WPA3_PSK:     return "WPA3";
    default:                     return "WPA2";
  }
}
