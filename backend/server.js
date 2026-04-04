// ============================================================
//  TacticalOps Dashboard — Main Server
//  Raspberry Pi 5 Hub
//  Each module tries real hardware → falls back to simulation
// ============================================================
const fs = require("fs").promises;
const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const HistoryManager = require("./lib/historyManager");
const adsbModule   = require("./modules/adsb");
const rf433Module  = require("./modules/rf433");
const mqttBridge   = require("./modules/mqtt-bridge");
const simulator    = require("./modules/simulator");

// ── Load config from config.json ─────────────────────────
let config = {
  server: { port: 3000 },
  modules: {
    adsb: { enabled: true, host: "127.0.0.1", port: 30003 },
    rf433: { enabled: true, mode: "usb" },
    mqtt: { enabled: true },
  },
  storage: { dataDirectory: "data" },
};

try {
  const configPath = path.join(__dirname, "..", "config.json");
  const configData = require(configPath);
  config = { ...config, ...configData };
  console.log("[CONFIG] Loaded from config.json");
} catch (err) {
  console.warn("[CONFIG] Using defaults, config.json not found:", err.message);
}

const PORT = config.server?.port || 3000;
const DATA_DIR = config.storage?.dataDirectory || "data";
const STATE_FILE = path.join(__dirname, config.storage?.stateFile || "state.json");

// Initialize history manager
const historyManager = new HistoryManager(DATA_DIR);
(async () => await historyManager.init())();
historyManager.setLimits(config.storage?.historyLimits);

// Track seen flights to avoid duplicate alerts
let seenFlights = new Set();
let seenBle = new Set();

// ── Express setup ────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function logRequest(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const elapsed = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${elapsed}ms`);
  });
  next();
}

app.use(logRequest);

// ── HTTP + WebSocket server ──────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Shared state (transient, no history) ────────────────
const state = {
  adsb:     { data: [], live: false },
  wifi:     { data: [], live: false },
  ble:      { data: [], live: false },
  rf433:    { data: [], live: false },
  nrf24:    { data: [], live: false },
  lora:     { data: [], live: false },
  nethunter:{ hosts: [], live: false },
  pwnagotchi: { captures: 0, mood: "bored", epoch: 0, live: false },
  mqtt:     { live: false },
  alerts:   [],
  config:   { rf433Mode: config.modules?.rf433?.mode || "usb" },
};

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function safeHandler(fn) {
  return async (req, res, next) => {
    try {
      await Promise.resolve(fn(req, res, next));
    } catch (err) {
      next(err);
    }
  };
}

function validatePwnagotchi(body) {
  if (!body || typeof body !== "object") return "Expected JSON body";
  if (!isString(body.mood)) return "Invalid mood";
  if (!isFiniteNumber(body.epoch) || body.epoch < 0) return "Invalid epoch";
  if (!Number.isInteger(body.captures) || body.captures < 0) return "Invalid captures";
  if (body.handshake !== undefined && typeof body.handshake !== "object") return "Invalid handshake";
  if (body.handshake && body.handshake.ssid !== undefined && !isString(body.handshake.ssid)) return "Invalid handshake.ssid";
  return null;
}

function validateXiao(body) {
  if (!body || typeof body !== "object") return "Expected JSON body";
  if (!isString(body.type)) return "Invalid type";
  if (body.ts !== undefined && (!isFiniteNumber(body.ts) || body.ts < 0)) return "Invalid timestamp";
  if (body.rssi !== undefined && !isFiniteNumber(body.rssi)) return "Invalid RSSI";
  return null;
}

function validateXiaoHeartbeat(body) {
  if (!body || typeof body !== "object") return "Expected JSON body";
  if (!isFiniteNumber(body.uptime) || body.uptime < 0) return "Invalid uptime";
  if (!isFiniteNumber(body.heap) || body.heap < 0) return "Invalid heap";
  if (body.loraPkts !== undefined && !Number.isInteger(body.loraPkts)) return "Invalid loraPkts";
  return null;
}

function validateNethunter(body) {
  if (!body || typeof body !== "object") return "Expected JSON body";
  if (body.device !== undefined && !isString(body.device)) return "Invalid device";
  if (body.wifi_networks !== undefined && !Array.isArray(body.wifi_networks)) return "Invalid wifi_networks";
  if (body.ble_devices !== undefined && !Array.isArray(body.ble_devices)) return "Invalid ble_devices";
  if (body.hosts !== undefined && !Array.isArray(body.hosts)) return "Invalid hosts";
  if (body.lora_packets !== undefined && !Array.isArray(body.lora_packets)) return "Invalid lora_packets";
  return null;
}

