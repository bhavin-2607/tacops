// ============================================================
//  modules/adsb.js — ADS-B via dump1090-fa
//  Connects to dump1090 SBS output on port 30003
//  Parses BaseStation CSV format into flight objects
// ============================================================
const net = require("net");

const DUMP1090_HOST = process.env.DUMP1090_HOST || "127.0.0.1";
const DUMP1090_PORT = parseInt(process.env.DUMP1090_PORT) || 30003;
const RECONNECT_MS = 5000;

const flights = new Map(); // icao → flight object

function parseSBS(line) {
  // SBS format: MSG,<type>,<session>,<aircraft>,<hex>,<flight>,<date>,<time>,<date>,<time>,
  //             <callsign>,<alt>,<speed>,<track>,<lat>,<lon>,<vert_rate>,<squawk>,...
  const parts = line.split(",");
  if (parts[0] !== "MSG") return null;

  const icao     = parts[4]?.trim();
  const callsign = parts[10]?.trim().replace(/_/g, "");
  const alt      = parseInt(parts[11]);
  const speed    = parseInt(parts[12]);
  const hdg      = parseInt(parts[13]);
  const lat      = parseFloat(parts[14]);
  const lon      = parseFloat(parts[15]);
  const squawk   = parseInt(parts[17]);

  if (!icao) return null;
  return { icao, callsign, alt, speed, hdg, lat, lon, squawk, ts: Date.now() };
}

function mergeFlights() {
  const now = Date.now();
  const TTL = 60000; // drop flights not updated in 60s
  const result = [];
  for (const [icao, f] of flights.entries()) {
    if (now - f.ts > TTL) { flights.delete(icao); continue; }
    const dist = Math.sqrt((f.lat || 0) ** 2 + (f.lon || 0) ** 2) * 111;
    result.push({
      id: icao,
      callsign: f.callsign || icao,
      alt: f.alt || 0,
      spd: f.speed || 0,
      hdg: f.hdg || 0,
      lat: f.lat || 0,
      lon: f.lon || 0,
      dist: Math.min(250, Math.round(dist)),
      rssi: -60, // dump1090 doesn't give RSSI per-aircraft
      squawk: f.squawk || 0,
    });
  }
  return result;
}

function start({ onFlight, onError }) {
  let reconnectTimer = null;

  function connect() {
    const client = new net.Socket();
    let buffer = "";

    client.connect(DUMP1090_PORT, DUMP1090_HOST, () => {
      console.log(`[ADS-B] Connected to dump1090 on ${DUMP1090_HOST}:${DUMP1090_PORT}`);
    });

    client.on("data", chunk => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        const update = parseSBS(line.trim());
        if (update) {
          const existing = flights.get(update.icao) || {};
          // merge — only overwrite defined fields
          flights.set(update.icao, {
            ...existing,
            ...Object.fromEntries(Object.entries(update).filter(([_, v]) => v !== undefined && !isNaN(v) || typeof v === "string"))
          });
        }
      }
      onFlight(mergeFlights());
    });

    client.on("error", err => {
      console.warn(`[ADS-B] dump1090 connection error: ${err.message}`);
      onError(err);
      client.destroy();
    });

    client.on("close", () => {
      console.warn(`[ADS-B] dump1090 disconnected — retrying in ${RECONNECT_MS}ms`);
      onError(new Error("disconnected"));
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
  }

  // Try connecting — errors are handled gracefully
  connect();
}

module.exports = { start };
