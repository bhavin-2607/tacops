// ============================================================
//  modules/mqtt-bridge.js — MQTT bridge for ESP32 sensors
//
//  Topic schema:
//    tacops/wifi       → [{ssid,bssid,ch,rssi,enc,band,cli}]
//    tacops/ble        → [{name,mac,rssi,type}]
//    tacops/nrf24      → [{ch:0-125, v:0-100}]  (126 channels)
//    tacops/alert      → {msg, sev}
//    tacops/heartbeat  → {device, uptime, heap}
// ============================================================
const mqtt = require("mqtt");

const BROKER_URL = process.env.MQTT_BROKER || "mqtt://127.0.0.1:1883";
const RETRY_MS   = 5000;

function start({ onWifi, onBle, onNrf24, onConnect, onDisconnect }) {
  let client = null;
  let connected = false;

  function connect() {
    client = mqtt.connect(BROKER_URL, {
      clientId: "tacops-server",
      reconnectPeriod: RETRY_MS,
      connectTimeout: 4000,
    });

    client.on("connect", () => {
      connected = true;
      console.log(`[MQTT] Connected to ${BROKER_URL}`);
      client.subscribe("tacops/#", { qos: 0 }, err => {
        if (err) console.error("[MQTT] Subscribe error:", err.message);
        else console.log("[MQTT] Subscribed to tacops/#");
      });
      onConnect();
    });

    client.on("message", (topic, msgBuf) => {
      let payload;
      try { payload = JSON.parse(msgBuf.toString()); }
      catch { return; }

      const sub = topic.replace("tacops/", "");
      switch (sub) {
        case "wifi":
          onWifi(normalizeWifi(payload));
          break;
        case "ble":
          onBle(normalizeBle(payload));
          break;
        case "nrf24":
          onNrf24(normalizeNrf24(payload));
          break;
        case "heartbeat":
          console.log(`[MQTT] Heartbeat from ${payload.device} — uptime ${payload.uptime}s`);
          break;
        default:
          break;
      }
    });

    client.on("error", err => {
      console.warn(`[MQTT] Error: ${err.message}`);
    });

    client.on("offline", () => {
      if (connected) {
        console.warn("[MQTT] Broker offline");
        connected = false;
        onDisconnect();
      }
    });

    client.on("reconnect", () => {
      console.log("[MQTT] Reconnecting...");
    });
  }

  connect();
}

// ── Normalizers — handle variations in ESP32 firmware output ─

function normalizeWifi(raw) {
  if (!Array.isArray(raw)) raw = [raw];
  return raw.map((n, i) => ({
    id: i,
    ssid:  n.ssid  || n.SSID  || "Hidden",
    bssid: n.bssid || n.mac   || "00:00:00:00:00:00",
    ch:    n.ch    || n.channel || 1,
    rssi:  n.rssi  || n.RSSI   || -80,
    enc:   n.enc   || (n.encryption ? encType(n.encryption) : "WPA2"),
    band:  n.band  || (n.ch > 14 ? "5GHz" : "2.4GHz"),
    cli:   n.cli   || n.stations || 0,
  }));
}

function normalizeBle(raw) {
  if (!Array.isArray(raw)) raw = [raw];
  return raw.map((d, i) => ({
    id:   i,
    name: d.name || d.localName || "Unknown Device",
    mac:  d.mac  || d.address   || "00:00:00:00:00:00",
    rssi: d.rssi || d.RSSI      || -80,
    type: d.type || classifyBle(d.name || ""),
    seen: Date.now(),
  }));
}

function normalizeNrf24(raw) {
  // Expect array of {ch, v} or flat array of 126 values
  if (Array.isArray(raw) && typeof raw[0] === "number") {
    return raw.map((v, ch) => ({ ch, v }));
  }
  if (Array.isArray(raw) && raw[0]?.ch !== undefined) return raw;
  return Array.from({ length: 126 }, (_, ch) => ({ ch, v: 0 }));
}

function encType(code) {
  const map = { 0: "Open", 2: "WPA-PSK", 3: "WPA2-PSK", 4: "WPA/WPA2", 5: "WEP", 8: "WPA3" };
  return map[code] || "WPA2";
}

function classifyBle(name) {
  const n = name.toLowerCase();
  if (n.includes("iphone") || n.includes("android") || n.includes("pixel")) return "Phone";
  if (n.includes("airpod") || n.includes("wh-") || n.includes("headphone")) return "Audio";
  if (n.includes("band") || n.includes("fitbit") || n.includes("watch")) return "Wearable";
  if (n.includes("esp") || n.includes("arduino")) return "IoT";
  return "Unknown";
}

module.exports = { start };
