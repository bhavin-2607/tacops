// ============================================================
//  TacticalOps Dashboard — Main Server
//  Raspberry Pi 5 Hub
//  Each module tries real hardware → falls back to simulation
//
//  v2.1 — TACINT Memory: rolling event log across all sensors
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

// ── Load config ──────────────────────────────────────────────
let config = {
  server: { port: 3000 },
  modules: {
    adsb: { enabled: true, host: "0.0.0.0", port: 30003 },
    rf433: { enabled: true, mode: "usb" },
    mqtt: { enabled: false },
  },
  storage: { dataDirectory: "data" },
};

try {
  const configPath = path.join(__dirname, "..", "config.json");
  const configData = require(configPath);
  config = { ...config, ...configData };
  console.log("[CONFIG] Loaded from config.json");
} catch (err) {
  console.warn("[CONFIG] Using defaults:", err.message);
}

const PORT       = config.server?.port || 3000;
const DATA_DIR   = config.storage?.dataDirectory || "data";
const STATE_FILE = path.join(__dirname, config.storage?.stateFile || "state.json");

const historyManager = new HistoryManager(DATA_DIR);
(async () => await historyManager.init())();
historyManager.setLimits(config.storage?.historyLimits);

let seenFlights = new Set();
let seenBle     = new Set();

