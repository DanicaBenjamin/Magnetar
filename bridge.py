#!/usr/bin/env python3
"""
MAGNETAR - Serial Bridge & Local Web Server
===========================================
Connects to Arduino UNO R4 over USB Serial (115200 baud),
parses real-time geomagnetic & Hall sensor telemetry,
and serves the offline scientific dashboard over HTTP/SSE.

Run:
    python bridge.py
or with options:
    python bridge.py --port 8080 --serial COM3
"""

import sys
import os
import time
import json
import re
import argparse
import threading
import math
import urllib.request
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Try importing pyserial; if not yet installed, provide mock/demo mode gracefully
try:
    import serial
    import serial.tools.list_ports
    HAS_PYSERIAL = True
except ImportError:
    HAS_PYSERIAL = False
    print("[WARN] pyserial not found. Running in simulation-only mode until installed.")

# Default configuration
DEFAULT_HTTP_PORT = 8080
DEFAULT_BAUD = 115200
DEFAULT_PORT = "COM7"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

# Shared state
class TelemetryState:
    def __init__(self):
        self.lock = threading.Lock()
        self.serial_port = DEFAULT_PORT
        self.baud_rate = DEFAULT_BAUD
        self.connected = False
        self.connection_msg = f"Ready to connect (Default: {DEFAULT_PORT})"
        self.packet_count = 0
        self.last_packet_time = 0.0
        self.mode = "LIVE"  # LIVE, REPLAY, SIMULATION, IDLE
        
        # Telemetry metrics (matches Arduino sketch defaults)
        self.kp = 4.0
        self.bz = -9.0
        self.solar_speed = 560.0
        self.hall_raw = 2048
        self.hall_baseline = 2048
        self.hall_delta = 0
        self.hall_do = 1
        self.relay_triggered = False
        
        # Risk classification (Predict vs Confirm)
        self.cloud_level = 1
        self.local_level = 0
        self.final_level = 1
        self.risk_level = "WATCH" # QUIET, WATCH, WARNING, SEVERE
        self.space_word = "active"
        self.local_word = "quiet"
        
        # LCD 16x2 mirror
        self.lcd_line1 = "Space: active  S"
        self.lcd_line2 = "Local: quiet    "
        self.rgb_color = "#FED857" # Yellow (Watch)
        self.buzzer = "OFF"
        self.source = "STORED_OFFLINE"
        
        # Raw log buffer (last 100 messages)
        self.raw_logs = []
        self.subscribers = []
        
        # Internal storm replay generator
        self.replay_active = False
        self.replay_start_time = 0
        self.replay_duration = 56 # 8 frames * 7s matching REPLAY_FRAME_MS
        self.noaa_history = []

    def add_log(self, text, is_error=False):
        timestamp = time.strftime("%H:%M:%S")
        entry = {"time": timestamp, "text": text, "is_error": is_error}
        with self.lock:
            self.raw_logs.append(entry)
            if len(self.raw_logs) > 100:
                self.raw_logs.pop(0)

    def to_dict(self):
        with self.lock:
            return {
                "connected": self.connected,
                "serial_port": self.serial_port,
                "baud_rate": self.baud_rate,
                "connection_msg": self.connection_msg,
                "packet_count": self.packet_count,
                "last_packet_time": self.last_packet_time,
                "mode": self.mode,
                "kp": round(self.kp, 1),
                "bz": round(self.bz, 1),
                "solar_speed": round(self.solar_speed, 0),
                "hall_raw": int(self.hall_raw),
                "hall_baseline": int(self.hall_baseline),
                "hall_delta": int(self.hall_delta),
                "hall_do": int(self.hall_do),
                "relay_triggered": bool(self.relay_triggered),
                "cloud_level": int(self.cloud_level),
                "local_level": int(self.local_level),
                "final_level": int(self.final_level),
                "risk_level": self.risk_level,
                "space_word": self.space_word,
                "local_word": self.local_word,
                "lcd_line1": self.lcd_line1,
                "lcd_line2": self.lcd_line2,
                "rgb_color": self.rgb_color,
                "buzzer": self.buzzer,
                "source": self.source,
                "replay_active": self.replay_active,
                "server_time": time.strftime("%H:%M:%S"),
                "noaa_history": list(self.noaa_history)
            }

