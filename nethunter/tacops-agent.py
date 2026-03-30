#!/usr/bin/env python3
# ============================================================
#  tacops-agent.py — TacticalOps NetHunter Field Agent
#  Mi A2 (Kali NetHunter) — WiFi + BLE + nmap only
#  XIAO handles LoRa independently via its own endpoint
#
#  Install: pip install requests scapy
#  Run:     sudo python3 tacops-agent.py
#  Options: --url  https://your-tunnel.trycloudflare.com
#           --iface wlan0
#           --targets 192.168.0.0/24
# ============================================================

import os, sys, json, time, threading, logging, argparse, socket
import subprocess, re, requests
from datetime import datetime

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s][%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)

# ── Config ────────────────────────────────────────────────────
TACOPS_URL    = os.environ.get("TACOPS_URL", "https://toi-palaeological-imposingly.ngrok-free.dev")
POST_INTERVAL = 10
WIFI_IFACE    = "wlan0"
NMAP_TARGETS  = "192.168.0.0/24"

state = {
    "wifi_networks": [],
    "wifi_probes":   [],
    "ble_devices":   [],
    "hosts":         [],
    "gps":           None,
    "device":        socket.gethostname(),
}
state_lock = threading.Lock()

# ── WiFi Scanner ──────────────────────────────────────────────
def scan_wifi():
    try:
        out = subprocess.check_output(
            ["iwlist", WIFI_IFACE, "scan"],
            stderr=subprocess.DEVNULL, timeout=15
        ).decode(errors="ignore")

        networks = []
        current  = {}
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("Cell"):
                if current: networks.append(current)
                m = re.search(r"Address: (.+)", line)
                current = {"bssid": m.group(1) if m else ""}
            elif "ESSID:" in line:
                m = re.search(r'ESSID:"(.+)"', line)
                current["ssid"] = m.group(1) if m else "Hidden"
            elif "Frequency:" in line:
                m = re.search(r"Channel:(\d+)", line)
                current["ch"]   = int(m.group(1)) if m else 0
                current["band"] = "5GHz" if current.get("ch", 0) > 14 else "2.4GHz"
            elif "Signal level=" in line:
                m = re.search(r"Signal level=(-?\d+)", line)
                current["rssi"] = int(m.group(1)) if m else -80
            elif "Encryption key:on" in line:
                current["enc"] = "WPA2"
            elif "Encryption key:off" in line:
                current["enc"] = "Open"
        if current: networks.append(current)

        with state_lock:
            state["wifi_networks"] = networks
        logging.info("[WiFi] %d networks", len(networks))
    except Exception as e:
        logging.warning("[WiFi] %s", e)

# ── Probe sniffer ─────────────────────────────────────────────
def sniff_probes():
    try:
        from scapy.all import sniff, Dot11ProbeReq, Dot11Elt
        probes = []

        def handle(pkt):
            if pkt.haslayer(Dot11ProbeReq):
                ssid = pkt[Dot11Elt].info.decode(errors="ignore") if pkt.haslayer(Dot11Elt) else ""
                mac  = pkt.addr2 or "unknown"
                if ssid and not any(p["mac"]==mac and p["ssid"]==ssid for p in probes):
                    probes.append({"mac":mac,"ssid":ssid,"ts":int(time.time()*1000)})
                    logging.info("[Probe] %s → %s", mac, ssid)

        sniff(iface=WIFI_IFACE, prn=handle,
              filter="type mgt subtype probe-req",
              store=False, timeout=8)

        with state_lock:
            state["wifi_probes"] = (probes + state["wifi_probes"])[:50]
    except ImportError:
        logging.warning("[Probe] pip install scapy")
    except Exception as e:
        logging.warning("[Probe] %s", e)