// ── Express ──────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function logRequest(req, res, next) {
  const start = Date.now();
  res.on("finish", () => console.log(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now()-start}ms`));
  next();
}
app.use(logRequest);

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── State ────────────────────────────────────────────────────
const state = {
  adsb:        { data: [], live: false },
  wifi:        { data: [], live: false },
  ble:         { data: [], live: false },
  rf433:       { data: [], live: false },
  nrf24:       { data: [], live: false },
  lora:        { data: [], live: false },
  nethunter:   { hosts: [], live: false },
  pwnagotchi:  { captures: 0, mood: "bored", epoch: 0, live: false },
  mqtt:        { live: false },
  alerts:      [],
  config:      { rf433Mode: config.modules?.rf433?.mode || "usb" },
  receiver:    {
    lat: config.modules?.adsb?.receiver?.lat || 0,
    lon: config.modules?.adsb?.receiver?.lon || 0,
  },
  // ── TACINT Memory ──────────────────────────────────────────
  eventLog:    [],   // rolling array, max 200, newest first
  _eventSeq:   0,    // monotonic counter, not sent to clients directly
};

// ── Validation helpers ───────────────────────────────────────
const isString       = v => typeof v === "string" && v.trim().length > 0;
const isFiniteNumber = v => typeof v === "number" && Number.isFinite(v);

function safeHandler(fn) {
  return async (req, res, next) => {
    try { await Promise.resolve(fn(req, res, next)); }
    catch (err) { next(err); }
  };
}

function validatePwnagotchi(b) {
  if (!b || typeof b !== "object") return "Expected JSON body";
  if (!isString(b.mood))                                        return "Invalid mood";
  if (!isFiniteNumber(b.epoch) || b.epoch < 0)                 return "Invalid epoch";
  if (!Number.isInteger(b.captures) || b.captures < 0)         return "Invalid captures";
  if (b.handshake !== undefined && typeof b.handshake !== "object") return "Invalid handshake";
  if (b.handshake?.ssid !== undefined && !isString(b.handshake.ssid)) return "Invalid handshake.ssid";
  return null;
}
function validateXiao(b) {
  if (!b || typeof b !== "object") return "Expected JSON body";
  if (!isString(b.type))           return "Invalid type";
  if (b.ts !== undefined && (!isFiniteNumber(b.ts) || b.ts < 0)) return "Invalid timestamp";
  if (b.rssi !== undefined && !isFiniteNumber(b.rssi))          return "Invalid RSSI";
  return null;
}
function validateXiaoHeartbeat(b) {
  if (!b || typeof b !== "object")                              return "Expected JSON body";
  if (!isFiniteNumber(b.uptime) || b.uptime < 0)               return "Invalid uptime";
  if (!isFiniteNumber(b.heap)   || b.heap < 0)                 return "Invalid heap";
  if (b.loraPkts !== undefined && !Number.isInteger(b.loraPkts)) return "Invalid loraPkts";
  return null;
}
function validateNethunter(b) {
  if (!b || typeof b !== "object")                              return "Expected JSON body";
  if (b.device        !== undefined && !isString(b.device))    return "Invalid device";
  if (b.wifi_networks !== undefined && !Array.isArray(b.wifi_networks)) return "Invalid wifi_networks";
  if (b.ble_devices   !== undefined && !Array.isArray(b.ble_devices))   return "Invalid ble_devices";
  if (b.hosts         !== undefined && !Array.isArray(b.hosts))          return "Invalid hosts";
  if (b.lora_packets  !== undefined && !Array.isArray(b.lora_packets))   return "Invalid lora_packets";
  return null;
}

// ── Broadcast ────────────────────────────────────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ══════════════════════════════════════════════════════════════
//  TACINT MEMORY — pushEvent()
//  Every sensor module calls this to record an intelligence event.
//  The rolling log (max 200) is injected into TACINT's system
//  prompt on each query so Claude reasons across time.
// ══════════════════════════════════════════════════════════════
function pushEvent(category, subtype, data = {}, sev = "info") {
  const entry = {
    seq: ++state._eventSeq,
    ts:  Date.now(),
    cat: category,
    sub: subtype,
    sev,
    ...data,
  };
  state.eventLog = [entry, ...state.eventLog].slice(0, 200);
  // Broadcast incremental addition — clients merge into their local copy
  broadcast("eventlog_add", entry);
  return entry;
}

// ── pushAlert — unchanged signature, now also logs to eventLog ─
function pushAlert(msg, sev = "info") {
  const alert = { id: Math.random().toString(36).slice(2), msg, sev, ts: Date.now() };
  state.alerts = [alert, ...state.alerts].slice(0, 100);
  broadcast("alert", alert);

  // Infer category from message text so the event log is categorised
  const cat =
    /[Ff]light|aircraft|[Ss]quawk|callsign|ADS-B/.test(msg) ? "adsb"    :
    /[Ww]i[Ff]i|network|[Ss]SID|[Pp]robe|[Ee]nc/.test(msg)  ? "wifi"    :
    /BLE|[Bb]luetooth/.test(msg)                              ? "ble"     :
    /433/.test(msg)                                            ? "rf433"   :
    /nRF24|drone|2\.4/.test(msg)                              ? "nrf24"   :
    /[Ll]o[Rr]a|[Mm]eshtastic/.test(msg)                     ? "lora"    :
    /MQTT/.test(msg)                                           ? "mqtt"    :
    /[Nn]et[Hh]unter|host/.test(msg)                         ? "nethunter":
    /[Pp]wnagotchi|handshake/.test(msg)                       ? "pwnagotchi":
    "system";

  // pushEvent(cat, "alert_mirror", { msg }, sev);
}

// ── Load / save state ─────────────────────────────────────────
async function loadState() {
  try {
    const data      = await fs.readFile(STATE_FILE, "utf8");
    const persisted = JSON.parse(data);
    Object.assign(state, persisted);

    // Restore sequence counter from persisted log
    if (state.eventLog?.length)
      state._eventSeq = Math.max(...state.eventLog.map(e => e.seq || 0));
    else
      state._eventSeq = 0;

    // Live flags are transient
    ["adsb","wifi","ble","rf433","nrf24","lora","nethunter","pwnagotchi","mqtt"].forEach(k => {
      if (state[k] && typeof state[k] === "object") state[k].live = false;
    });

    console.log(`[STATE] Loaded — ${state.eventLog.length} events in log, seq=${state._eventSeq}`);
  } catch {
    console.log("[STATE] No persisted state, starting fresh");
  }
}
async function saveState() {
  try { await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (err) { console.warn("[STATE] Save failed:", err.message); }
}
(async () => { await loadState(); })();

// ══════════════════════════════════════════════════════════════
//  ADS-B module
// ══════════════════════════════════════════════════════════════
adsbModule.start({
  onFlight: flights => {
    state.adsb.data = flights;
    state.adsb.live = true;

    flights.forEach(f => {
      const id = f.id || f.callsign;
      if (id && !seenFlights.has(id)) {
        seenFlights.add(id);
        pushEvent("adsb", "new_flight", {
          callsign: f.callsign || f.id,
          alt: f.alt, spd: f.spd,
          hdg: f.hdg, dist: f.dist,
          squawk: f.squawk,
        });
        pushAlert(`Flight detected: ${f.callsign || f.id}`, "info");
        historyManager.addEntry("adsb", { ...f, ts: f.ts || Date.now() });
      }
    });

    broadcast("adsb", { data: state.adsb.data, live: state.adsb.live });

    // Emergency squawk
    flights.filter(f => f.squawk >= 7500 && f.squawk <= 7777).forEach(f => {
      pushEvent("adsb", "squawk_emergency",
        { callsign: f.callsign || f.id, squawk: f.squawk, alt: f.alt }, "danger");
      pushAlert(`Squawk ${f.squawk}: ${f.callsign}`, "danger");
    });
    // Low altitude
    flights.filter(f => f.alt < 5000 && f.alt > 0).forEach(f => {
      pushEvent("adsb", "low_altitude",
        { callsign: f.callsign || f.id, alt: f.alt, dist: f.dist }, "warn");
      pushAlert(`Low altitude: ${f.callsign || f.id} at ${f.alt}ft`, "warn");
    });
    // High speed — only alert if below FL200 (unusual) or truly extreme (>600kt)
    flights.filter(f => (f.spd > 600) || (f.spd > 400 && f.alt < 20000)).forEach(f => {
      pushEvent("adsb", "high_speed",
        { callsign: f.callsign || f.id, spd: f.spd, alt: f.alt });
      pushAlert(`High speed: ${f.callsign || f.id} at ${f.spd}kt`, "info");
    });
    // No callsign
    flights.filter(f => !f.callsign && f.id).forEach(f => {
      pushEvent("adsb", "unidentified",
        { hex: f.id, alt: f.alt || 0, dist: f.dist || 0 }, "warn");
      pushAlert(`Unidentified aircraft: ${f.id} at ${f.alt || "?"}ft`, "info");
    });
  },
  onError: () => {
    if (state.adsb.live) {
      pushEvent("system", "adsb_offline", {}, "warn");
      pushAlert("RTL-SDR ADS-B feed lost — switching to simulation", "warn");
    }
    state.adsb.live = false;
  },
  config,
});

// ══════════════════════════════════════════════════════════════
//  433 MHz module
// ══════════════════════════════════════════════════════════════
const rf433Mode = config.modules?.rf433?.mode || "disabled";
state.config.rf433Mode = rf433Mode;

if (rf433Mode === "mqtt") {
  console.log("[RF433] MQTT mode enabled");
} else if (rf433Mode === "usb") {
  rf433Module.start({
    onSignal: signal => {
      state.rf433.data = [signal, ...state.rf433.data].slice(0, 200);
      state.rf433.live = true;
      broadcast("rf433", state.rf433.data);
      historyManager.addEntry("rf433", { ...signal, ts: signal.ts || Date.now() });
      pushEvent("rf433", "signal_decoded",
        { proto: signal.proto, freq: signal.freq, data: signal.data, rssi: signal.rssi }, "warn");
      pushAlert(`433 MHz: ${signal.proto} detected — ${signal.data}`, "warn");
    },
    onError: () => { state.rf433.live = false; },
  });
} else {
  console.log("[RF433] Module disabled via config.json");
  state.rf433.live = false;
}

// ══════════════════════════════════════════════════════════════
//  MQTT bridge (ESP32 sensors)
// ══════════════════════════════════════════════════════════════
mqttBridge.start({
  onWifi: nets => {
    state.wifi.data = nets;
    state.wifi.live = true;
    broadcast("wifi", nets);

    pushEvent("wifi", "scan_update", {
      count:    nets.length,
      open:     nets.filter(n => n.enc === "Open").length,
      top_rssi: nets.length ? Math.max(...nets.map(n => n.rssi)) : null,
    });

    const open = nets.filter(n => n.enc === "Open");
    open.forEach(n => {
      pushEvent("wifi", "open_network",
        { ssid: n.ssid, bssid: n.bssid, ch: n.ch, rssi: n.rssi }, "warn");
      pushAlert(`Open network detected: ${n.ssid}`, "warn");
    });
  },

  onBle: devices => {
    state.ble.data = devices;
    state.ble.live = true;
    broadcast("ble", devices);

    pushEvent("ble", "scan_update", { count: devices.length });

    devices.forEach(d => {
      const id = d.mac;
      if (id && !seenBle.has(id)) {
        seenBle.add(id);
        pushEvent("ble", "new_device",
          { name: d.name, mac: d.mac, type: d.type, rssi: d.rssi });
        // Maintain legacy BLE history on state
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

    const hot = channels.filter(c => c.v > 50);
    if (hot.length) {
      pushEvent("nrf24", "high_activity", {
        channels: hot.map(c => c.ch),
        max_v:    Math.max(...hot.map(c => c.v)),
        count:    hot.length,
      }, "warn");
      pushAlert(`nRF24 burst on channel ${hot[0].ch} — possible drone`, "danger");
    }
  },

  onRf433: rf433Mode === "mqtt" ? (signal => {
    state.rf433.data = [signal, ...state.rf433.data].slice(0, 200);
    state.rf433.live = true;
    broadcast("rf433", state.rf433.data);
    pushEvent("rf433", "signal_decoded",
      { proto: signal.proto, freq: signal.freq, data: signal.data, rssi: signal.rssi }, "warn");
    pushAlert(`433 MHz: ${signal.proto} detected — ${signal.data}`, "warn");
  }) : undefined,

  onConnect: () => {
    state.mqtt.live = true;
    broadcast("mqtt", state.mqtt);
    pushEvent("mqtt", "broker_connected", {}, "info");
    pushAlert("MQTT broker connected — ESP32 sensors online", "info");
  },
  onDisconnect: () => {
    state.mqtt.live = false;
    broadcast("mqtt", state.mqtt);
    state.wifi.live  = false;
    state.ble.live   = false;
    state.nrf24.live = false;
    if (rf433Mode === "mqtt") state.rf433.live = false;
    pushEvent("mqtt", "broker_disconnected", {}, "warn");
    pushAlert("MQTT broker disconnected — ESP32 sensors offline", "warn");
  },
});

// ══════════════════════════════════════════════════════════════
//  REST API
// ══════════════════════════════════════════════════════════════
app.get("/api/state",  (req, res) => res.json(state));
app.get("/api/status", (req, res) => res.json({
  adsb: state.adsb.live, wifi: state.wifi.live, ble: state.ble.live,
  rf433: state.rf433.live, nrf24: state.nrf24.live, pwnagotchi: state.pwnagotchi.live,
}));

// ── Event log endpoint — supports ?limit=N&since=SEQ&cat=CATEGORY ─
app.get("/api/eventlog", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 200);
  const since = parseInt(req.query.since) || 0;
  const cat   = req.query.cat;

  let log = state.eventLog;
  if (since) log = log.filter(e => e.seq > since);
  if (cat)   log = log.filter(e => e.cat === cat);
  log = log.slice(0, limit);

  res.json({ count: log.length, latest_seq: state._eventSeq, events: log });
});

// ── History endpoints ─────────────────────────────────────────
app.get("/api/history/:module", async (req, res) => {
  try {
    const history = await historyManager.getHistory(req.params.module);
    res.json({ module: req.params.module, count: history.length, data: history });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.delete("/api/history/:module", async (req, res) => {
  try {
    await historyManager.clearHistory(req.params.module);
    res.json({ ok: true, message: `Cleared ${req.params.module} history` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get("/api/config", (req, res) => res.json({
  config: { server: config.server, modules: config.modules, storage: config.storage },
  lastModified: new Date(),
}));

// ── Pwnagotchi ───────────────────────────────────────────────
app.post("/api/pwnagotchi", safeHandler((req, res) => {
  const error = validatePwnagotchi(req.body);
  if (error) return res.status(400).json({ ok: false, error });

  const { mood, epoch, captures, handshake } = req.body;
  state.pwnagotchi = { mood, epoch, captures, live: true };
  broadcast("pwnagotchi", state.pwnagotchi);

  pushEvent("pwnagotchi", "status_update", { mood, epoch, captures });
  if (handshake) {
    pushEvent("pwnagotchi", "handshake_captured",
      { ssid: handshake.ssid, bssid: handshake.bssid }, "warn");
    pushAlert(`Pwnagotchi captured handshake: ${handshake.ssid}`, "info");
  }
  res.json({ ok: true });
}));

// ── XIAO LoRa ────────────────────────────────────────────────
app.post("/api/xiao", safeHandler((req, res) => {
  const error = validateXiao(req.body);
  if (error) return res.status(400).json({ ok: false, error });

  const pkt = req.body;
  state.lora       = state.lora || { data: [], live: false };
  pkt.ts           = pkt.ts || Date.now();
  state.lora.data  = [pkt, ...state.lora.data].slice(0, 200);
  state.lora.live  = true;
  broadcast("lora", state.lora.data);

  pushEvent("lora",
    pkt.meshtastic ? "meshtastic_node" : "lora_packet",
    { node_id: pkt.node_id, freq: pkt.freq, rssi: pkt.rssi, snr: pkt.snr, len: pkt.len });

  if (pkt.meshtastic) pushAlert(`Meshtastic node detected — RSSI ${pkt.rssi}dBm`, "info");
  else pushAlert(`LoRa packet on ${pkt.freq}MHz — RSSI ${pkt.rssi}dBm`, "info");

  res.json({ ok: true });
}));

app.post("/api/xiao/heartbeat", safeHandler((req, res) => {
  const error = validateXiaoHeartbeat(req.body);
  if (error) return res.status(400).json({ ok: false, error });
  pushEvent("lora", "xiao_heartbeat",
    { uptime: req.body.uptime, heap: req.body.heap, lora_pkts: req.body.loraPkts });
  console.log(`[XIAO] Heartbeat — uptime:${req.body.uptime}s heap:${req.body.heap}`);
  res.json({ ok: true });
}));

// ── NetHunter ────────────────────────────────────────────────
app.post("/api/nethunter", safeHandler((req, res) => {
  const payloadError = validateNethunter(req.body);
  if (payloadError) return res.status(400).json({ ok: false, error: payloadError });

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
    state.lora       = state.lora || { data: [], live: false };
    state.lora.data  = [...lora_packets, ...(state.lora.data || [])].slice(0, 50);
    state.lora.live  = true;
    broadcast("lora", state.lora.data);
    lora_packets.forEach(p =>
      pushAlert(`LoRa node detected: ${p.node_id || "unknown"} RSSI ${p.rssi || "?"}dBm`, "info"));
  }

  if (Array.isArray(wifi_probes) && wifi_probes.length > 0) {
    pushEvent("nethunter", "probe_requests", {
      count: wifi_probes.length,
      ssids: wifi_probes.slice(0, 5).map(p => p.ssid).filter(Boolean),
    });
    wifi_probes.slice(0, 3).forEach(p => {
      if (p.ssid) pushAlert(`Probe: ${p.mac} → "${p.ssid}"`, "info");
    });
  }

  if (Array.isArray(hosts) && hosts.length > 0) {
    state.nethunter = state.nethunter || { hosts: [], live: false };
    const prevIPs   = new Set((state.nethunter.hosts || []).map(h => h.ip));
    const newHosts  = hosts.filter(h => !prevIPs.has(h.ip));

    newHosts.forEach(h =>
      pushAlert(`New host: ${h.ip} ${h.name ? "("+h.name+")" : ""}`, "warn"));

    if (newHosts.length)
      pushEvent("nethunter", "new_hosts", {
        ips: newHosts.map(h => h.ip),
        count: newHosts.length,
      }, "warn");

    pushEvent("nethunter", "host_scan", { total: hosts.length, new: newHosts.length });

    state.nethunter.hosts  = hosts;
    state.nethunter.live   = true;
    state.nethunter.gps    = gps || null;
    state.nethunter.device = device || "nethunter";
    state.nethunter.ts     = ts;
    broadcast("nethunter", state.nethunter);
  }

  console.log(`[NetHunter] ${device} → wifi:${(wifi_networks||[]).length} ble:${(ble_devices||[]).length} hosts:${(hosts||[]).length} lora:${(lora_packets||[]).length}`);
  res.json({ ok: true, ts: Date.now() });
}));

// ══════════════════════════════════════════════════════════════
//  Simulation tick
// ══════════════════════════════════════════════════════════════
setInterval(() => {
  const { adsb, wifi, ble, rf433, nrf24 } = state;
  if (!adsb.live)  { state.adsb.data  = simulator.genFlights(); broadcast("adsb",  state.adsb.data); }
  if (!wifi.live)  { state.wifi.data  = simulator.genNets();    broadcast("wifi",  state.wifi.data); }
  if (!ble.live)   { state.ble.data   = simulator.genBle();     broadcast("ble",   state.ble.data);  }
  if (!rf433.live && Math.random() > 0.6) {
    const sig = simulator.genRf433Signal();
    state.rf433.data = [sig, ...state.rf433.data].slice(0, 40);
    broadcast("rf433", state.rf433.data);
  }
  if (!nrf24.live) { state.nrf24.data = simulator.genNrf24(); broadcast("nrf24", state.nrf24.data); }
  if (!state.pwnagotchi.live && Math.random() > 0.85) {
    state.pwnagotchi.captures = (state.pwnagotchi.captures || 0) + 1;
    broadcast("pwnagotchi", state.pwnagotchi);
  }
  broadcast("spectrum", simulator.genSpectrum());
  saveState();
}, 2800);

// ══════════════════════════════════════════════════════════════
//  WebSocket
// ══════════════════════════════════════════════════════════════
wss.on("connection", ws => {
  console.log("[WS] Client connected");
  // Send full state including eventLog on connect
  ws.send(JSON.stringify({ type: "init", payload: state, ts: Date.now() }));

  ws.on("message", msg => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "clear_alerts") {
        state.alerts = [];
        broadcast("clear_alerts", null);
        saveState();
      }
      if (data.type === "clear_eventlog") {
        state.eventLog  = [];
        state._eventSeq = 0;
        broadcast("eventlog_cleared", null);
        saveState();
      }
    } catch {}
  });
  ws.on("close", () => console.log("[WS] Client disconnected"));
});

// ── Error handling ────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: "Not found" }));
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
