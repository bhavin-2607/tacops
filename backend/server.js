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

const adsbModule   = require("./modules/adsb");
const rf433Module  = require("./modules/rf433");
const mqttBridge   = require("./modules/mqtt-bridge");
const simulator    = require("./modules/simulator");

const PORT = process.env.PORT || 3000;

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
  pwnagotchi: { captures: 0, mood: "bored", epoch: 0, live: false },
  alerts:   [],
};

// ── Broadcast to all connected WS clients ───────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function pushAlert(msg, sev = "info") {
  const alert = { id: Math.random().toString(36).slice(2), msg, sev, ts: Date.now() };
  state.alerts = [alert, ...state.alerts].slice(0, 50);
  broadcast("alert", alert);
}

// ── ADS-B module (RTL-SDR → dump1090) ───────────────────────
adsbModule.start({
  onFlight: flights => {
    state.adsb.data = flights;
    state.adsb.live = true;
    broadcast("adsb", flights);
    const emergency = flights.filter(f => f.squawk >= 7500 && f.squawk <= 7777);
    if (emergency.length) pushAlert(`Squawk ${emergency[0].squawk}: ${emergency[0].callsign}`, "danger");
  },
  onError: () => {
    if (state.adsb.live) pushAlert("RTL-SDR ADS-B feed lost — switching to simulation", "warn");
    state.adsb.live = false;
  }
});

// ── 433 MHz module (RTL-SDR → rtl_433) ──────────────────────
// rf433Module.start({
//   onSignal: signal => {
//     state.rf433.data = [signal, ...state.rf433.data].slice(0, 40);
//     state.rf433.live = true;
//     broadcast("rf433", state.rf433.data);
//     pushAlert(`433 MHz: ${signal.proto} detected — ${signal.data}`, "warn");
//   },
//   onError: () => { state.rf433.live = false; }
// });
if (process.env.RTL433_BIN !== "disabled") {
  rf433Module.start({
    onSignal: signal => {
      state.rf433.data = [signal, ...state.rf433.data].slice(0, 40);
      state.rf433.live = true;
      broadcast("rf433", state.rf433.data);
      pushAlert(`433 MHz: ${signal.proto} detected — ${signal.data}`, "warn");
    },
    onError: () => { state.rf433.live = false; }
  });
} else {
  console.log("[RF433] Module disabled via .env");
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
  },
  onNrf24: channels => {
    state.nrf24.data = channels;
    state.nrf24.live = true;
    broadcast("nrf24", channels);
    const burst = channels.find(c => c.v > 80);
    if (burst) pushAlert(`nRF24 burst on channel ${burst.ch} — possible drone`, "danger");
  },
  onConnect: () => pushAlert("MQTT broker connected — ESP32 sensors online", "info"),
  onDisconnect: () => {
    state.wifi.live = false;
    state.ble.live = false;
    state.nrf24.live = false;
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

  state.lora.data = [pkt, ...state.lora.data].slice(0, 50);
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
  if (!rf433.live && Math.random() > 0.6) {
    const signal = simulator.genRf433Signal();
    state.rf433.data = [signal, ...state.rf433.data].slice(0, 40);
    broadcast("rf433", state.rf433.data);
  }
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

}, 2800);

// ── WebSocket handshake — send full state on connect ────────
wss.on("connection", ws => {
  console.log("[WS] Client connected");
  ws.send(JSON.stringify({ type: "init", payload: state, ts: Date.now() }));
  ws.on("close", () => console.log("[WS] Client disconnected"));
});

server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║   TACTICALOPS DASHBOARD BACKEND    ║`);
  console.log(`║   http://localhost:${PORT}           ║`);
  console.log(`╚════════════════════════════════════╝\n`);
});
