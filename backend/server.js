// ============================================================
//  TacticalOps Dashboard — Main Server
//  Raspberry Pi 5 Hub
//  Each module tries real hardware → falls back to simulation
//
//  Config: ../config.json  (single source of truth)
//  No state.json — all state is transient and rebuilt from
//  live hardware on each boot.
// ============================================================
const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const HistoryManager = require("./lib/historyManager");
const adsbModule   = require("./modules/adsb");
const rf433Module  = require("./modules/rf433");
const mqttBridge   = require("./modules/mqtt-bridge");

// ── Load config.json ─────────────────────────────────────────
let config = {
  server:  { port: 3000, host: "0.0.0.0", logLevel: "info" },
  modules: {
    adsb:      { enabled: true, host: "127.0.0.1", port: 30003, reconnectMs: 5000, historyLimit: 500, receiver: { lat: 0, lon: 0 } },
    rf433:     { enabled: true, mode: "disabled", historyLimit: 200 },
    mqtt:      { enabled: true, host: "127.0.0.1", port: 1883, reconnectMs: 5000 },
    simulator: { enabled: false },
  },
  storage: { dataDirectory: "data", historiesDirectory: "data/histories", autoCleanupDays: 30 },
  ui: {},
  security: { enableCors: true, maxRequestSize: "100kb" },
};

try {
  const configPath = path.join(__dirname, "..", "config.json");
  const loaded = require(configPath);
  config = { ...config, ...loaded };
  config.modules = { ...config.modules, ...loaded.modules };
  console.log("[CONFIG] Loaded from config.json");
} catch (err) {
  console.warn("[CONFIG] config.json not found — using defaults:", err.message);
}

const PORT     = config.server?.port || 3000;
const DATA_DIR = config.storage?.dataDirectory || "data";

// ── History manager ───────────────────────────────────────────
const HistoryManagerClass = require("./lib/historyManager");
const historyManager = new HistoryManagerClass(DATA_DIR);
(async () => await historyManager.init())();
historyManager.setLimits(config.storage?.historyLimits);

