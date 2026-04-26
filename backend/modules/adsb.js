// ============================================================
//  modules/adsb.js — ADS-B via tar1090 aircraft.json
//
//  URL (from config.json): http://127.0.0.1/tar1090/data/aircraft.json
//
//  tar1090 / readsb aircraft.json field notes:
//    ac.lat / ac.lon  — direct coords (NOT ac.lastPosition)
//    ac.alt_baro      — barometric altitude (ft)
//    ac.alt_geom      — geometric altitude (ft)
//    ac.gs            — ground speed (kt)
//    ac.track         — heading (degrees)
//    ac.flight        — callsign (space-padded string)
//    ac.squawk        — squawk code (string e.g. "4714")
//    ac.rssi          — signal strength (dBFS, negative float)
//    ac.seen          — seconds since last message (float)
// ============================================================
const http = require("http");

const POLL_INTERVAL_MS = 2000;  // poll every 2s
const AIRCRAFT_TTL_S   = 60;    // skip aircraft not heard for 60s
const FETCH_TIMEOUT_MS = 4000;  // abort hung HTTP requests

// Haversine distance (km)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fetchAircraft(url, receiverLat, receiverLon, onFlight, onError) {
  const req = http.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      onError(new Error(`tar1090 HTTP ${res.statusCode}`));
      return;
    }

    let raw = "";
    res.on("data", chunk => { raw += chunk.toString(); });
    res.on("end", () => {
      try {
        const json = JSON.parse(raw);

        if (!json.aircraft || !Array.isArray(json.aircraft)) {
          onError(new Error("aircraft.json missing 'aircraft' array"));
          return;
        }

        const now = Date.now();
        const result = [];

        json.aircraft.forEach(ac => {
          if (!ac.hex) return;

          // Skip stale aircraft
          if (typeof ac.seen === "number" && ac.seen > AIRCRAFT_TTL_S) return;

          // tar1090 puts lat/lon directly on the object — NOT ac.lastPosition
          const lat = typeof ac.lat === "number" ? ac.lat : null;
          const lon = typeof ac.lon === "number" ? ac.lon : null;

          let dist = 0;
          if (lat !== null && lon !== null && receiverLat && receiverLon) {
            dist = Math.round(haversine(receiverLat, receiverLon, lat, lon) * 10) / 10;
          }

          result.push({
            id:       ac.hex,
            callsign: (ac.flight || "").trim() || ac.hex,
            alt:      ac.alt_baro ?? ac.alt_geom ?? 0,
            spd:      ac.gs ?? 0,
            hdg:      ac.track ?? 0,
            lat,
            lon,
            dist,
            rssi:     typeof ac.rssi === "number" ? Math.round(ac.rssi) : -60,
            squawk:   ac.squawk ? parseInt(ac.squawk, 10) : 0,
            messages: ac.messages || 0,
            seen:     ac.seen ?? 0,
            ts:       now,
          });
        });

        onFlight(result);
      } catch (err) {
        onError(err);
      }
    });
  });

  req.on("timeout", () => req.destroy(new Error("tar1090 fetch timeout")));
  req.on("error",   err => onError(err));
}

function start({ onFlight, onError, config }) {
  const url         = config?.modules?.adsb?.url || "http://127.0.0.1/tar1090/data/aircraft.json";
  const receiverLat = config?.modules?.adsb?.receiver?.lat || 0;
  const receiverLon = config?.modules?.adsb?.receiver?.lon || 0;

  console.log(`[ADS-B] Polling: ${url}`);
  console.log(`[ADS-B] Receiver: ${receiverLat}, ${receiverLon}`);

  fetchAircraft(url, receiverLat, receiverLon, onFlight, onError);

  const timer = setInterval(() => {
    fetchAircraft(url, receiverLat, receiverLon, onFlight, onError);
  }, POLL_INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
}

module.exports = { start };