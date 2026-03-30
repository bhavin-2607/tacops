#!/bin/bash
# ============================================================
#  TacticalOps Dashboard — Pi 5 Setup Script
#  Run once as root: sudo bash pi5-setup.sh
# ============================================================
set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info(){ echo -e "${GREEN}[TACOPS]${NC} $1"; }
warn(){ echo -e "${YELLOW}[WARN]${NC} $1"; }

info "Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

# ── Core dependencies ───────────────────────────────────────
info "Installing core dependencies..."
apt-get install -y -qq \
  git curl wget build-essential cmake \
  libusb-1.0-0-dev pkg-config \
  mosquitto mosquitto-clients \
  python3-pip python3-venv \
  rtl-sdr \
  sox libsox-fmt-all

# ── Node.js 20 LTS ─────────────────────────────────────────
info "Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - -qq
apt-get install -y -qq nodejs

# ── dump1090-fa (ADS-B decoder) ─────────────────────────────
# Uses wiedehopf's script — handles udev, systemd service, and RTL-SDR config
# automatically. Much more reliable than apt/build-from-source.
info "Installing dump1090-fa via wiedehopf script..."
if ! command -v dump1090-fa &>/dev/null; then
  bash -c "$(curl -L -o - https://github.com/wiedehopf/adsb-scripts/raw/master/install-dump1090-fa.sh)"
  info "dump1090-fa installed as a systemd service."
  info "Run 'sudo dump1090-fa-gain 42.1' to set RTL-SDR gain."
  info "Run 'sudo dump1090-fa-set-location LAT LON' to set your location."
  warn "A reboot is recommended after this script finishes (required for udev rules)."
else
  info "dump1090-fa already installed — skipping."
fi

# ── rtl_433 (Sub-GHz decoder) ───────────────────────────────
info "Installing rtl_433..."
if ! command -v rtl_433 &>/dev/null; then
  apt-get install -y -qq rtl-433 2>/dev/null || {
    warn "rtl_433 not in apt, building from source..."
    cd /tmp
    git clone --quiet https://github.com/merbanan/rtl_433.git
    cd rtl_433 && mkdir build && cd build
    cmake .. -DCMAKE_BUILD_TYPE=Release -DENABLE_RTLSDR=ON > /dev/null
    make -s -j4 && make install -s
    cd /home/pi
  }
fi

# NOTE: DVB kernel module blacklisting and udev rules for RTL-SDR
# are handled automatically by the wiedehopf dump1090-fa install script above.

# ── Mosquitto config ────────────────────────────────────────
info "Configuring Mosquitto MQTT broker..."
cat > /etc/mosquitto/conf.d/tacops.conf << 'EOF'
# TacticalOps MQTT config
listener 1883
allow_anonymous true

# WebSocket listener for browser clients
listener 9001
protocol websockets
allow_anonymous true
EOF
systemctl enable mosquitto
systemctl restart mosquitto

# ── Udev rules for RTL-SDR ──────────────────────────────────
info "Adding RTL-SDR udev rules..."
cat > /etc/udev/rules.d/20-rtlsdr.rules << 'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666", SYMLINK+="rtlsdr"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", GROUP="plugdev", MODE="0666"
EOF
udevadm control --reload-rules

# ── Project directory setup ─────────────────────────────────
info "Setting up project directories..."
PROJ_DIR="/opt/tacops"
mkdir -p "$PROJ_DIR"
chown -R pi:pi "$PROJ_DIR"

# ── Systemd service for TacticalOps backend ─────────────────
info "Installing TacticalOps systemd service..."
cat > /etc/systemd/system/tacops.service << 'EOF'
[Unit]
Description=TacticalOps Dashboard Backend
After=network.target mosquitto.service
Wants=mosquitto.service

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/tacops/backend
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable tacops

# ── Firewall rules ──────────────────────────────────────────
info "Opening required ports (3000, 1883, 9001)..."
if command -v ufw &>/dev/null; then
  ufw allow 3000/tcp comment "TacticalOps Dashboard"
  ufw allow 1883/tcp comment "MQTT"
  ufw allow 9001/tcp comment "MQTT WebSocket"
fi

info "============================================"
info "  Setup complete! Next steps:"
info "  1. Copy backend/ to /opt/tacops/backend/"
info "  2. cd /opt/tacops/backend && npm install"
info "  3. sudo systemctl start tacops"
info "  4. Open http://$(hostname -I | awk '{print $1}'):3000"
info "============================================"