// ── Express setup ─────────────────────────────────────────────
const app = express();
if (config.security?.enableCors) app.use(cors());
app.use(express.json({ limit: config.security?.maxRequestSize || "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (config.server?.logLevel !== "silent")
      console.log(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now()-start}ms`);
  });
  next();
});

// ── HTTP + WebSocket server ───────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── Transient in-memory state ─────────────────────────────────
const state = {
  adsb:       { data: [], live: false },
  wifi:       { data: [], live: false },
  ble:        { data: [], live: false, history: [] },
  rf433:      { data: [], live: false },
  nrf24:      { data: Array.from({ length: 126 }, (_, ch) => ({ ch, v: 0 })), live: false },
  lora:       { data: [], live: false },
  nethunter:  { hosts: [], live: false },
  pwnagotchi: { captures: 0, mood: "bored", epoch: 0, live: false },
  mqtt:       { live: false },
  alerts:     [],
  config:     { rf433Mode: config.modules?.rf433?.mode || "disabled" },
  receiver:   {
    lat: config.modules?.adsb?.receiver?.lat || 0,
    lon: config.modules?.adsb?.receiver?.lon || 0,
  },
};

// ── Dedup tracking ────────────────────────────────────────────
const seenFlights = new Set();
const seenBle     = new Set();

// ── Validation helpers ────────────────────────────────────────
const isString = v => typeof v === "string" && v.trim().length > 0;
const isFinNum = v => typeof v === "number" && Number.isFinite(v);
const isInt    = v => Number.isInteger(v);

function safeHandler(fn) {
  return async (req, res, next) => {
    try { await Promise.resolve(fn(req, res, next)); }
    catch (err) { next(err); }
  };
}

function validatePwnagotchi(body) {
  if (!body || typeof body !== "object")          return "Expected JSON body";
  if (!isString(body.mood))                       return "Invalid mood";
  if (!isFinNum(body.epoch) || body.epoch < 0)    return "Invalid epoch";
  if (!isInt(body.captures) || body.captures < 0) return "Invalid captures";
  if (body.handshake !== undefined && typeof body.handshake !== "object") return "Invalid handshake";
  if (body.handshake?.ssid !== undefined && !isString(body.handshake.ssid)) return "Invalid handshake.ssid";
  return null;
}

function validateXiao(body) {
  if (!body || typeof body !== "object")                               return "Expected JSON body";
  if (!isString(body.type))                                            return "Invalid type";
  if (body.ts   !== undefined && (!isFinNum(body.ts)   || body.ts < 0)) return "Invalid timestamp";
  if (body.rssi !== undefined && !isFinNum(body.rssi))                 return "Invalid RSSI";
  return null;
}

function validateXiaoHeartbeat(body) {
  if (!body || typeof body !== "object")               return "Expected JSON body";
  if (!isFinNum(body.uptime) || body.uptime < 0)       return "Invalid uptime";
  if (!isFinNum(body.heap)   || body.heap   < 0)       return "Invalid heap";
  if (body.loraPkts !== undefined && !isInt(body.loraPkts)) return "Invalid loraPkts";
  return null;
}

function validateNethunter(body) {
  if (!body || typeof body !== "object")                                      return "Expected JSON body";
  if (body.device        !== undefined && !isString(body.device))             return "Invalid device";
  if (body.wifi_networks !== undefined && !Array.isArray(body.wifi_networks)) return "Invalid wifi_networks";
  if (body.ble_devices   !== undefined && !Array.isArray(body.ble_devices))   return "Invalid ble_devices";
  if (body.hosts         !== undefined && !Array.isArray(body.hosts))         return "Invalid hosts";
  if (body.lora_packets  !== undefined && !Array.isArray(body.lora_packets))  return "Invalid lora_packets";
  return null;
}

// ── Broadcast helpers ─────────────────────────────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function pushAlert(msg, sev = "info") {
  const alert = { id: Math.random().toString(36).slice(2), msg, sev, ts: Date.now() };
  state.alerts = [alert, ...state.alerts].slice(0, 100);
  broadcast("alert", alert);
}

// ── ADS-B module ──────────────────────────────────────────────
if (config.modules?.adsb?.enabled !== false) {
  adsbModule.start({
    onFlight: flights => {
      state.adsb.data = flights;
      state.adsb.live = true;

      flights.forEach(f => {
        const id = f.id || f.callsign;
        if (id && !seenFlights.has(id)) {
          seenFlights.add(id);
          pushAlert(`Flight detected: ${f.callsign || f.id}`, "info");
          historyManager.addEntry("adsb", { ...f, ts: f.ts || Date.now() });
        }
      });

      broadcast("adsb", { data: state.adsb.data, live: state.adsb.live });

      const emergency = flights.filter(f => f.squawk >= 7500 && f.squawk <= 7777);
      if (emergency.length) pushAlert(`Squawk ${emergency[0].squawk}: ${emergency[0].callsign}`, "danger");

      const lowAlt = flights.filter(f => f.alt > 0 && f.alt < 5000);
      if (lowAlt.length) pushAlert(`Low altitude: ${lowAlt[0].callsign || lowAlt[0].id} at ${lowAlt[0].alt}ft`, "warn");

      const noSign = flights.filter(f => !f.callsign && f.id);
      if (noSign.length) pushAlert(`Unidentified aircraft: ${noSign[0].id} at ${noSign[0].alt || "?"}ft`, "info");

      const fast = flights.filter(f => f.spd > 500);
      if (fast.length) pushAlert(`High speed: ${fast[0].callsign || fast[0].id} at ${fast[0].spd}kt`, "info");
    },
    onError: () => {
      if (state.adsb.live) pushAlert("ADS-B feed lost", "warn");
      state.adsb.live = false;
    },
    config,
  });
} else {
  console.log("[ADS-B] Module disabled via config.json");
}

// ── 433 MHz module ────────────────────────────────────────────
const rf433Mode = config.modules?.rf433?.mode || "disabled";
state.config.rf433Mode = rf433Mode;

if (rf433Mode === "usb") {
  rf433Module.start({
    onSignal: signal => {
      state.rf433.data = [signal, ...state.rf433.data].slice(0, config.modules.rf433.historyLimit || 200);
      state.rf433.live = true;
      broadcast("rf433", state.rf433.data);
      historyManager.addEntry("rf433", { ...signal, ts: signal.ts || Date.now() });
      pushAlert(`433 MHz: ${signal.proto} detected — ${signal.data}`, "warn");
    },
    onError: () => { state.rf433.live = false; },
  });
} else if (rf433Mode === "mqtt") {
  console.log("[RF433] MQTT mode — data arrives via MQTT bridge");
} else {
  console.log(`[RF433] Mode='${rf433Mode}' — module inactive`);
}

// ── MQTT bridge ───────────────────────────────────────────────
if (config.modules?.mqtt?.enabled !== false) {
  mqttBridge.start({
    onWifi: nets => {
      state.wifi.data = nets;
      state.wifi.live = true;
      broadcast("wifi", nets);
      const open = nets.filter(n => n.enc === "Open");
      if (open.length) pushAlert(`Open network detected: ${open[0].ssid}`, "warn");
    },
    onBle: devices => {
      state.ble.data = devices;
      state.ble.live = true;
      broadcast("ble", devices);
      devices.forEach(d => {
        if (d.mac && !seenBle.has(d.mac)) {
          seenBle.add(d.mac);
          state.ble.history = [d, ...(state.ble.history || [])].slice(0, 500);
        }
      });
    },
    onNrf24: channels => {
      state.nrf24.data = channels;
      state.nrf24.live = true;
      broadcast("nrf24", channels);
      const burst = channels.find(c => c.v > 80);
      if (burst) pushAlert(`nRF24 burst on channel ${burst.ch} — possible drone`, "danger");
    },
    onRf433: rf433Mode === "mqtt" ? (signal => {
      state.rf433.data = [signal, ...state.rf433.data].slice(0, config.modules.rf433.historyLimit || 200);
      state.rf433.live = true;
      broadcast("rf433", state.rf433.data);
      historyManager.addEntry("rf433", { ...signal, ts: signal.ts || Date.now() });
      pushAlert(`433 MHz: ${signal.proto} detected — ${signal.data}`, "warn");
    }) : undefined,
    onConnect: () => {
      state.mqtt.live = true;
      broadcast("mqtt", state.mqtt);
      pushAlert("MQTT broker connected — ESP32 sensors online", "info");
    },
    onDisconnect: () => {
      state.mqtt.live = false;
      broadcast("mqtt", state.mqtt);
      state.wifi.live  = false;
      state.ble.live   = false;
      state.nrf24.live = false;
      if (rf433Mode === "mqtt") state.rf433.live = false;
      pushAlert("MQTT broker disconnected — ESP32 sensors offline", "warn");
    },
  });
} else {
  console.log("[MQTT] Bridge disabled via config.json");
}

// ── REST — state & status ─────────────────────────────────────
app.get("/api/state",  (req, res) => res.json(state));
app.get("/api/status", (req, res) => res.json({
  adsb:       state.adsb.live,
  wifi:       state.wifi.live,
  ble:        state.ble.live,
  rf433:      state.rf433.live,
  nrf24:      state.nrf24.live,
  lora:       state.lora.live,
  pwnagotchi: state.pwnagotchi.live,
  mqtt:       state.mqtt.live,
}));
app.get("/api/config", (req, res) => res.json({
  config: { server: config.server, modules: config.modules, storage: config.storage, ui: config.ui },
  lastModified: new Date(),
}));

// ── REST — history ────────────────────────────────────────────
app.get("/api/history/:module", async (req, res) => {
  try {
    const history = await historyManager.getHistory(req.params.module);
    res.json({ module: req.params.module, count: history.length, data: history });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/history/:module", async (req, res) => {
  try {
    await historyManager.clearHistory(req.params.module);
    res.json({ ok: true, message: `Cleared ${req.params.module} history` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Pwnagotchi endpoint ───────────────────────────────────────
app.post("/api/pwnagotchi", safeHandler((req, res) => {
  const err = validatePwnagotchi(req.body);
  if (err) return res.status(400).json({ ok: false, error: err });
  const { mood, epoch, captures, handshake } = req.body;
  state.pwnagotchi = { mood, epoch, captures, live: true };
  if (handshake) {
    pushAlert(`Pwnagotchi captured handshake: ${handshake.ssid}`, "info");
    state.pwnagotchi.captures = (state.pwnagotchi.captures || 0) + 1;
  }
  broadcast("pwnagotchi", state.pwnagotchi);
  res.json({ ok: true });
}));

// ── XIAO endpoints ────────────────────────────────────────────
app.post("/api/xiao", safeHandler((req, res) => {
  const err = validateXiao(req.body);
  if (err) return res.status(400).json({ ok: false, error: err });
  const pkt = { ...req.body, ts: req.body.ts || Date.now() };
  state.lora.data = [pkt, ...state.lora.data].slice(0, 200);
  state.lora.live = true;
  broadcast("lora", state.lora.data);
  if (pkt.meshtastic) pushAlert(`Meshtastic node detected — RSSI ${pkt.rssi}dBm`, "info");
  else                pushAlert(`LoRa packet on ${pkt.freq}MHz — RSSI ${pkt.rssi}dBm`, "info");
  res.json({ ok: true });
}));

app.post("/api/xiao/heartbeat", safeHandler((req, res) => {
  const err = validateXiaoHeartbeat(req.body);
  if (err) return res.status(400).json({ ok: false, error: err });
  console.log(`[XIAO] Heartbeat — uptime:${req.body.uptime}s heap:${req.body.heap} loraPkts:${req.body.loraPkts}`);
  res.json({ ok: true });
}));

// ── NetHunter endpoint ────────────────────────────────────────
app.post("/api/nethunter", safeHandler((req, res) => {
  const err = validateNethunter(req.body);
  if (err) return res.status(400).json({ ok: false, error: err });

  const { wifi_networks, wifi_probes, ble_devices, hosts, lora_packets, gps, device, ts } = req.body;

  if (Array.isArray(wifi_networks) && wifi_networks.length > 0) {
    const normalized = wifi_networks.map((n, i) => ({
      id: n.bssid || i, ssid: n.ssid || "Hidden", bssid: n.bssid || "00:00:00:00:00:00",
      ch: n.ch || 0, rssi: n.rssi || -80, enc: n.enc || "WPA2",
      band: n.band || "2.4GHz", cli: 0, source: "nethunter",
    }));
    normalized.forEach(n => {
      const idx = state.wifi.data.findIndex(x => x.bssid === n.bssid);
      if (idx >= 0) state.wifi.data[idx] = n;
      else state.wifi.data = [n, ...state.wifi.data].slice(0, 40);
    });
    state.wifi.live = true;
    broadcast("wifi", state.wifi.data);
  }

  if (Array.isArray(ble_devices) && ble_devices.length > 0) {
    state.ble.data = ble_devices;
    state.ble.live = true;
    broadcast("ble", ble_devices);
  }

  if (Array.isArray(lora_packets) && lora_packets.length > 0) {
    state.lora.data = [...lora_packets, ...state.lora.data].slice(0, 50);
    state.lora.live = true;
    broadcast("lora", state.lora.data);
    lora_packets.forEach(p => pushAlert(`LoRa node detected: ${p.node_id || "unknown"} RSSI ${p.rssi || "?"}dBm`, "info"));
  }

  if (Array.isArray(wifi_probes) && wifi_probes.length > 0) {
    wifi_probes.slice(0, 3).forEach(p => {
      if (p.ssid) pushAlert(`Probe: ${p.mac} → "${p.ssid}"`, "info");
    });
  }

  if (Array.isArray(hosts) && hosts.length > 0) {
    const prevIPs = new Set((state.nethunter.hosts || []).map(h => h.ip));
    hosts.forEach(h => { if (!prevIPs.has(h.ip)) pushAlert(`New host: ${h.ip}${h.name ? ` (${h.name})` : ""}`, "warn"); });
    state.nethunter = { hosts, live: true, gps: gps || null, device: device || "nethunter", ts };
    broadcast("nethunter", state.nethunter);
  }

  console.log(`[NetHunter] ${device} → wifi:${(wifi_networks||[]).length} ble:${(ble_devices||[]).length} hosts:${(hosts||[]).length} lora:${(lora_packets||[]).length}`);
  res.json({ ok: true, ts: Date.now() });
}));

// ── WebSocket ─────────────────────────────────────────────────
wss.on("connection", ws => {
  console.log("[WS] Client connected");
  ws.send(JSON.stringify({ type: "init", payload: state, ts: Date.now() }));
  ws.on("message", msg => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "clear_alerts") {
        state.alerts = [];
        broadcast("clear_alerts", null);
      }
    } catch (e) {}
  });
  ws.on("close", () => console.log("[WS] Client disconnected"));
});

// ── Error handlers ────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: "Endpoint not found" }));
app.use((err, req, res, next) => {
  console.error("[ERROR]", err.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║   TACTICALOPS DASHBOARD BACKEND    ║`);
  console.log(`║   http://localhost:${PORT}           ║`);
  console.log(`║   rf433: ${rf433Mode.padEnd(25)}║`);
  console.log(`╚════════════════════════════════════╝\n`);
});