state = TelemetryState()

NOAA_WIND_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json"
NOAA_MAG_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json"

def fetch_noaa_records(url, field):
    request = urllib.request.Request(url, headers={"User-Agent": "MAGNETAR-dashboard/1.0"})
    with urllib.request.urlopen(request, timeout=12) as response:
        records = json.loads(response.read().decode("utf-8"))
    valid = []
    for record in records:
        try:
            value = float(record.get(field))
            if not math.isfinite(value) or value <= -9000:
                continue
            stamp = record.get("time_tag", "")
            valid.append((stamp, value, record.get("active") is True, parse_noaa_time(stamp)))
        except (TypeError, ValueError):
            continue
    return valid

def parse_noaa_time(stamp):
    try:
        parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (TypeError, ValueError):
        return None

def noaa_worker():
    """Poll NOAA's current one-minute RTSW feeds and retain one hour of real data."""
    while True:
        try:
            wind = fetch_noaa_records(NOAA_WIND_URL, "proton_speed")
            mag = fetch_noaa_records(NOAA_MAG_URL, "bz_gsm")
            active_wind = sorted((row for row in wind if row[2] and row[3] is not None), key=lambda row: row[3])
            active_mag = sorted((row for row in mag if row[2] and row[3] is not None), key=lambda row: row[3])
            rows = []
            if active_wind and active_mag:
                latest_time = min(active_wind[-1][3], active_mag[-1][3])
                cutoff = latest_time - 3600
                recent_mag = [row for row in active_mag if row[3] >= cutoff]
                for wind_row in active_wind:
                    stamp, speed, _, wind_time = wind_row
                    if wind_time < cutoff:
                        continue
                    mag_row = min(recent_mag, key=lambda row: abs(row[3] - wind_time), default=None)
                    if mag_row and abs(mag_row[3] - wind_time) <= 90:
                        rows.append({"time_tag": stamp, "solar_speed": speed, "bz": mag_row[1]})
            if not rows:
                # If timestamps do not overlap yet, keep the latest active measurements visible.
                if active_wind and active_mag:
                    stamp, speed, _, _ = active_wind[-1]
                    bz = active_mag[-1][1]
                    rows = [{"time_tag": stamp, "solar_speed": speed, "bz": bz}]
            if rows:
                with state.lock:
                    # Replace the rolling NOAA snapshot with real minute-cadence samples.
                    state.noaa_history = rows[-60:]
                    if not state.connected and not state.replay_active:
                        latest = state.noaa_history[-1]
                        state.solar_speed = latest["solar_speed"]
                        state.bz = latest["bz"]
                        state.risk_level, state.rgb_color, state.buzzer = evaluate_risk(
                            state.kp, state.bz, state.hall_delta
                        )
                        state.source = "NOAA_LIVE"
                        state.mode = "LIVE"
                        state.packet_count += 1
                        state.last_packet_time = time.time()
        except Exception as exc:
            state.add_log(f"[NOAA] Solar-wind update failed: {exc}", is_error=True)
        time.sleep(60)

LEVEL_NAMES = ["QUIET", "WATCH", "WARNING", "SEVERE"]
SPACE_WORDS = ["calm", "active", "STORM!", "SEVERE"]
LOCAL_WORDS = ["quiet", "change", "FIELD!", "STRONG"]
LEVEL_COLORS = ["#34C759", "#FED857", "#FF9500", "#FF3B30"]
LEVEL_BUZZERS = ["OFF", "OFF", "CHIRP", "ALARM"]

def evaluate_risk(kp, bz, delta):
    """Scientific risk classifier matching Arduino UNO logic"""
    abs_delta = abs(delta)
    if kp >= 7.0 or bz <= -15.0 or abs_delta >= 30:
        return "SEVERE", "#E84855", "ALARM"
    elif kp >= 5.0 or bz <= -8.0 or abs_delta >= 18:
        return "WARNING", "#F38D3C", "PULSE"
    elif kp >= 3.5 or bz <= -3.0 or abs_delta >= 8:
        return "WATCH", "#F4C542", "CHIRP"
    else:
        return "QUIET", "#4EBA86", "OFF"

