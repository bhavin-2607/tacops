##############################################################
#  tacops.py — Pwnagotchi Plugin for TacticalOps Dashboard
#
#  Installation:
#  1. Copy this file to /etc/pwnagotchi/custom-plugins/tacops.py
#  2. Edit /etc/pwnagotchi/config.toml and add:
#
#     [main.plugins.tacops]
#     enabled = true
#     api_url = "http://192.168.1.100:3000"   # Pi 5 IP
#     interval = 10                            # seconds between updates
#
#  3. Restart pwnagotchi: sudo systemctl restart pwnagotchi
##############################################################

import pwnagotchi.plugins as plugins
import pwnagotchi.ui.fonts as fonts
from pwnagotchi.ui.components import LabeledValue
from pwnagotchi.ui.view import BLACK
import requests
import threading
import time
import logging


class TacticalOps(plugins.Plugin):
    __author__ = "tacops"
    __version__ = "1.0.0"
    __license__ = "MIT"
    __description__ = "Posts Pwnagotchi stats to TacticalOps dashboard"

    def __init__(self):
        self.options = dict()
        self._api_url = "http://192.168.1.100:3000"
        self._interval = 10
        self._thread = None
        self._running = False
        self._last_mood = "bored"
        self._epoch = 0
        self._captures = 0
        self._last_handshake = None

    def on_loaded(self):
        self._api_url = self.options.get("api_url", self._api_url).rstrip("/")
        self._interval = self.options.get("interval", self._interval)
        self._running = True
        self._thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self._thread.start()
        logging.info("[TacticalOps] Plugin loaded — streaming to %s", self._api_url)

    def on_unload(self, ui):
        self._running = False
        logging.info("[TacticalOps] Plugin unloaded")

    # ── Event hooks ──────────────────────────────────────────────

    def on_epoch(self, agent, epoch, stats):
        """Called at each training epoch — send full status update."""
        self._epoch = epoch
        self._post({
            "mood":     self._last_mood,
            "epoch":    epoch,
            "captures": self._captures,
            "stats": {
                "reward":   round(float(stats.get("reward", 0)), 4),
                "episodes": int(stats.get("episodes_done", 0)),
                "avg_reward": round(float(stats.get("avg_reward", 0)), 4),
            }
        })

    def on_handshake(self, agent, filename, access_point, client_station):
        """Called when a WPA handshake is captured."""
        ssid = access_point.get("hostname", "Unknown")
        bssid = access_point.get("mac", "00:00:00:00:00:00")
        self._captures += 1
        self._last_handshake = ssid

        logging.info("[TacticalOps] Handshake: %s (%s)", ssid, bssid)

        self._post({
            "mood":     self._last_mood,
            "epoch":    self._epoch,
            "captures": self._captures,
            "handshake": {
                "ssid":  ssid,
                "bssid": bssid,
                "file":  filename.split("/")[-1],
            }
        })

    def on_peer_detected(self, agent, peer):
        """Called when another Pwnagotchi is detected."""
        self._post_alert(f"Pwnagotchi peer detected: {peer.name()}", "info")

    def on_deauthentication(self, agent, access_point, client_station):
        ssid = access_point.get("hostname", "?")
        self._post_alert(f"Deauth sent to {ssid}", "warn")

    # ── AI/mood state hooks ───────────────────────────────────────

    def on_bored(self, agent):
        self._last_mood = "bored"

    def on_excited(self, agent):
        self._last_mood = "excited"

    def on_lonely(self, agent):
        self._last_mood = "lonely"

    def on_sad(self, agent):
        self._last_mood = "sad"

    def on_motivated(self, agent):
        self._last_mood = "motivated"

    def on_happy(self, agent):
        self._last_mood = "happy"

    # ── Internal ──────────────────────────────────────────────────

    def _heartbeat_loop(self):
        """Periodic heartbeat — sends status even when no events fire."""
        while self._running:
            try:
                self._post({
                    "mood":     self._last_mood,
                    "epoch":    self._epoch,
                    "captures": self._captures,
                })
            except Exception:
                pass
            time.sleep(self._interval)

    def _post(self, payload):
        try:
            resp = requests.post(
                f"{self._api_url}/api/pwnagotchi",
                json=payload,
                timeout=3
            )
            if resp.status_code != 200:
                logging.warning("[TacticalOps] API returned %d", resp.status_code)
        except requests.exceptions.ConnectionError:
            pass  # Pi 5 not reachable — fail silently
        except Exception as e:
            logging.debug("[TacticalOps] Post error: %s", str(e))

    def _post_alert(self, msg, sev="info"):
        try:
            requests.post(
                f"{self._api_url}/api/alert",
                json={"msg": msg, "sev": sev, "source": "pwnagotchi"},
                timeout=2
            )
        except Exception:
            pass
