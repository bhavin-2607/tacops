// ============================================================
//  modules/adsb.js — ADS-B via tar1090 aircraft.json
//  Fetches from dump1090-fa's web interface JSON endpoint
//  Provides complete flight data including per-aircraft RSSI
// ============================================================
const http = require("http");

const TAR1090_HOST = process.env.TAR1090_HOST || "127.0.0.1";
const TAR1090_PORT = process.env.TAR1090_PORT || 80;
const POLL_INTERVAL_MS = 1000; // Poll every 1 second
const AIRCRAFT_TTL = 60000; // Drop flights not seen for 60 seconds

const flights = new Map(); // hex → flight object

// Haversine distance calculation in kilometers
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function fetchAircraft(receiverLat, receiverLon, onFlight, onError) {
  const req = http.get(`http://${TAR1090_HOST}:${TAR1090_PORT}/tar1090/data/aircraft.json`, (res) => {
    let data = "";
    
    res.on("data", chunk => {
      data += chunk.toString();
    });
    
    res.on("end", () => {
      try {
        const json = JSON.parse(data);
        if (!json.aircraft || !Array.isArray(json.aircraft)) {
          onError(new Error("Invalid aircraft.json format"));
          return;
        }

        const now = Date.now();
        
        // Update flights map from tar1090 data
        json.aircraft.forEach(ac => {
          if (ac.hex && ac.lastPosition) {
            flights.set(ac.hex, {
              hex: ac.hex,
              callsign: (ac.flight || "").trim() || ac.hex,
              alt: ac.alt_baro || ac.alt_geom || 0,
              speed: ac.gs || ac.tas || 0,
              hdg: ac.track || 0,
              lat: ac.lastPosition.lat,
              lon: ac.lastPosition.lon,
              squawk: ac.squawk ? parseInt(ac.squawk) : 0,
              rssi: ac.rssi || -60,
              messages: ac.messages || 0,
              seen: ac.seen || now,
              ts: now,
            });
          }
        });

        // Clean up old flights
        const threshold = now - AIRCRAFT_TTL;
        for (const [hex, flight] of flights.entries()) {
          if (flight.ts < threshold) {
            flights.delete(hex);
          }
        }

        // Convert to flight list format
        const result = [];
        for (const flight of flights.values()) {
          let dist = 0;
          if (receiverLat && receiverLon && flight.lat && flight.lon) {
            dist = calculateDistance(receiverLat, receiverLon, flight.lat, flight.lon);
          }
          result.push({
            id: flight.hex,
            callsign: flight.callsign,
            alt: flight.alt,
            spd: flight.speed,
            hdg: flight.hdg,
            lat: flight.lat,
            lon: flight.lon,
            dist: Math.round(dist * 10) / 10,
            rssi: flight.rssi,
            squawk: flight.squawk,
            ts: flight.ts,
          });
        }

        onFlight(result);
      } catch (err) {
        onError(err);
      }
    });
  });

  req.on("error", (err) => {
    onError(err);
  });
}

function start({ onFlight, onError, config }) {
  const receiverLat = config?.modules?.adsb?.receiver?.lat || 0;
  const receiverLon = config?.modules?.adsb?.receiver?.lon || 0;

  console.log(`[ADS-B] Fetching from tar1090: http://${TAR1090_HOST}:${TAR1090_PORT}/tar1090/data/aircraft.json`);
  console.log(`[ADS-B] Receiver position: ${receiverLat}, ${receiverLon}`);

  // Poll the tar1090 endpoint
  const pollInterval = setInterval(() => {
    fetchAircraft(receiverLat, receiverLon, onFlight, onError);
  }, POLL_INTERVAL_MS);

  // Initial fetch
  fetchAircraft(receiverLat, receiverLon, onFlight, onError);

  return {
    stop: () => clearInterval(pollInterval)
  };
}

module.exports = { start };