// ── Load persisted state ─────────────────────────────────────
async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, "utf8");
    const persisted = JSON.parse(data);
    Object.assign(state, persisted);

    // Live flags are transient and should not survive a restart.
    ["adsb","wifi","ble","rf433","nrf24","lora","nethunter","pwnagotchi","mqtt"].forEach(key => {
      if (state[key] && typeof state[key] === "object") state[key].live = false;
    });

    console.log("[STATE] Loaded persisted state");
  } catch (err) {
    console.log("[STATE] No persisted state found, starting fresh");
  }
}

// ── Save state to disk ───────────────────────────────────────
async function saveState() {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn("[STATE] Failed to save state:", err.message);
  }
}

// ── Load persisted state ─────────────────────────────────────
(async () => {
  await loadState();
})();

// ── Broadcast to all connected WS clients ───────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function pushAlert(msg, sev = "info") {
  const alert = { id: Math.random().toString(36).slice(2), msg, sev, ts: Date.now() };
  state.alerts = [alert, ...state.alerts].slice(0, 100);
  broadcast("alert", alert);
}

// ── ADS-B module (RTL-SDR → dump1090) ───────────────────────
adsbModule.start({
  onFlight: flights => {
    state.adsb.data = flights;
    state.adsb.live = true;

    // Alert for new flights (and accumulate history)
    flights.forEach(f => {
      const id = f.id || f.callsign;
      if (id && !seenFlights.has(id)) {
        seenFlights.add(id);
        pushAlert(`Flight detected: ${f.callsign || f.id}`, "info");
        // Add to history file
        historyManager.addEntry("adsb", { ...f, ts: f.ts || Date.now() });
      }
    });

    // Broadcast updated ADS-B state
    broadcast("adsb", {
      data: state.adsb.data,
      live: state.adsb.live,
    });

    const emergency = flights.filter(f => f.squawk >= 7500 && f.squawk <= 7777);
    if (emergency.length) pushAlert(`Squawk ${emergency[0].squawk}: ${emergency[0].callsign}`, "danger");

    // Additional alerts
    const lowAlt = flights.filter(f => f.alt < 5000 && f.alt > 0);
    if (lowAlt.length) pushAlert(`Low altitude: ${lowAlt[0].callsign || lowAlt[0].id} at ${lowAlt[0].alt}ft`, "warn");

    const noCallsign = flights.filter(f => !f.callsign && f.id);
    if (noCallsign.length) pushAlert(`Unidentified aircraft: ${noCallsign[0].id} at ${noCallsign[0].alt || '?'}ft`, "info");

    const highSpeed = flights.filter(f => f.spd > 500);
    if (highSpeed.length) pushAlert(`High speed: ${highSpeed[0].callsign || highSpeed[0].id} at ${highSpeed[0].spd}kt`, "info");
  },
  onError: () => {
    if (state.adsb.live) pushAlert("RTL-SDR ADS-B feed lost — switching to simulation", "warn");
    state.adsb.live = false;
  }
});

// ── 433 MHz module (RTL-SDR → rtl_433 or MQTT) ──────────────────────
const rf433Mode = config.modules?.rf433?.mode || "disabled";
state.config.rf433Mode = rf433Mode;
if (rf433Mode === "mqtt") {
  // 433MHz data is consumed via MQTT topic tacops/rf433_signal
  console.log("[RF433] MQTT mode enabled");
} else if (rf433Mode === "usb") {
  rf433Module.start({
    onSignal: signal => {
      state.rf433.data = [signal, ...state.rf433.data].slice(0, 200);
      state.rf433.live = true;
      broadcast("rf433", state.rf433.data);
      historyManager.addEntry("rf433", { ...signal, ts: signal.ts || Date.now() });
      pushAlert(`433 MHz: ${signal.proto} detected — ${signal.data}`, "warn");
    },
    onError: () => { state.rf433.live = false; }
  });
} else if (rf433Mode === "disabled") {
  console.log("[RF433] Module disabled via config.json");
  state.rf433.live = false;
} else {
  console.warn(`\n[RF433] Unknown RF433 mode='${rf433Mode}', falling back to disabled\n`);
  rf433Module.start({
    onSignal: signal => {
      state.rf433.data = [signal, ...state.rf433.data].slice(0, 200);
      state.rf433.live = true;
      broadcast("rf433", state.rf433.data);
      pushAlert(`433 MHz: ${signal.proto} detected — ${signal.data}`, "warn");
    },
    onError: () => { state.rf433.live = false; }
  });
}

