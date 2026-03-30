// ============================================================
//  ADD THIS BLOCK TO server.js
//  Paste it after the existing /api/pwnagotchi endpoint
// ============================================================

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
