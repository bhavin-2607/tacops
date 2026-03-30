// ============================================================
//  modules/rf433.js — 433 MHz via rtl_433
//  Spawns rtl_433 with JSON output and parses each detection
// ============================================================
const { spawn } = require("child_process");

const RTL433_BIN  = process.env.RTL433_BIN || "rtl_433";
const RTL433_FREQ = process.env.RTL433_FREQ || "433.92M";
const RETRY_MS    = 8000;

function start({ onSignal, onError }) {
  let proc = null;
  let retryTimer = null;
  let started = false;

  function launch() {
    // -F json  → JSON output per detection
    // -f 433.92M → tune to 433.92 MHz
    // -A       → pulse analyzer (helps with unknown protocols)
    const args = ["-f", RTL433_FREQ, "-F", "json", "-q"];
    proc = spawn(RTL433_BIN, args);
    started = false;

    proc.stdout.on("data", chunk => {
      started = true;
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const signal = {
            id:    Math.random().toString(36).slice(2),
            proto: obj.model || obj.protocol || "Unknown",
            freq:  ((obj.freq || 433920000) / 1e6).toFixed(2),
            data:  obj.data ? `0x${parseInt(obj.data, 2).toString(16).toUpperCase()}` :
                   obj.code ? `0x${obj.code}` : JSON.stringify(obj).slice(0, 30),
            raw:   obj,
            rssi:  obj.rssi ? Math.round(obj.rssi) : -65,
            ts:    Date.now(),
          };
          onSignal(signal);
        } catch (_) { /* non-JSON line, skip */ }
      }
    });

    proc.stderr.on("data", d => {
      const msg = d.toString().trim();
      if (msg.includes("No supported")) {
        console.warn("[433MHz] RTL-SDR not found — using simulation");
        onError(new Error("no_sdr"));
        proc.kill();
      }
    });

    proc.on("error", err => {
      console.warn(`[433MHz] rtl_433 spawn error: ${err.message}`);
      onError(err);
      retryTimer = setTimeout(launch, RETRY_MS);
    });

    proc.on("exit", code => {
      if (code !== 0 && code !== null) {
        console.warn(`[433MHz] rtl_433 exited (${code}) — retrying in ${RETRY_MS}ms`);
        onError(new Error(`exit_${code}`));
        retryTimer = setTimeout(launch, RETRY_MS);
      }
    });
  }

  launch();
}

module.exports = { start };