// ── MQTT bridge (ESP32s → Pi 5) ──────────────────────────────
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
    // Add to history
    devices.forEach(d => {
      const id = d.mac;
      if (id && !seenBle.has(id)) {
        seenBle.add(id);
        state.ble.history = state.ble.history || [];
        state.ble.history.push(d);
        state.ble.history = state.ble.history.slice(-500);
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
    state.rf433.data = [signal, ...state.rf433.data].slice(0, 200);
    state.rf433.live = true;
    broadcast("rf433", state.rf433.data);
    pushAlert(`433 MHz: ${signal.proto} detected — ${signal.data}`, "warn");
  }) : undefined,
  onConnect: () => {
    state.mqtt.live = true;
    broadcast("mqtt", state.mqtt);
    pushAlert("MQTT broker connected — ESP32 sensors online", "info");
    // Do not assume RF433 is live just because the MQTT broker connected.
    // RF433 should become live only when actual RF433 MQTT messages arrive.
  },
  onDisconnect: () => {
    state.mqtt.live = false;
    broadcast("mqtt", state.mqtt);
    state.wifi.live = false;
    state.ble.live = false;
    state.nrf24.live = false;
    if (rf433Mode === "mqtt") state.rf433.live = false;
    pushAlert("MQTT broker disconnected — ESP32 sensors offline", "warn");
  }
});

// ── Pwnagotchi webhook endpoint ──────────────────────────────
app.post("/api/pwnagotchi", safeHandler((req, res) => {
  const error = validatePwnagotchi(req.body);
  if (error) return res.status(400).json({ ok: false, error });

  const { mood, epoch, captures, handshake } = req.body;
  state.pwnagotchi = { mood, epoch, captures, live: true };
  if (handshake) {
    pushAlert(`Pwnagotchi captured handshake: ${handshake.ssid}`, "info");
    state.pwnagotchi.captures = (state.pwnagotchi.captures || 0) + 1;
  }
  broadcast("pwnagotchi", state.pwnagotchi);
  res.json({ ok: true });
}));

// ── XIAO ESP32S3 dedicated endpoint (field mode HTTP POST) ───
app.post("/api/xiao", safeHandler((req, res) => {
  const error = validateXiao(req.body);
  if (error) return res.status(400).json({ ok: false, error });

  const pkt = req.body;
  if (!pkt.type) return res.status(400).json({ ok: false, error: "Missing packet type" });

  state.lora = state.lora || { data: [], live: false };
  pkt.ts = pkt.ts || Date.now();

  state.lora.data = [pkt, ...state.lora.data].slice(0, 200);
  state.lora.live = true;
  broadcast("lora", state.lora.data);

  if (pkt.meshtastic) pushAlert(`Meshtastic node detected — RSSI ${pkt.rssi}dBm`, "info");
  else pushAlert(`LoRa packet on ${pkt.freq}MHz — RSSI ${pkt.rssi}dBm`, "info");

  res.json({ ok: true });
}));

app.post("/api/xiao/heartbeat", safeHandler((req, res) => {
  const error = validateXiaoHeartbeat(req.body);
  if (error) return res.status(400).json({ ok: false, error });

  console.log(`[XIAO] Heartbeat — uptime:${req.body.uptime}s heap:${req.body.heap} loraPkts:${req.body.loraPkts}`);
  res.json({ ok: true });
}));