def parse_incoming_line(line):
    """
    Parses an incoming Serial string from the Arduino.
    Supports:
      1. JSON: {"kp": 6.2, "bz": -11.5, "speed": 630, "hall": 535, "delta": 23, "risk": "WARNING", ...}
      2. CSV/MAG prefix: MAG:kp=6.2,bz=-11.5,speed=630,hall=535,delta=23,risk=WARNING,lcd=LINE1|LINE2
      3. Pure CSV: MAG,6.2,-11.5,630,535,23,WARNING
      4. Plain text diagnostic messages (saved directly to serial console)
    """
    line = line.strip()
    if not line:
        return

    # Check for baseline calibration notification
    if "hall baseline:" in line.lower():
        try:
            val = float(re.findall(r'[\d\.]+', line)[0])
            with state.lock:
                state.hall_baseline = val
            state.add_log(f"[CAL] Local baseline detected: {val}")
        except Exception:
            pass

    # Check for exact MAGNETAR Arduino UNO R4 sketch line format:
    # L0 cloud=0 local=0 dev=2 DO=1 kp=4.0 v=560 bz=-9.0
    match_l = re.match(r"^L([0-3])\s+cloud=([0-3])\s+local=([0-3])\s+dev=(\d+)\s+DO=([01])\s+kp=([-\d\.]+)\s+v=([-\d\.]+)\s+bz=([-\d\.]+)", line)
    if match_l:
        final_lvl = int(match_l.group(1))
        c_lvl = int(match_l.group(2))
        l_lvl = int(match_l.group(3))
        h_dev = int(match_l.group(4))
        h_do = int(match_l.group(5))
        k_val = float(match_l.group(6))
        v_val = float(match_l.group(7))
        b_val = float(match_l.group(8))

        with state.lock:
            state.final_level = final_lvl
            state.cloud_level = c_lvl
            state.local_level = l_lvl
            state.hall_delta = h_dev
            state.hall_raw = int(state.hall_baseline + h_dev)
            state.hall_do = h_do
            state.kp = k_val
            state.solar_speed = v_val
            state.bz = b_val
            state.risk_level = LEVEL_NAMES[final_lvl]
            state.space_word = SPACE_WORDS[c_lvl]
            state.local_word = LOCAL_WORDS[l_lvl]
            state.rgb_color = LEVEL_COLORS[final_lvl]
            state.buzzer = LEVEL_BUZZERS[final_lvl]
            state.relay_triggered = (final_lvl >= 3)
            state.source = "USB_LIVE (COM7)"
            state.packet_count += 1
            state.last_packet_time = time.time()
            state.mode = "LIVE"

            # Sync LCD 16x2 mirror to match sketch
            src_char = 'S' if (k_val == 4.0 and v_val == 560.0 and b_val == -9.0) else 'L'
            if int(time.time() / 3) % 2 == 0:
                state.lcd_line1 = f"Space: {state.space_word:<7}{src_char}".ljust(16)[:16]
                state.lcd_line2 = f"Local: {state.local_word}".ljust(16)[:16]
            else:
                state.lcd_line1 = f"Kp:{k_val:.1f} Wind:{int(v_val):<3}{src_char}".ljust(16)[:16]
                state.lcd_line2 = f"Bz:{int(b_val)} Hall:{h_dev}".ljust(16)[:16]

        state.add_log(f"[RX-UNO] {line}")
        return

    # Check for JSON format
    if line.startswith("{") and line.endswith("}"):
        try:
            data = json.loads(line)
            with state.lock:
                state.kp = float(data.get("kp", state.kp))
                state.bz = float(data.get("bz", state.bz))
                state.solar_speed = float(data.get("speed", data.get("solar_speed", state.solar_speed)))
                state.hall_raw = int(data.get("hall", data.get("hall_raw", state.hall_raw)))
                state.hall_delta = int(data.get("delta", data.get("hall_delta", state.hall_raw - state.hall_baseline)))
                
                # Risk level
                if "risk" in data:
                    state.risk_level = str(data["risk"]).upper()
                    # compute colors
                    _, state.rgb_color, state.buzzer = evaluate_risk(state.kp, state.bz, state.hall_delta)
                else:
                    state.risk_level, state.rgb_color, state.buzzer = evaluate_risk(state.kp, state.bz, state.hall_delta)

                if "lcd1" in data and "lcd2" in data:
                    state.lcd_line1 = str(data["lcd1"])[:16].ljust(16)
                    state.lcd_line2 = str(data["lcd2"])[:16].ljust(16)
                elif "lcd" in data:
                    parts = str(data["lcd"]).split("|")
                    state.lcd_line1 = parts[0][:16].ljust(16)
                    state.lcd_line2 = parts[1][:16].ljust(16) if len(parts) > 1 else ""

                state.source = "USB_LIVE"
                state.packet_count += 1
                state.last_packet_time = time.time()
                state.mode = data.get("mode", "LIVE")
            state.add_log(f"[RX-JSON] {line}")
            return
        except Exception as e:
            state.add_log(f"[JSON ERR] {e}: {line}", is_error=True)

    # Check for MAG / DATA prefix
    if line.startswith("MAG:") or line.startswith("DATA:"):
        payload = line.split(":", 1)[1]
        try:
            # Key-value parse (e.g. kp=6.2,bz=-11.5)
            kv_pairs = re.findall(r'(\w+)=([^,]+)', payload)
            if kv_pairs:
                d = {k.lower(): v for k, v in kv_pairs}
                with state.lock:
                    if "kp" in d: state.kp = float(d["kp"])
                    if "bz" in d: state.bz = float(d["bz"])
                    if "speed" in d: state.solar_speed = float(d["speed"])
                    if "hall" in d: state.hall_raw = int(d["hall"])
                    if "delta" in d: state.hall_delta = int(d["delta"])
                    else: state.hall_delta = state.hall_raw - state.hall_baseline
                    
                    if "risk" in d:
                        state.risk_level = d["risk"].upper()
                        _, state.rgb_color, state.buzzer = evaluate_risk(state.kp, state.bz, state.hall_delta)
                    else:
                        state.risk_level, state.rgb_color, state.buzzer = evaluate_risk(state.kp, state.bz, state.hall_delta)

                    if "lcd" in d:
                        parts = d["lcd"].split("|")
                        state.lcd_line1 = parts[0][:16].ljust(16)
                        state.lcd_line2 = parts[1][:16].ljust(16) if len(parts) > 1 else ""

                    state.source = "USB_LIVE"
                    state.packet_count += 1
                    state.last_packet_time = time.time()
                    state.mode = "LIVE"
                state.add_log(f"[RX-KV] {line}")
                return
            else:
                # Comma separated values: MAG:kp,bz,speed,hall,delta,risk
                tokens = [t.strip() for t in payload.split(",")]
                if len(tokens) >= 5:
                    with state.lock:
                        state.kp = float(tokens[0])
                        state.bz = float(tokens[1])
                        state.solar_speed = float(tokens[2])
                        state.hall_raw = int(tokens[3])
                        state.hall_delta = int(tokens[4])
                        if len(tokens) >= 6:
                            state.risk_level = tokens[5].upper()
                            _, state.rgb_color, state.buzzer = evaluate_risk(state.kp, state.bz, state.hall_delta)
                        else:
                            state.risk_level, state.rgb_color, state.buzzer = evaluate_risk(state.kp, state.bz, state.hall_delta)
                        
                        if len(tokens) >= 7:
                            parts = tokens[6].split("|")
                            state.lcd_line1 = parts[0][:16].ljust(16)
                            state.lcd_line2 = parts[1][:16].ljust(16) if len(parts) > 1 else ""

                        state.source = "USB_LIVE"
                        state.packet_count += 1
                        state.last_packet_time = time.time()
                        state.mode = "LIVE"
                    state.add_log(f"[RX-CSV] {line}")
                    return
        except Exception as e:
            state.add_log(f"[PARSE ERR] {e}: {line}", is_error=True)
            return

    # Diagnostic text from Arduino (e.g. "Calibrating baseline...", "WiFi Init failed")
    if not line.startswith("[ARDUINO]"):
        state.add_log(f"[ARDUINO] {line}")
    else:
        state.add_log(line)


