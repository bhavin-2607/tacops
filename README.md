# TacticalOps Dashboard — Setup Guide

## Hardware Map

| Device | Role | Status |
|--------|------|--------|
| Raspberry Pi 5 | Central hub, runs backend + dashboard | Required first |
| RTL-SDR v4 | ADS-B flights + 433 MHz decode | Plug in after Pi setup |
| ESP32 #1 (WROOM-32U) | WiFi scanner + BLE + nRF24 | Flash firmware, connect to WiFi |
| ESP32 #2 (WROOM-32U) | CC1101 433 MHz decoder | Flash firmware |
| ESP32 #3 (WROOM-32U) | Spare / extend nRF24 array | Optional |
| nRF24L01+PA+LNA ×4 | 2.4 GHz spectrum monitor | Wire to ESP32 #1 |
| CC1101 433 MHz | Sub-GHz signal capture | Wire to ESP32 #2 |
| Pi Zero 2W (Pwnagotchi) | WiFi handshake capture | Install plugin |
| M5StickC Plus 2 | Portable field scout | Coming next phase |

---

## Step 1 — Raspberry Pi 5 Setup

```bash
# Flash Raspberry Pi OS (64-bit) to SD card using Raspberry Pi Imager
# Enable SSH in imager settings, set hostname: grootxpi
# Boot Pi, SSH in:

ssh pi@grootxpi.local

# Clone the project
git clone https://github.com/YOUR_USERNAME/tacops.git /opt/tacops
cd /opt/tacops

# Run the one-shot setup script (installs all dependencies)
sudo bash scripts/pi5-setup.sh
```

---

## Step 2 — Start the Backend

```bash
cd /opt/tacops/backend

# Install Node dependencies
npm install

# Copy and edit environment config
cp .env.example .env
nano .env
# Set your ANTHROPIC_API_KEY

# Start in development mode
npm run dev

# OR start as a system service
sudo systemctl start tacops
sudo systemctl status tacops
```

Open the dashboard: **http://grootxpi.local:3000**

> All panels will show **simulated data** until hardware is connected. The status bar at the bottom of the dashboard shows which sensors are LIVE vs SIMULATED.

---

## Step 3 — Connect RTL-SDR v4

You already installed dump1090-fa via wiedehopf's script — good. Here's how to verify and configure it:

```bash
# Verify RTL-SDR is detected by the OS
lsusb | grep Realtek
# Should show: Bus 00x Device 00x: ID 0bda:2838 Realtek Semiconductor Corp.

# Check dump1090-fa service status (it runs automatically on boot)
sudo systemctl status dump1090-fa

# If it's not running, start it:
sudo systemctl start dump1090-fa
sudo systemctl enable dump1090-fa  # auto-start on boot

# Set your RTL-SDR gain (42.1 is a good starting point for Ahmedabad)
# Valid values: 0.0 0.9 1.4 2.7 3.7 7.7 8.7 12.5 14.4 15.7 16.6 19.7
#               20.7 22.9 25.4 28.0 29.7 32.8 33.8 36.4 37.2 38.6 40.2
#               42.1 43.4 43.9 44.5 48.0 49.6 -10 (max, ~55 effective)
sudo dump1090-fa-gain 42.1

# Set your location (Ahmedabad approximate coords):
sudo dump1090-fa-set-location 23.0225 72.5714

# Verify SBS data is flowing on port 30003 (what our backend reads):
nc -z localhost 30003 && echo "OK — data flowing" || echo "NOT running"

# Or watch raw SBS messages live:
nc localhost 30003 | head -20

# Test 433 MHz decoder (backend auto-spawns rtl_433, but verify manually):
rtl_433 -f 433.92M -F json
# ⚠️  Only one process can use the RTL-SDR at a time.
# Stop rtl_433 test before starting the backend, or use a second RTL-SDR dongle.

# View dump1090-fa logs if something is wrong:
sudo journalctl --no-pager -u dump1090-fa -n 50
```

> The backend connects to dump1090-fa on port 30003 (SBS TCP output).
> The ADS-B panel switches from **SIMULATED → LIVE** automatically once data flows.

---

## Step 4 — Flash ESP32 #1 (WiFi + BLE + nRF24)

### Wiring nRF24L01+PA+LNA to ESP32:

```
nRF24L01    ESP32
---------   -----
VCC      →  3.3V  (use AMS1117 regulator — nRF24 needs clean 3.3V)
GND      →  GND
CE       →  GPIO 4
CSN      →  GPIO 5
SCK      →  GPIO 18
MOSI     →  GPIO 23
MISO     →  GPIO 19
IRQ      →  (not connected)
```

