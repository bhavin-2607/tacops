#!/bin/bash
# ============================================================
#  TacticalOps — Cloudflare Tunnel Setup
#  Makes Pi 5 reachable from anywhere (mobile data, etc.)
#  Run on Pi 5: bash cloudflare-tunnel.sh
# ============================================================
set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info(){ echo -e "${GREEN}[TACOPS]${NC} $1"; }
warn(){ echo -e "${YELLOW}[WARN]${NC} $1"; }

# ── Install cloudflared ──────────────────────────────────────
info "Installing cloudflared..."
curl -L --output cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb

# ── Login to Cloudflare ──────────────────────────────────────
info "Opening Cloudflare login (opens browser link)..."
cloudflared tunnel login
# This prints a URL — open it on your phone/PC and authorize

# ── Create tunnel ────────────────────────────────────────────
info "Creating tunnel named 'tacops'..."
cloudflared tunnel create tacops

# ── Get tunnel ID ────────────────────────────────────────────
TUNNEL_ID=$(cloudflared tunnel list | grep tacops | awk '{print $1}')
info "Tunnel ID: $TUNNEL_ID"

# ── Create config ────────────────────────────────────────────
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << EOF
tunnel: $TUNNEL_ID
credentials-file: /home/$(whoami)/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: tacops.YOUR_DOMAIN.com   # ← change to your domain
    service: http://localhost:3000
  - service: http_status:404
EOF

info "============================================"
info "Edit ~/.cloudflared/config.yml and set your domain"
info "Then run: cloudflared tunnel run tacops"
info "Or install as service: sudo cloudflared service install"
info "============================================"
warn "No domain? Get a free one at https://www.cloudflare.com/products/tunnel/"
warn "Or use the auto-generated trycloudflare.com URL (no account needed):"
warn "  cloudflared tunnel --url http://localhost:3000"