class SerialManager:
    """Manages background serial port connection and reading"""
    def __init__(self):
        self.ser = None
        self.running = True
        self.target_port = "COM7"
        self.thread = threading.Thread(target=self._worker, daemon=True)
        self.thread.start()

    def set_port(self, port, baud=DEFAULT_BAUD):
        self.target_port = port
        state.baud_rate = baud
        if self.ser and self.ser.is_open:
            try:
                self.ser.close()
            except Exception:
                pass

    def send_command(self, cmd_str):
        if self.ser and self.ser.is_open:
            try:
                self.ser.write((cmd_str + "\n").encode("utf-8"))
                state.add_log(f"[TX] Sent command: {cmd_str}")
                return True
            except Exception as e:
                state.add_log(f"[TX ERR] {e}", is_error=True)
                return False
        return False

    def list_ports(self):
        if not HAS_PYSERIAL:
            return []
        ports = []
        for p in serial.tools.list_ports.comports():
            ports.append({
                "port": p.device,
                "description": p.description,
                "hwid": p.hwid,
                "is_arduino": "arduino" in p.description.lower() or "ch340" in p.description.lower() or "usb" in p.description.lower() or p.device == "COM7"
            })
        return ports

    def _worker(self):
        while self.running:
            if not HAS_PYSERIAL:
                time.sleep(1)
                continue

            # Auto-detect if no target port specified
            if not self.target_port:
                ports = self.list_ports()
                arduino_ports = [p["port"] for p in ports if p["is_arduino"]]
                if arduino_ports:
                    self.target_port = arduino_ports[0]
                    state.add_log(f"[AUTO-DETECT] Found potential Arduino on {self.target_port}")

            if not self.target_port:
                state.connected = False
                state.connection_msg = "No serial port selected. Waiting..."
                time.sleep(1.5)
                continue

            try:
                state.connection_msg = f"Connecting to {self.target_port} at {state.baud_rate}..."
                self.ser = serial.Serial(self.target_port, state.baud_rate, timeout=1.0)
                state.serial_port = self.target_port
                state.connected = True
                state.connection_msg = f"Connected to {self.target_port} @ {state.baud_rate}"
                state.add_log(f"[SERIAL] Connected to {self.target_port} @ {state.baud_rate}")

                # Give Arduino UNO R4 time to reset on DTR if needed
                time.sleep(0.5)

                while self.running and self.ser and self.ser.is_open:
                    if self.ser.in_waiting > 0:
                        raw = self.ser.readline()
                        try:
                            line = raw.decode("utf-8", errors="replace").strip()
                            if line:
                                parse_incoming_line(line)
                        except Exception as e:
                            state.add_log(f"[DECODE ERR] {e}", is_error=True)
                    else:
                        time.sleep(0.02)

            except Exception as e:
                state.connected = False
                err_msg = str(e)
                if "PermissionError" in err_msg or "Access is denied" in err_msg:
                    err_msg = f"COM port {self.target_port} is busy. Please close the Arduino IDE Serial Monitor / Plotter window!"
                state.connection_msg = err_msg
                state.add_log(f"[SERIAL ERR] {err_msg}", is_error=True)
                if self.ser:
                    try:
                        self.ser.close()
                    except Exception:
                        pass
                    self.ser = None
                time.sleep(2.0)