> ⚠️ The nRF24+PA+LNA module draws ~115mA peaks. Power from a separate 3.3V regulator, not the ESP32's onboard 3.3V pin.

### Flash firmware:

1. Open Arduino IDE
2. Install boards: ESP32 by Espressif (via Board Manager)
3. Install libraries: `PubSubClient`, `RF24`, `ArduinoJson`
4. Open `esp32/wifi_ble_nrf24/wifi_ble_nrf24.ino`
5. Edit `WIFI_SSID`, `WIFI_PASS`, `MQTT_BROKER` (Pi 5 IP)
6. Select board: `ESP32 Dev Module`, upload speed: `921600`
7. Flash and monitor serial output

---

## Step 5 — Flash ESP32 #2 (CC1101 433 MHz)

### Wiring CC1101 to ESP32:

```
CC1101    ESP32
------    -----
VCC    →  3.3V
GND    →  GND
SCK    →  GPIO 18
MOSI   →  GPIO 23
MISO   →  GPIO 19
CSN    →  GPIO 5
GDO0   →  GPIO 2
GDO2   →  GPIO 4 (optional)
```

### Flash firmware:

1. Install library: `ELECHOUSE_CC1101_SRC_DRV` (search in Library Manager)
2. Open `esp32/cc1101_rf433/cc1101_rf433.ino`
3. Edit WiFi and MQTT settings
4. Flash to ESP32

---

## Step 6 — Pwnagotchi Plugin

```bash
# On your Pi Zero 2W (with Pwnagotchi running):

# Copy the plugin
sudo cp pwnagotchi/tacops.py /etc/pwnagotchi/custom-plugins/

# Edit Pwnagotchi config
sudo nano /etc/pwnagotchi/config.toml

# Add these lines:
[main.plugins.tacops]
enabled = true
api_url = "http://192.168.1.100:3000"  # your Pi 5 IP
interval = 10

# Restart Pwnagotchi
sudo systemctl restart pwnagotchi
```

---

## Status Indicators

Once hardware is live, the dashboard status bar changes:

| Indicator | Meaning |
|-----------|---------|
| `● LIVE` (green) | Real hardware data |
| `○ SIM` (dim) | Simulated fallback |

Each module activates independently — you don't need all hardware connected at once.

---

## Network Topology

```
[Internet]
     |
[Your Router] ← 192.168.1.x
     |
     ├── [Raspberry Pi 5] :3000 (Dashboard) :1883 (MQTT) :30003 (dump1090)
     |        ↑ USB
     |    [RTL-SDR v4]
     |
     ├── [ESP32 #1] → MQTT tacops/wifi, tacops/ble, tacops/nrf24
     |        ↑ SPI
     |    [nRF24L01+PA+LNA ×4]
     |
     ├── [ESP32 #2] → MQTT tacops/rf433_signal
     |        ↑ SPI
     |    [CC1101 433 MHz]
     |
     └── [Pi Zero 2W] → HTTP POST /api/pwnagotchi
          (Pwnagotchi AP mode — connects to your router)
```

---

## Troubleshooting

**RTL-SDR not detected / permission errors:**
```bash
lsusb | grep Realtek   # should show RTL2838
# wiedehopf's script handles udev rules but needs a reboot:
sudo reboot
# After reboot, verify:
sudo systemctl status dump1090-fa
```

**dump1090-fa not starting:**
```bash
sudo journalctl --no-pager -u dump1090-fa -n 50
# Most common cause: needs reboot after first install for udev rules
```

**rtl_433 and dump1090-fa conflict (one RTL-SDR dongle):**
```bash
# Both decoders want the same hardware — only one wins at a time.
# The backend's rf433 module only runs rtl_433 when dump1090-fa is NOT
# actively using the dongle. To test 433 MHz manually:
sudo systemctl stop dump1090-fa
rtl_433 -f 433.92M -F json -T 15
sudo systemctl start dump1090-fa
# Permanent fix: buy a second RTL-SDR dongle (~₹1500 on Amazon India)
# Then pass -d 0 to dump1090-fa and -d 1 to rtl_433
```

**MQTT not receiving from ESP32:**
```bash
# On Pi 5 — subscribe to all tacops topics:
mosquitto_sub -h localhost -t "tacops/#" -v
# You should see messages when ESP32s are live
```

**ESP32 not connecting to MQTT:**
- Verify Pi 5 IP in firmware matches your network
- Check Mosquitto is running: `systemctl status mosquitto`
- Try: `mosquitto_pub -h 192.168.1.100 -t test -m hello`