// ── NetHunter field agent endpoint ──────────────────────────
app.post("/api/nethunter", safeHandler((req, res) => {
  const payloadError = validateNethunter(req.body);
  if (payloadError) return res.status(400).json({ ok: false, error: payloadError });

  const { wifi_networks, wifi_probes, ble_devices, hosts, lora_packets, gps, device, ts } = req.body;

  // Merge WiFi networks into wifi state
  if (Array.isArray(wifi_networks) && wifi_networks.length > 0) {
    const normalized = wifi_networks.map((n, i) => ({
      id:     n.bssid || i,
      ssid:   n.ssid  || "Hidden",
      bssid:  n.bssid || "00:00:00:00:00:00",
      ch:     n.ch    || 0,
      rssi:   n.rssi  || -80,
      enc:    n.enc   || "WPA2",
      band:   n.band  || "2.4GHz",
      cli:    0,
      source: "nethunter",
    }));
    // Merge with existing — don't wipe pwnagotchi entries
    normalized.forEach(n => {
      const idx = state.wifi.data.findIndex(x => x.bssid === n.bssid);
      if (idx >= 0) state.wifi.data[idx] = n;
      else state.wifi.data = [n, ...state.wifi.data].slice(0, 40);
    });
    state.wifi.live = true;
    broadcast("wifi", state.wifi.data);
  }

  // Merge BLE devices
  if (Array.isArray(ble_devices) && ble_devices.length > 0) {
    state.ble.data = ble_devices;
    state.ble.live = true;
    broadcast("ble", ble_devices);
  }

  // LoRa packets → new lora state
  if (Array.isArray(lora_packets) && lora_packets.length > 0) {
    state.lora = state.lora || { data: [], live: false };
    state.lora.data = [...lora_packets, ...(state.lora.data || [])].slice(0, 50);
    state.lora.live = true;
    broadcast("lora", state.lora.data);

    lora_packets.forEach(p => {
      pushAlert(`LoRa node detected: ${p.node_id || "unknown"} RSSI ${p.rssi || "?"}dBm`, "info");
    });
  }

  // WiFi probe requests → alerts
  if (Array.isArray(wifi_probes) && wifi_probes.length > 0) {
    wifi_probes.slice(0, 3).forEach(p => {
      if (p.ssid) pushAlert(`Probe: ${p.mac} → "${p.ssid}"`, "info");
    });
  }

  // Network hosts → alerts for new ones
  if (Array.isArray(hosts) && hosts.length > 0) {
    state.nethunter = state.nethunter || { hosts: [], live: false };
    const prevIPs = new Set((state.nethunter.hosts || []).map(h => h.ip));
    hosts.forEach(h => {
      if (!prevIPs.has(h.ip)) pushAlert(`New host: ${h.ip} ${h.name ? "("+h.name+")" : ""}`, "warn");
    });
    state.nethunter.hosts = hosts;
    state.nethunter.live  = true;
    state.nethunter.gps   = gps || null;
    state.nethunter.device = device || "nethunter";
    state.nethunter.ts    = ts;
    broadcast("nethunter", state.nethunter);
  }

  console.log(`[NetHunter] ${device} → wifi:${(wifi_networks||[]).length} ble:${(ble_devices||[]).length} hosts:${(hosts||[]).length} lora:${(lora_packets||[]).length}`);
  res.json({ ok: true, ts: Date.now() });
}));



// ── REST API — current state snapshot ────────────────────────
app.get("/api/state", (req, res) => res.json(state));
app.get("/api/status", (req, res) => res.json({
  adsb:       state.adsb.live,
  wifi:       state.wifi.live,
  ble:        state.ble.live,
  rf433:      state.rf433.live,
  nrf24:      state.nrf24.live,
  pwnagotchi: state.pwnagotchi.live,
}));

// ── History API endpoints ────────────────────────────────────
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

app.get("/api/config", (req, res) => {
  res.json({ 
    config: {
      server: config.server,
      modules: config.modules,
      storage: config.storage,
    },
    lastModified: new Date(),
  });
});

// ── Simulation tick (fills any offline module with fake data) 
setInterval(() => {
  const { adsb, wifi, ble, rf433, nrf24 } = state;

  // if (!adsb.live) {
  //   const flights = simulator.genFlights();
  //   state.adsb.data = flights;
  //   broadcast("adsb", flights);
  // }
  // if (!wifi.live) {
  //   const nets = simulator.genNets();
  //   state.wifi.data = nets;
  //   broadcast("wifi", nets);
  // }
  // if (!ble.live) {
  //   const devices = simulator.genBle();
  //   state.ble.data = devices;
  //   broadcast("ble", devices);
  // }
  // // if (!rf433.live && Math.random() > 0.6) {
  // //   const signal = simulator.genRf433Signal();
  // //   state.rf433.data = [signal, ...state.rf433.data].slice(0, 40);
  // //   broadcast("rf433", state.rf433.data);
  // // }
  // if (!nrf24.live) {
  //   const channels = simulator.genNrf24();
  //   state.nrf24.data = channels;
  //   broadcast("nrf24", channels);
  // }
  // if (!state.pwnagotchi.live && Math.random() > 0.85) {
  //   state.pwnagotchi.captures = (state.pwnagotchi.captures || 0) + 1;
  //   broadcast("pwnagotchi", state.pwnagotchi);
  // }

  // broadcast("spectrum", simulator.genSpectrum());

  // Save state periodically
  // saveState();

}, 2800);

// ── WebSocket handshake — send full state on connect ────────
wss.on("connection", ws => {
  console.log("[WS] Client connected");
  ws.send(JSON.stringify({ type: "init", payload: state, ts: Date.now() }));
  ws.on("message", msg => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "clear_alerts") {
        state.alerts = [];
        broadcast("clear_alerts", null);
        saveState(); // Save cleared state
      }
    } catch (e) {}
  });
  ws.on("close", () => console.log("[WS] Client disconnected"));
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Endpoint not found" });
});

app.use((err, req, res, next) => {
  console.error("[ERROR]", err.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║   TACTICALOPS DASHBOARD BACKEND    ║`);
  console.log(`║   http://localhost:${PORT}           ║`);
  console.log(`╚════════════════════════════════════╝\n`);
});
