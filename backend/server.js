// ============================================================
//  TacticalOps Dashboard — Main Server
//  Raspberry Pi 5 Hub
//  Each module tries real hardware → falls back to simulation
// ============================================================
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const path = require("path");
const fs = require("fs").promises;

const adsbModule   = require("./modules/adsb");
const rf433Module  = require("./modules/rf433");
const mqttBridge   = require("./modules/mqtt-bridge");
const simulator    = require("./modules/simulator");

const PORT = process.env.PORT || 3000;

// Track seen flights to avoid duplicate alerts
let seenFlights = new Set();
let seenBle = new Set();

// ── Express setup ────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── HTTP + WebSocket server ──────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Shared state ─────────────────────────────────────────────
const state = {
  adsb:     { data: [], live: false },
  wifi:     { data: [], live: false },
  ble:      { data: [], live: false },
  rf433:    { data: [], live: false },
  nrf24:    { data: [], live: false },
  lora:     { data: [], live: false },
  nethunter:{ hosts: [], live: false },
  pwnagotchi: { captures: 0, mood: "bored", epoch: 0, live: false },
  alerts:   [],
};

const STATE_FILE = path.join(__dirname, "state.json");

// ── Load persisted state ─────────────────────────────────────
async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, "utf8");
    const persisted = JSON.parse(data);
    Object.assign(state, persisted);
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
    broadcast("adsb", flights);

    // Alert for new flights
    flights.forEach(f => {
      const id = f.id || f.callsign;
      if (id && !seenFlights.has(id)) {
        seenFlights.add(id);
        pushAlert(`Flight detected: ${f.callsign || f.id}`, "info");
        // Add to history
        state.adsb.history = state.adsb.history || [];
        state.adsb.history.push(f);
        state.adsb.history = state.adsb.history.slice(-500);
      }
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
const rf433Mode = process.env.RF433_MODE || "usb";
if (rf433Mode === "mqtt") {
  // 433MHz data is consumed via MQTT topic tacops/rf433_signal
  console.log("[RF433] MQTT mode enabled");
} else if (rf433Mode === "usb") {
  rf433Module.start({
    onSignal: signal => {
      state.rf433.data = [signal, ...state.rf433.data].slice(0, 200);
      state.rf433.live = true;
      broadcast("rf433", state.rf433.data);
      pushAlert(`433 MHz: ${signal.proto} detected — ${signal.data}`, "warn");
    },
    onError: () => { state.rf433.live = false; }
  });
} else if (rf433Mode === "disabled") {
  console.log("[RF433] Module disabled via RF433_MODE");
} else {
  console.warn(`\n[RF433] Unknown RF433_MODE='${rf433Mode}', falling back to usb\n`);
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
    pushAlert("MQTT broker connected — ESP32 sensors online", "info");
    if (rf433Mode === "mqtt") state.rf433.live = true;
  },
  onDisconnect: () => {
    state.wifi.live = false;
    state.ble.live = false;
    state.nrf24.live = false;
    if (rf433Mode === "mqtt") state.rf433.live = false;
    pushAlert("MQTT broker disconnected — ESP32 sensors offline", "warn");
  }
});

// ── Pwnagotchi webhook endpoint ──────────────────────────────
app.post("/api/pwnagotchi", (req, res) => {
  const { mood, epoch, captures, handshake } = req.body;
  state.pwnagotchi = { mood, epoch, captures, live: true };
  if (handshake) {
    pushAlert(`Pwnagotchi captured handshake: ${handshake.ssid}`, "info");
    state.pwnagotchi.captures = (state.pwnagotchi.captures || 0) + 1;
  }
  broadcast("pwnagotchi", state.pwnagotchi);
  res.json({ ok: true });
});

// ── XIAO ESP32S3 dedicated endpoint (field mode HTTP POST) ───
app.post("/api/xiao", (req, res) => {
  const pkt = req.body;
  if (!pkt || !pkt.type) return res.json({ ok: false });

  state.lora = state.lora || { data: [], live: false };
  pkt.ts = pkt.ts || Date.now();

  state.lora.data = [pkt, ...state.lora.data].slice(0, 200);
  state.lora.live = true;
  broadcast("lora", state.lora.data);

  if (pkt.meshtastic) pushAlert(`Meshtastic node detected — RSSI ${pkt.rssi}dBm`, "info");
  else pushAlert(`LoRa packet on ${pkt.freq}MHz — RSSI ${pkt.rssi}dBm`, "info");

  res.json({ ok: true });
});

app.post("/api/xiao/heartbeat", (req, res) => {
  console.log(`[XIAO] Heartbeat — uptime:${req.body.uptime}s heap:${req.body.heap} loraPkts:${req.body.loraPkts}`);
  res.json({ ok: true });
});

// ── NetHunter field agent endpoint ──────────────────────────
app.post("/api/nethunter", (req, res) => {
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
});



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

// ── Simulation tick (fills any offline module with fake data) 
setInterval(() => {
  const { adsb, wifi, ble, rf433, nrf24 } = state;

  if (!adsb.live) {
    const flights = simulator.genFlights();
    state.adsb.data = flights;
    broadcast("adsb", flights);
  }
  if (!wifi.live) {
    const nets = simulator.genNets();
    state.wifi.data = nets;
    broadcast("wifi", nets);
  }
  if (!ble.live) {
    const devices = simulator.genBle();
    state.ble.data = devices;
    broadcast("ble", devices);
  }
  // if (!rf433.live && Math.random() > 0.6) {
  //   const signal = simulator.genRf433Signal();
  //   state.rf433.data = [signal, ...state.rf433.data].slice(0, 40);
  //   broadcast("rf433", state.rf433.data);
  // }
  if (!nrf24.live) {
    const channels = simulator.genNrf24();
    state.nrf24.data = channels;
    broadcast("nrf24", channels);
  }
  if (!state.pwnagotchi.live && Math.random() > 0.85) {
    state.pwnagotchi.captures = (state.pwnagotchi.captures || 0) + 1;
    broadcast("pwnagotchi", state.pwnagotchi);
  }

  broadcast("spectrum", simulator.genSpectrum());

  // Save state periodically
  saveState();

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

server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║   TACTICALOPS DASHBOARD BACKEND    ║`);
  console.log(`║   http://localhost:${PORT}           ║`);
  console.log(`╚════════════════════════════════════╝\n`);
});
