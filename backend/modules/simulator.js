// ============================================================
//  modules/simulator.js — Simulated sensor data
//  Used as fallback for any hardware module that is offline
// ============================================================

const r = (a, b) => Math.floor(a + Math.random() * (b - a));
const pick = a => a[Math.floor(Math.random() * a.length)];
const mac = () => Array.from({ length: 6 }, () => r(0, 255).toString(16).padStart(2, "0")).join(":");
const hex = () => "0x" + r(0, 0xFFFFFF).toString(16).toUpperCase().padStart(6, "0");

const CALLSIGNS  = ["AI302","UK892","SG441","EK571","BA226","QR556","LH764","6E123","IX205","G8771","AI101","SJ890"];
const SSIDS      = ["Jio_Home_5G","BSNL_Fiber_01","TP-Link_3F2A","Airtel_Xstream","Corp_Office_5G","AndroidAP_8B3F","HP_Printer_78A","DIRECT-Fire","Guest_Net","Reliance_JioFiber","DD-WRT_Mesh","SBI_ATM_WiFi"];
const BLE_NAMES  = ["iPhone 14","Galaxy S23","AirPods Pro","Mi Band 7","Pixel 7","Sony WH-1000","MacBook Air","Fitbit Versa","Unknown Device","ESP32-BLE","Redmi Note 12","realme GT"];
const PROTOCOLS  = ["Oregon Scientific","LaCrosse TX","PT2262 Remote","FS1000A Module","Elro AB440","Conrad RSL","Generic Temp Sensor","Kerui Alarm","Holman Industries","Nexus/WeatherStation"];

// Keep a stable pool to simulate persistent tracking
let flightPool = null;
let netPool    = null;
let blePool    = null;

function genFlights() {
  if (!flightPool) {
    flightPool = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      callsign: pick(CALLSIGNS),
      alt: r(5000, 41000),
      spd: r(200, 920),
      hdg: r(0, 360),
      lat: 23.02 + (Math.random() - 0.5) * 2,
      lon: 72.57 + (Math.random() - 0.5) * 2,
      dist: r(5, 250),
      rssi: r(-90, -40),
      squawk: r(1000, 7776),
    }));
  }
  flightPool = flightPool.map(f => ({
    ...f,
    alt: Math.max(1000, f.alt + r(-200, 200)),
    hdg: (f.hdg + r(-3, 3) + 360) % 360,
    spd: Math.max(100, f.spd + r(-10, 10)),
  }));
  return flightPool;
}

function genNets() {
  if (!netPool) {
    netPool = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      ssid: pick(SSIDS),
      bssid: mac(),
      ch: pick([1, 6, 11, 36, 40, 44, 149]),
      rssi: r(-90, -30),
      enc: pick(["WPA3", "WPA2", "WPA2", "WPA2", "Open"]),
      cli: r(0, 12),
      band: Math.random() > 0.4 ? "5GHz" : "2.4GHz",
    }));
  }
  // Slightly vary signal strength
  netPool = netPool.map(n => ({ ...n, rssi: Math.min(-20, n.rssi + r(-3, 3)) }));
  return netPool;
}

function genBle() {
  if (!blePool) {
    blePool = Array.from({ length: 9 }, (_, i) => ({
      id: i,
      name: pick(BLE_NAMES),
      mac: mac(),
      rssi: r(-100, -35),
      type: pick(["Phone", "Audio", "Wearable", "IoT", "Unknown"]),
      seen: Date.now() - r(0, 300000),
    }));
  }
  blePool = blePool.map(d => ({ ...d, rssi: Math.min(-20, d.rssi + r(-2, 2)), seen: d.seen + 2800 }));
  return blePool;
}

function genRf433Signal() {
  return {
    id:    Math.random().toString(36).slice(2),
    proto: pick(PROTOCOLS),
    freq:  (433 + (Math.random() - 0.5) * 0.2).toFixed(2),
    data:  hex(),
    rssi:  r(-90, -40),
    ts:    Date.now(),
  };
}

function genNrf24() {
  return Array.from({ length: 126 }, (_, i) => ({
    ch: i,
    v: Math.random() > 0.87 ? r(20, 100) : r(0, 12),
  }));
}

function genSpectrum() {
  return Array.from({ length: 60 }, (_, i) => ({
    f: (88 + i * 1.5).toFixed(0),
    p: r(5, 25) + (i > 10 && i < 15 ? 65 : 0) + (i > 35 && i < 42 ? 80 : 0),
  }));
}

function genPwnagotchi() {
  const moods = ["bored", "excited", "happy", "sad", "lonely", "motivated"];
  return {
    mood:     pick(moods),
    epoch:    r(1, 200),
    captures: r(0, 150),
    live:     false,
  };
}

module.exports = { genFlights, genNets, genBle, genRf433Signal, genNrf24, genSpectrum, genPwnagotchi };