serial_mgr = SerialManager()


def simulation_worker():
    """
    Background simulation worker that generates a realistic 60-second
    geomagnetic storm sequence when replay is triggered or in offline demo mode.
    """
    import math
    while True:
        if state.replay_active:
            elapsed = time.time() - state.replay_start_time
            if elapsed >= state.replay_duration:
                # Replay finished, return to quiet standby
                state.replay_active = False
                state.mode = "STANDBY"
                state.add_log("[REPLAY] 60-second storm replay sequence complete.")
            else:
                progress = elapsed / state.replay_duration # 0.0 to 1.0
                
                # Synthetic storm curve:
                # 0.0 - 0.2: Quiet (Kp 2.0, Bz +2.5, Speed 380, Hall delta 0)
                # 0.2 - 0.4: Sudden Commencement / Shock (Kp jumps to 4.5, Bz dips to -5, Speed 550, Hall delta +10)
                # 0.4 - 0.7: Severe Main Phase Peak (Kp 8.5, Bz plunges to -22, Speed 880, Hall delta +38)
                # 0.7 - 1.0: Recovery Phase (gradual decay back to quiet)
                noise = (math.sin(elapsed * 2.5) * 0.4)
                
                if progress < 0.2:
                    kp = 1.8 + (progress / 0.2) * 0.8 + noise * 0.2
                    bz = 3.5 - (progress / 0.2) * 5.0 + noise * 0.5
                    speed = 380 + (progress / 0.2) * 70
                    delta = int((progress / 0.2) * 6)
                    lcd1 = "MAGNETAR: QUIET"
                    lcd2 = f"Kp:{kp:.1f} Bz:{bz:+.1f}nT"
                elif progress < 0.4:
                    p = (progress - 0.2) / 0.2
                    kp = 2.6 + p * 3.2 + noise * 0.4
                    bz = -1.5 - p * 8.0 + noise * 0.8
                    speed = 450 + p * 190
                    delta = int(6 + p * 14 + noise * 3)
                    lcd1 = "MAGNETAR: WATCH"
                    lcd2 = f"CME ARRIVAL! Kp{kp:.1f}"
                elif progress < 0.7:
                    p = (progress - 0.4) / 0.3
                    kp = 5.8 + math.sin(p * math.pi) * 2.9 + noise * 0.3
                    bz = -9.5 - math.sin(p * math.pi) * 13.5 + noise * 1.0
                    speed = 640 + math.sin(p * math.pi) * 220
                    delta = int(20 + math.sin(p * math.pi) * 22 + noise * 4)
                    lcd1 = "ALERT: SEVERE G4"
                    lcd2 = f"Bz:{bz:.0f}nT V:{speed:.0f}k"
                else:
                    p = (progress - 0.7) / 0.3
                    kp = 8.7 - p * 6.5 + noise * 0.3
                    bz = -23.0 + p * 25.0 + noise * 0.8
                    speed = 860 - p * 450
                    delta = int(42 - p * 40)
                    lcd1 = "MAGNETAR: RECOV"
                    lcd2 = f"FIELD RESTORING"

                risk, rgb, buzzer = evaluate_risk(kp, bz, delta)
                with state.lock:
                    state.kp = kp
                    state.bz = bz
                    state.solar_speed = speed
                    state.hall_delta = delta
                    state.hall_raw = state.hall_baseline + delta
                    state.risk_level = risk
                    state.rgb_color = rgb
                    state.buzzer = buzzer
                    state.lcd_line1 = lcd1.ljust(16)[:16]
                    state.lcd_line2 = lcd2.ljust(16)[:16]
                    state.source = "HARDWARE_REPLAY_SIM"
                    state.mode = "REPLAY"
                    state.packet_count += 1
                    state.last_packet_time = time.time()

        time.sleep(0.1)

