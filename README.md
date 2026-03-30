# TacticalOps Dashboard

A self-hosted, real-time RF surveillance and monitoring dashboard running on a Raspberry Pi 5. Integrates multiple RF sensors into a unified live dashboard with a Node.js backend and React frontend. All panels fall back to simulated data when hardware is offline — connect sensors one at a time at your own pace.

---

## Hardware

| Device | Role | Status |
|--------|------|--------|
| Raspberry Pi 5 | Central hub — backend, dashboard, MQTT broker | ✅ Live |
| RTL-SDR Blog v4 | ADS-B flight tracking via readsb | ✅ Live |
| ESP32 WROOM-32U #1 | WiFi + BLE scanner + 2.4GHz spectrum | ✅ Live |
| nRF24L01+PA+LNA ×4 | 2.4GHz channel activity (wired to ESP32 #1) | ✅ Live |
| ESP32 WROOM-32U #2 | CC1101 433MHz sub-GHz signal capture | ✅ Live |
| CC1101 433MHz | Sub-GHz decoder (wired to ESP32 #2) | ✅ Live |
| Pi Zero 2W | Pwnagotchi — AI WiFi handshake capture | ✅ Live |
| Mi A2 (Kali NetHunter) | Field agent — WiFi + BLE + nmap over 4G | ⏳ Pending |
| XIAO ESP32S3 Wio SX1262 | LoRa monitor — 865MHz IN865 band | ⏳ Ordered |
| M5StickC Plus 2 | Portable field scout | 🔜 Next phase |

---

## Dashboard Panels

| Panel | Data Source | Indicator |
|-------|-------------|-----------|
| ADS-B Flights | readsb → port 30003 | ● LIVE / ○ SIM |
| WiFi Intelligence | ESP32 #1 MQTT + Pwnagotchi handshakes | ● LIVE / ○ SIM |
| BLE Devices | ESP32 #1 MQTT | ● LIVE / ○ SIM |
| 433 MHz RF | ESP32 #2 + CC1101 MQTT | ● LIVE / ○ SIM |
| 2.4GHz Spectrum | ESP32 #1 + nRF24 MQTT | ● LIVE / ○ SIM |
| LoRa Monitor | XIAO ESP32S3 MQTT / HTTP | ⏳ Pending |
| Field Agent | NetHunter tacops-agent.py → ngrok | ⏳ Pending |
| Spectrum Analyzer | RTL-SDR wideband sweep | Simulated |
| AI Intel (TACINT) | Claude API with live sensor context | ● Ready |

---

## Architecture

```
                    ┌──────────────────────────────────┐
                    │        Raspberry Pi 5            │
                    │        groot@rfConn              │
                    │        10.96.42.97               │
                    │                                  │
                    │  TacticalOps Backend :3000       │
                    │  WebSocket broadcast             │
                    │  Mosquitto MQTT :1883            │
                    │  readsb ADS-B :30003             │
                    │       ↑ USB                      │
                    │   [RTL-SDR v4]                   │
                    └──────────────┬───────────────────┘
                                   │
        ┌──────────────────────────┼─────────────────────────┐
        │                          │                         │
  [ESP32 #1]                 [ESP32 #2]               [Pi Zero 2W]
  WiFi+BLE+nRF24             CC1101 433MHz             Pwnagotchi
  MQTT →                     MQTT →                   HTTP POST →
  tacops/wifi                tacops/rf433_signal       /api/pwnagotchi
  tacops/ble                      ↑ SPI               UDP beacon
  tacops/nrf24               [CC1101]                 + mDNS fallback
       ↑ SPI
  [nRF24L01×4]

        ┌─────────────────────────────────────────────────┐
        │                FIELD OPERATIONS                 │
        │                                                 │
  [XIAO ESP32S3]                            [Mi A2 NetHunter]
  LoRa 865MHz                               WiFi+BLE+nmap
  Home → MQTT rfconn.local                  4G → ngrok →
  Field → HTTP ngrok /api/xiao              /api/nethunter
        └─────────────────────────────────────────────────┘
```

---

## Software Stack

**Raspberry Pi 5:**
- Node.js 20 + Express — backend server
- WebSocket (ws) — real-time broadcast to all clients
- Mosquitto — MQTT broker for ESP32 sensors
- readsb (wiedehopf) — ADS-B decoder from RTL-SDR
- rtl_433 — 433MHz sub-GHz decoder
- ngrok — public HTTPS tunnel for field agents
- Avahi — `rfconn.local` mDNS hostname
- systemd — auto-start for tacops + ngrok on boot

**ESP32 Firmware (Arduino IDE):**
- PubSubClient — MQTT client
- RF24 — nRF24L01 2.4GHz scanner
- ELECHOUSE_CC1101_SRC_DRV — CC1101 433MHz driver
- ArduinoJson — JSON serialization
- RadioLib — SX1262 LoRa (XIAO only)

**Pi Zero 2W:**
- Pwnagotchi — AI-powered WiFi handshake capture
- tacops.py — custom plugin with UDP beacon auto-discovery + mDNS fallback

**Mi A2 (NetHunter):**
- tacops-agent.py — WiFi/BLE/nmap scanner, posts via ngrok over 4G

**Frontend:**
- React 18 via Babel standalone — no build step required
- Pure CSS bar charts — no charting library dependencies
- WebSocket client — live updates push from backend

---

## Directory Structure

```
tacops/
├── backend/
│   ├── server.js               ← main hub
│   ├── package.json
│   ├── .env.example
│   ├── public/
│   │   └── index.html          ← frontend dashboard (no build step)
│   └── modules/
│       ├── adsb.js             ← readsb TCP client (port 30003)
│       ├── rf433.js            ← rtl_433 process manager
│       ├── mqtt-bridge.js      ← ESP32 MQTT listener + normalizer
│       └── simulator.js        ← fallback data for all offline sensors
├── esp32/
│   ├── wifi_ble_nrf24/
│   │   └── wifi_ble_nrf24.ino  ← ESP32 #1 firmware
│   ├── cc1101_rf433/
│   │   └── cc1101_rf433.ino    ← ESP32 #2 firmware
│   └── xiao_lora/
│       └── xiao_lora.ino       ← XIAO ESP32S3 firmware
├── nethunter/
│   └── tacops-agent.py         ← Mi A2 field agent
├── pwnagotchi/
│   └── tacops.py               ← Pwnagotchi plugin
├── scripts/
│   └── pi5-setup.sh            ← Pi 5 dependency installer
└── README.md
```

---

## Setup

### Step 1 — Raspberry Pi 5

```bash
# Flash Raspberry Pi OS Lite 64-bit (Trixie/Debian 13)
# Enable SSH in Raspberry Pi Imager, set hostname: rfConn
# Boot and SSH in
ssh groot@rfConn.local

# Clone project
git clone https://github.com/bhavin-2607/tacops.git ~/tacops

# Install system dependencies
sudo apt install -y nodejs npm mosquitto mosquitto-clients avahi-daemon rtl-433
sudo systemctl enable mosquitto avahi-daemon
sudo systemctl start mosquitto avahi-daemon

# Install Node dependencies
cd ~/tacops/backend && npm install

# Configure environment
cp .env.example .env
nano .env  # add ANTHROPIC_API_KEY
```

```bash
# Install as systemd service (auto-starts on every boot)
sudo nano /etc/systemd/system/tacops.service
```

```ini
[Unit]
Description=TacticalOps Dashboard
After=network.target mosquitto.service

[Service]
Type=simple
User=groot
WorkingDirectory=/home/groot/tacops/backend
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable tacops
sudo systemctl start tacops
```

Dashboard: **http://rfConn.local:3000**

> All panels show simulated data until hardware is connected. Each module activates independently.

---

### Step 2 — ADS-B (RTL-SDR v4)

```bash
# Install readsb — supports Debian Trixie (dump1090-fa does NOT)
sudo bash -c "$(curl -L -o - https://github.com/wiedehopf/adsb-scripts/raw/master/install-readsb.sh)"

# Set location (Ahmedabad)
sudo readsb-set-location 23.0225 72.5714

# Set gain
sudo readsb-gain 42.1

# Verify data on port 30003
nc localhost 30003 | head -10

# Check readsb web UI for live aircraft map
# http://rfConn.local:8080
```

> **Important:** dump1090-fa fails on Debian Trixie — FlightAware's apt repo only supports Bookworm. readsb by the same author (wiedehopf) works perfectly and outputs identical SBS format on port 30003.

> **Important:** Only one process can use the RTL-SDR at a time. Stop readsb before using rtl_433 manually.

---

### Step 3 — ESP32 #1 (WiFi + BLE + nRF24)

**Wiring nRF24L01+PA+LNA → ESP32:**

```
nRF24L01+PA+LNA    ESP32
───────────────    ─────────────────────────────────────
VCC            →   External AMS1117 3.3V regulator output
GND            →   GND (common with ESP32)
CE             →   GPIO 4
CSN            →   GPIO 5
SCK            →   GPIO 18
MOSI           →   GPIO 23
MISO           →   GPIO 19
IRQ            →   (leave unconnected)
```

> ⚠️ nRF24+PA+LNA draws ~115mA peak. The ESP32's 3V3 pin cannot supply this. Use an external AMS1117 3.3V regulator powered from the 5V USB rail.

**Arduino IDE setup:**
1. Add ESP32 boards: `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
2. Install libraries: `PubSubClient`, `RF24`, `ArduinoJson`
3. Open `esp32/wifi_ble_nrf24/wifi_ble_nrf24.ino`
4. Edit `WIFI_SSID`, `WIFI_PASS`, `MQTT_BROKER` (Pi 5 IP)
5. Board: `ESP32 Dev Module` | Upload speed: `921600`
6. Hold BOOT button when `Connecting....` appears

---

### Step 4 — ESP32 #2 (CC1101 433MHz)

**Wiring CC1101 → ESP32:**

```
CC1101    ESP32
──────    ─────────────────────
VCC   →   3.3V (ESP32 onboard pin is fine for CC1101)
GND   →   GND
SCK   →   GPIO 18
MOSI  →   GPIO 23
MISO  →   GPIO 19
CSN   →   GPIO 5
GDO0  →   GPIO 2
GDO2  →   GPIO 4 (optional)
```

**Arduino IDE setup:**
1. Install library: `ELECHOUSE_CC1101_SRC_DRV` by LSatan
2. Open `esp32/cc1101_rf433/cc1101_rf433.ino`
3. Edit `WIFI_SSID`, `WIFI_PASS`, `MQTT_BROKER`
4. Board: `ESP32 Dev Module` | Upload speed: `921600`

---

### Step 5 — Pwnagotchi Plugin

```bash
# On Pi Zero 2W
sudo cp pwnagotchi/tacops.py /usr/local/share/pwnagotchi/custom-plugins/
sudo nano /etc/pwnagotchi/config.toml
```

Add at the bottom using TOML table syntax:
```toml
[main.plugins.tacops]
enabled = true
api_url = "http://rfconn.local:3000"
interval = 10
```

```bash
sudo systemctl restart pwnagotchi
sudo journalctl -u pwnagotchi -f | grep -i tacops
# Expected: [TacticalOps] Plugin loaded — streaming to http://rfconn.local:3000
```

The plugin auto-discovers the Pi 5 via UDP beacon (port 5005, broadcast every 5s) with mDNS fallback to `rfconn.local`. No hardcoded IPs.

---

### Step 6 — ngrok Tunnel

```bash
# Install
curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
  | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
  | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install ngrok

# Authenticate (token from https://ngrok.com)
ngrok config add-authtoken YOUR_TOKEN

# Find actual binary path
which ngrok
```

```bash
sudo nano /etc/systemd/system/ngrok.service
```

```ini
[Unit]
Description=Ngrok Tunnel
After=network.target tacops.service

[Service]
Type=simple
User=groot
ExecStart=/usr/local/bin/ngrok http 3000 --log=stdout
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable ngrok
sudo systemctl start ngrok
```

---

### Step 7 — NetHunter Field Agent (Mi A2)

```bash
# Transfer to phone
adb push nethunter/tacops-agent.py /sdcard/Download/

# On NetHunter terminal
pip install requests scapy
cp /sdcard/Download/tacops-agent.py ~/

# Run
sudo python3 ~/tacops-agent.py \
  --url https://YOUR-NGROK-URL.ngrok-free.app \
  --iface wlan0
```

Scans WiFi networks, BLE devices, probe requests, nmap hosts. Posts every 10 seconds to Pi 5 via ngrok over 4G. Fully independent from XIAO.

---

### Step 8 — XIAO ESP32S3 Wio SX1262 (LoRa)

```
Board Manager URL:
https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
Board: XIAO_ESP32S3
Libraries: RadioLib, PubSubClient, ArduinoJson
```

Edit `esp32/xiao_lora/xiao_lora.ino`:
```cpp
const char* WIFI_SSID_HOME = "YOUR_HOME_SSID";
const char* WIFI_PASS_HOME = "YOUR_HOME_PASS";
const char* TACOPS_URL     = "https://YOUR-NGROK-URL.ngrok-free.app";
```

**Auto mode:** Home WiFi found → MQTT to `rfconn.local:1883`. Home WiFi not found → HTTP POST to ngrok URL. No serial dependency, no NetHunter needed.

**LoRa config:** 865.0 MHz | SF9 | BW125kHz | IN865 (India legal band). Detects Meshtastic nodes (sync word `0x34`) and unknown LoRa transmitters up to 5km.

> No wiring needed — SX1262 is pre-wired on the Wio kit (NSS=41, DIO1=39, RST=42, BUSY=40).

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Dashboard frontend |
| GET | `/api/state` | Full current state snapshot |
| GET | `/api/status` | Live/sim status per module |
| POST | `/api/pwnagotchi` | Pwnagotchi plugin data |
| POST | `/api/nethunter` | NetHunter field agent data |
| POST | `/api/xiao` | XIAO LoRa packet (field mode) |
| POST | `/api/xiao/heartbeat` | XIAO status (field mode) |

---

## MQTT Topics

| Topic | Publisher | Payload |
|-------|-----------|---------|
| `tacops/wifi` | ESP32 #1 | `[{ssid, bssid, ch, rssi, enc, band}]` |
| `tacops/ble` | ESP32 #1 | `[{name, mac, rssi, type}]` |
| `tacops/nrf24` | ESP32 #1 | `[{ch: 0-125, v: 0-100}]` (126 channels) |
| `tacops/rf433_signal` | ESP32 #2 | `{proto, freq, data, rssi}` |
| `tacops/lora` | XIAO (home) | `{node_id, freq, rssi, snr, meshtastic}` |
| `tacops/heartbeat` | All ESP32s | `{device, uptime, heap, ip}` |

---

## Troubleshooting

**`Cannot GET /` in browser:**
```bash
mkdir -p ~/tacops/backend/public
# ensure index.html is in public/
```

**dump1090-fa fails to install:**
FlightAware's apt repo does not support Debian Trixie. Use readsb instead — same SBS output, same port 30003, actively maintained.

**RTL-SDR device busy (`usb_claim_interface error -6`):**
```bash
sudo systemctl stop readsb    # free the dongle first
rtl_433 -f 433.92M -T 30      # then test
sudo systemctl start readsb   # restore when done
```

**ngrok systemd fails (status 203/EXEC):**
```bash
which ngrok   # find real path
# Update ExecStart in ngrok.service to match exact path
sudo systemctl daemon-reload && sudo systemctl restart ngrok
```

**ESP32 WiFi not connecting:**
Use IP address in firmware instead of hostname — ESP32 sometimes fails mDNS resolution:
```cpp
const char* MQTT_BROKER = "10.96.42.97";  // IP not rfconn.local
```

**Pwnagotchi plugin not loading:**
```bash
# Wrong: flat dot notation with string boolean
main.plugins.tacops.enabled = "true"

# Right: TOML table with boolean true
[main.plugins.tacops]
enabled = true
```

**ArduinoJson DynamicJsonDocument deprecated (v7+):**
```cpp
// Replace:  DynamicJsonDocument doc(512);
// With:     JsonDocument doc;
```

**CC1101 getMHZ() compile error:**
```cpp
// Replace:  float currentFreq = ELECHOUSE_cc1101.getMHZ();
// With:     float currentFreq = 433.92;
```

**MQTT not receiving from ESP32:**
```bash
mosquitto_sub -h localhost -t "tacops/#" -v
# Watch for JSON messages every ~15 seconds when ESP32 is live
```

---

## Known Limitations

- Single RTL-SDR cannot run readsb (ADS-B) and rtl_433 (433MHz) simultaneously. A second RTL-SDR v4 solves this permanently.
- Pwnagotchi UDP beacon discovery works on same subnet only. mDNS `rfconn.local` handles same-network different-subnet cases.
- ngrok free tier requires active internet on Pi 5. URL is permanent when reserved in ngrok dashboard.

---

## Roadmap

- [ ] XIAO ESP32S3 Wio SX1262 — LoRa panel live
- [ ] NetHunter tacops-agent.py — Field Agent panel live  
- [ ] AI Intel panel — configure Anthropic API key
- [ ] M5StickC Plus 2 — portable field scout
- [ ] Second RTL-SDR — simultaneous ADS-B + 433MHz live
- [ ] GitHub Actions — auto-deploy to Pi 5 on push