# ── BLE Scanner ───────────────────────────────────────────────
def scan_ble():
    try:
        subprocess.run(["hciconfig", "hci0", "up"], capture_output=True)
        out = subprocess.check_output(
            ["hcitool", "lescan"], stderr=subprocess.DEVNULL, timeout=7
        ).decode(errors="ignore")

        devices = []
        seen = set()
        for line in out.splitlines()[1:]:
            parts = line.strip().split(" ", 1)
            if len(parts) == 2:
                mac, name = parts
                if mac not in seen and re.match(r"([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", mac):
                    seen.add(mac)
                    devices.append({
                        "mac":  mac,
                        "name": name.strip() or "Unknown",
                        "rssi": -80,
                        "type": classify_ble(name),
                        "seen": int(time.time() * 1000),
                    })

        with state_lock:
            state["ble_devices"] = devices
        logging.info("[BLE] %d devices", len(devices))
    except Exception as e:
        logging.warning("[BLE] %s", e)

def classify_ble(name):
    n = name.lower()
    if any(x in n for x in ["iphone","android","pixel","redmi","galaxy","realme"]): return "Phone"
    if any(x in n for x in ["airpod","wh-","buds","earphone"]): return "Audio"
    if any(x in n for x in ["band","fitbit","watch","garmin"]): return "Wearable"
    if any(x in n for x in ["esp","arduino","sensor"]): return "IoT"
    return "Unknown"

# ── Nmap ──────────────────────────────────────────────────────
def scan_hosts():
    try:
        out = subprocess.check_output(
            ["nmap", "-sn", "-T4", NMAP_TARGETS, "--oG", "-"],
            stderr=subprocess.DEVNULL, timeout=30
        ).decode(errors="ignore")

        hosts = []
        for line in out.splitlines():
            if "Host:" in line and "Status: Up" in line:
                m_ip   = re.search(r"Host: ([\d.]+)", line)
                m_name = re.search(r"Host: [\d.]+ \((.+?)\)", line)
                if m_ip:
                    hosts.append({
                        "ip":   m_ip.group(1),
                        "name": m_name.group(1) if m_name else "",
                        "ts":   int(time.time() * 1000),
                    })

        with state_lock:
            state["hosts"] = hosts
        logging.info("[Nmap] %d hosts", len(hosts))
    except Exception as e:
        logging.warning("[Nmap] %s", e)

# ── POST to Pi 5 ──────────────────────────────────────────────
def post_state():
    with state_lock:
        payload = {**state, "ts": int(time.time() * 1000)}
    try:
        resp = requests.post(
            f"{TACOPS_URL}/api/nethunter",
            json=payload, timeout=5,
        )
        logging.info("[POST] → %s  wifi:%d ble:%d hosts:%d",
            TACOPS_URL,
            len(payload["wifi_networks"]),
            len(payload["ble_devices"]),
            len(payload["hosts"]),
        )
    except requests.exceptions.ConnectionError:
        logging.warning("[POST] Cannot reach %s", TACOPS_URL)
    except Exception as e:
        logging.warning("[POST] %s", e)

# ── Main loop ─────────────────────────────────────────────────
def scan_loop():
    nmap_counter = 0
    while True:
        threads = [
            threading.Thread(target=scan_wifi,    daemon=True),
            threading.Thread(target=scan_ble,     daemon=True),
            threading.Thread(target=sniff_probes, daemon=True),
        ]
        for t in threads: t.start()

        # nmap every 60s
        nmap_counter += 1
        if nmap_counter % 6 == 0:
            threading.Thread(target=scan_hosts, daemon=True).start()

        for t in threads: t.join(timeout=20)
        post_state()
        time.sleep(POST_INTERVAL)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="TacticalOps NetHunter Agent")
    parser.add_argument("--url",     default=TACOPS_URL)
    parser.add_argument("--iface",   default=WIFI_IFACE)
    parser.add_argument("--targets", default=NMAP_TARGETS)
    args = parser.parse_args()

    TACOPS_URL   = args.url
    WIFI_IFACE   = args.iface
    NMAP_TARGETS = args.targets

    print(f"""
╔══════════════════════════════════════════╗
║   TACTICALOPS NETHUNTER AGENT            ║
║   Scanning: WiFi + BLE + nmap            ║
║   Target:   {TACOPS_URL[:30]:<30} ║
╚══════════════════════════════════════════╝
    """)
    scan_loop()