sim_thread = threading.Thread(target=simulation_worker, daemon=True)
sim_thread.start()
noaa_thread = threading.Thread(target=noaa_worker, daemon=True)
noaa_thread.start()


class MagnetarHTTPHandler(SimpleHTTPRequestHandler):
    """Custom HTTP handler serving web dashboard and REST/SSE endpoints"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def log_message(self, format, *args):
        # Silence routine static asset HTTP GET logs to keep terminal uncluttered
        if args and str(args[0]).startswith("GET /api/"):
            return
        # super().log_message(format, *args)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # SSE Telemetry Stream: /api/stream
        if path == "/api/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            try:
                while True:
                    data = state.to_dict()
                    payload = f"data: {json.dumps(data)}\n\n"
                    self.wfile.write(payload.encode("utf-8"))
                    self.wfile.flush()
                    time.sleep(0.1)  # 10 Hz refresh
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        # REST: Get current status
        if path == "/api/status":
            self.send_json(state.to_dict())
            return

        # REST: Get detected serial COM ports
        if path == "/api/ports":
            ports = serial_mgr.list_ports()
            self.send_json({"ports": ports, "current": state.serial_port})
            return

        # REST: Get raw logs
        if path == "/api/logs":
            with state.lock:
                logs = list(state.raw_logs)
            self.send_json({"logs": logs})
            return

        # Static files fallback
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            req_data = json.loads(body)
        except Exception:
            req_data = {}

        # POST /api/connect {"port": "COM3", "baud": 115200}
        if path == "/api/connect":
            target_port = req_data.get("port")
            baud = int(req_data.get("baud", DEFAULT_BAUD))
            if target_port:
                serial_mgr.set_port(target_port, baud)
                self.send_json({"success": True, "message": f"Connecting to {target_port}..."})
            else:
                self.send_json({"success": False, "message": "Port not provided"}, status=400)
            return

        # POST /api/disconnect
        if path == "/api/disconnect":
            serial_mgr.set_port(None)
            self.send_json({"success": True, "message": "Disconnected serial port"})
            return

        # POST /api/command {"cmd": "R"} (e.g. trigger Arduino storm replay)
        if path == "/api/command":
            cmd = req_data.get("cmd", "")
            sent = serial_mgr.send_command(cmd)
            self.send_json({"success": sent, "command": cmd})
            return

        # POST /api/replay {"action": "start"|"stop", "duration": 60}
        if path == "/api/replay":
            action = req_data.get("action", "start")
            if action == "start":
                state.replay_active = True
                state.replay_start_time = time.time()
                state.replay_duration = int(req_data.get("duration", 60))
                # Also notify Arduino over serial in case it has scripted replay
                serial_mgr.send_command("REPLAY")
                state.add_log("[REPLAY] Started 60-second storm replay scenario")
                self.send_json({"success": True, "replay_active": True})
            else:
                state.replay_active = False
                state.mode = "STANDBY"
                serial_mgr.send_command("STOP")
                state.add_log("[REPLAY] Stopped storm replay")
                self.send_json({"success": True, "replay_active": False})
            return

        # POST /api/calibrate (zero local Hall sensor baseline)
        if path == "/api/calibrate":
            with state.lock:
                state.hall_baseline = state.hall_raw
                state.hall_delta = 0
            serial_mgr.send_command("CAL")
            state.add_log(f"[CALIBRATE] Local baseline zeroed to ADC={state.hall_baseline}")
            self.send_json({"success": True, "baseline": state.hall_baseline})
            return

        self.send_json({"error": "Endpoint not found"}, status=404)

    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Enable CORS for local hacking
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()


def main():
    parser = argparse.ArgumentParser(description="MAGNETAR Scientific Dashboard & Serial Bridge")
    parser.add_argument("--port", type=int, default=DEFAULT_HTTP_PORT, help=f"HTTP Web port (default: {DEFAULT_HTTP_PORT})")
    parser.add_argument("--serial", type=str, default=None, help="Serial port to connect (e.g. COM3 or /dev/ttyACM0)")
    parser.add_argument("--baud", type=int, default=DEFAULT_BAUD, help=f"Baud rate (default: {DEFAULT_BAUD})")
    args = parser.parse_args()

    if args.serial:
        serial_mgr.set_port(args.serial, args.baud)

    print("=" * 64)
    print(" MAGNETAR — Geomagnetic Storm Early-Warning Station Bridge")
    print("=" * 64)
    print(f" * Web Dashboard:  http://localhost:{args.port}")
    print(f" * Serial Baud:    {args.baud} 8-N-1")
    if HAS_PYSERIAL:
        ports = [p["port"] for p in serial_mgr.list_ports()]
        print(f" * Available COM:  {', '.join(ports) if ports else 'None detected'}")
    else:
        print(" * Note:           Install pyserial for hardware COM connection")
    print(" * Offline Mode:   Fully supported (no internet required)")
    print("=" * 64)
    print("Press Ctrl+C to stop.\n")

    httpd = HTTPServer(("0.0.0.0", args.port), MagnetarHTTPHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[MAGNETAR] Shutting down bridge gracefully...")
        serial_mgr.running = False
        httpd.server_close()

if __name__ == "__main__":
    main()
