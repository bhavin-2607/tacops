// ============================================================
//  ESP32 #2 — CC1101 433 MHz Sub-GHz Scanner
//  Hardware: ESP32 WROOM-32U + CC1101 433 MHz module
//
//  Wiring (CC1101):
//    SCK  → GPIO 18
//    MISO → GPIO 19
//    MOSI → GPIO 23
//    CSN  → GPIO 5
//    GDO0 → GPIO 2   (data output pin)
//    GDO2 → GPIO 4   (optional: RSSI / carrier sense)
//    VCC  → 3.3V
//    GND  → GND
//
//  Libraries required:
//    - PubSubClient  (Nick O'Leary)
//    - ELECHOUSE_CC1101_SRC_DRV (elechouse/CC1101_SRC_DRV)
//    - ArduinoJson   (Benoit Blanchon)
// ============================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <ELECHOUSE_CC1101_SRC_DRV.h>

// ── Config ────────────────────────────────────────────────────
const char* WIFI_SSID   = "YOUR_SSID";        // ← change
const char* WIFI_PASS   = "YOUR_PASSWORD";     // ← change
const char* MQTT_BROKER = "192.168.1.100";     // ← Pi 5 IP
const int   MQTT_PORT   = 1883;
const char* DEVICE_NAME = "tacops-esp32-rf433";

#define GDO0_PIN 2
#define RECEIVE_BUFFER 64

// ── Globals ───────────────────────────────────────────────────
WiFiClient   wifiClient;
PubSubClient mqtt(wifiClient);

byte         rxBuffer[RECEIVE_BUFFER];
unsigned long lastHeartbeat = 0;

// Protocol detection helpers
const char* detectProtocol(byte* buf, int len, float rssi);
String bytesToHex(byte* buf, int len);

// ── Setup ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n[TACOPS] CC1101 RF433 Scanner starting...");

  connectWifi();
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setBufferSize(2048);

  // CC1101 initialization
  ELECHOUSE_cc1101.setSpiPin(18, 19, 23, 5); // SCK, MISO, MOSI, CSN
  ELECHOUSE_cc1101.Init();
  ELECHOUSE_cc1101.setMHZ(433.92);   // 433.92 MHz standard
  ELECHOUSE_cc1101.SetRx();          // Enter receive mode
  ELECHOUSE_cc1101.setPA(10);        // PA level (dBm): -30,-20,-15,-10,0,5,7,10
  ELECHOUSE_cc1101.setCCMode(1);     // ASK/OOK mode (best for 433 MHz remotes)
  ELECHOUSE_cc1101.setModulation(2); // ASK/OOK
  ELECHOUSE_cc1101.setDRate(4.8);    // 4.8 kbaud — good general rate

  pinMode(GDO0_PIN, INPUT);
  Serial.printf("[CC1101] Initialized — listening on 433.92 MHz\n");

  // Cycle through frequencies to improve detection
  Serial.println("[TACOPS] Ready — scanning 433 MHz band");
}

// ── Main loop ─────────────────────────────────────────────────
void loop() {
  if (!mqtt.connected()) reconnectMqtt();
  mqtt.loop();

  // Check GDO0 — goes HIGH when carrier detected
  if (ELECHOUSE_cc1101.CheckRxFifo(100)) {
    int len = ELECHOUSE_cc1101.ReceiveData(rxBuffer);
    if (len > 0) {
      float rssi = ELECHOUSE_cc1101.getRssi();
      float lqi  = ELECHOUSE_cc1101.getLqi();
      publishSignal(rxBuffer, len, rssi, lqi);
    }
    ELECHOUSE_cc1101.SetRx(); // back to receive mode
  }

  // Heartbeat
  if (millis() - lastHeartbeat > 30000) {
    lastHeartbeat = millis();
    sendHeartbeat();
  }

  // Frequency hopping — scan nearby frequencies
  static int freqIdx = 0;
  static unsigned long lastFreqChange = 0;
  float freqs[] = {433.42, 433.92, 434.42, 315.00, 868.00};
  if (millis() - lastFreqChange > 3000) {
    freqIdx = (freqIdx + 1) % 5;
    ELECHOUSE_cc1101.setMHZ(freqs[freqIdx]);
    ELECHOUSE_cc1101.SetRx();
    lastFreqChange = millis();
  }
}

// ── Publish detected signal via MQTT ─────────────────────────
void publishSignal(byte* buf, int len, float rssi, float lqi) {
  String hexData = bytesToHex(buf, len);
  const char* proto = detectProtocol(buf, len, rssi);
  float currentFreq = ELECHOUSE_cc1101.getMHZ();

  Serial.printf("[RF433] Signal: proto=%s freq=%.2f data=%s rssi=%.1f\n",
    proto, currentFreq, hexData.c_str(), rssi);

  DynamicJsonDocument doc(512);
  doc["id"]    = String(millis(), HEX);
  doc["proto"] = proto;
  doc["freq"]  = String(currentFreq, 2);
  doc["data"]  = hexData;
  doc["rssi"]  = (int)rssi;
  doc["lqi"]   = (int)lqi;
  doc["len"]   = len;
  doc["ts"]    = millis();

  String out;
  serializeJson(doc, out);
  mqtt.publish("tacops/rf433_signal", out.c_str());
}

// ── Heartbeat ─────────────────────────────────────────────────
void sendHeartbeat() {
  DynamicJsonDocument doc(256);
  doc["device"] = DEVICE_NAME;
  doc["uptime"] = millis() / 1000;
  doc["heap"]   = ESP.getFreeHeap();
  doc["ip"]     = WiFi.localIP().toString();
  String out;
  serializeJson(doc, out);
  mqtt.publish("tacops/heartbeat", out.c_str());
}

// ── Simple protocol heuristics ────────────────────────────────
const char* detectProtocol(byte* buf, int len, float rssi) {
  if (len < 2) return "Too Short";

  // PT2262 — typical 12-bit remote: 3 bytes, starts with 0x00 or sync
  if (len == 3 && (buf[0] == 0x00 || buf[0] == 0xFF)) return "PT2262 Remote";

  // 24-bit Oregon/LaCrosse temperature sensors
  if (len >= 8 && len <= 12) {
    if ((buf[0] & 0xF0) == 0xA0) return "Oregon Scientific";
    if ((buf[0] & 0xF0) == 0x90) return "LaCrosse TX";
  }

  // Typical EV1527-based remotes (24-bit)
  if (len == 3 && rssi > -70) return "EV1527 Remote";

  // Longer payloads — likely sensor with checksum
  if (len > 10) return "Sensor/Alarm Device";

  return "Unknown 433 MHz";
}

// ── Helpers ───────────────────────────────────────────────────
String bytesToHex(byte* buf, int len) {
  String hex = "0x";
  for (int i = 0; i < min(len, 8); i++) {
    if (buf[i] < 0x10) hex += "0";
    hex += String(buf[i], HEX);
  }
  hex.toUpperCase();
  return hex;
}

void connectWifi() {
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 30) {
    delay(500); Serial.print("."); tries++;
  }
  Serial.printf("\n[WiFi] IP: %s\n", WiFi.status() == WL_CONNECTED ?
    WiFi.localIP().toString().c_str() : "FAILED");
}

void reconnectMqtt() {
  while (!mqtt.connected()) {
    if (mqtt.connect(DEVICE_NAME)) {
      mqtt.publish("tacops/heartbeat",
        ("{\"device\":\"" + String(DEVICE_NAME) + "\",\"status\":\"online\"}").c_str());
    } else {
      delay(5000);
    }
  }
}
