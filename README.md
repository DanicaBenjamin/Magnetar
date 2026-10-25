# MAGNETAR — Geomagnetic Storm Early-Warning Station

> **Prototype combining Arduino UNO R4 WiFi hardware and a local scientific observatory dashboard over USB Serial.**

---

## 🛰️ Overview

MAGNETAR is a physical early-warning prototype designed to monitor solar space weather (Kp-index, solar wind velocity, IMF $B_z$) alongside ground-level magnetic perturbations measured by an onboard **Hall-effect magnetometer**.

When an interplanetary shockwave or Coronal Mass Ejection (CME) hits Earth with **Southward $B_z$ orientation**, magnetic reconnection funnels energetic solar particles into the magnetosphere, triggering geomagnetic storms (G1 through G5) and inducing hazardous Ground-Induced Currents (GIC) in power grids.

---

## 🎨 Design Philosophy & Aesthetic
Per project design requirements:
- **Palette**: Deep Royal Indigo / Midnight Violet (`#22163E`), Warm Ivory / Vintage Scientific Cream (`#F6F0DF`), and Golden Amber Accent (`#FED857`).
- **Look & Feel**: A believable, tactile student-built scientific instrument dashboard — restrained colors, high-contrast monospace readouts, authentic 16×2 LCD simulation, dual-trace oscilloscope canvas, and clear functional indicators without AI template gimmicks.
- **100% Offline Capable**: Zero cloud dependencies, zero external CDNs required for operation. Works directly in any browser over local USB serial.

---

## 🔌 Hardware Configuration (Arduino UNO R4 WiFi)

| Component | Arduino Pin / Interface | Function |
| :--- | :--- | :--- |
| **Microcontroller** | Arduino UNO R4 WiFi (Renesas RA4M1 @ 48MHz) | Real-time sensor acquisition & alert synthesis |
| **Hall-Effect Sensor** | **Analog Pin A0** (e.g. Linear 49E) | Measures local magnetic field deviation ($\Delta B$) |
| **16×2 I2C LCD** | **I2C SDA / SCL** (Address `0x27` / `0x3F`) | Physical real-time alert text display |
| **Alert RGB LED** | **Pins D9 (R), D10 (G), D11 (B)** | Threat level status illumination |
| **Piezo Buzzer** | **Digital Pin D8** (PWM) | Acoustic warning & pulse tone |
| **Replay Button** | **Digital Pin D2** (`INPUT_PULLUP`) | Physical trigger to start/stop 60s storm simulation |
| **USB Serial** | **USB-C Port @ 115,200 Baud** | Real-time machine-readable telemetry link |

---

## 🚀 Quick Start Guide

### Step 1: Plug in Arduino
Connect the Arduino UNO R4 WiFi to your laptop via USB-C.

### Step 2: Run the Python Bridge
Open your terminal in this directory and run:

```bash
python bridge.py
```

*The bridge will auto-detect your Arduino COM port and start a local HTTP/SSE server at `http://localhost:8080`.*

If you want to specify a particular COM port:
```bash
python bridge.py --port 8080 --serial COM3
```

### Step 3: Open Dashboard
Open your web browser to:
```
http://localhost:8080
```

> **Offline Demo Mode:** If the Arduino is not plugged in, the dashboard automatically operates in **Standalone Simulation Mode**. Click **"⚡ Replay Storm (60s)"** to run the complete 5-stage storm presentation scenario!

---

## 📡 Serial Telemetry Protocol

The Python bridge is designed to seamlessly parse both human-readable diagnostic logs and machine-readable data.

### Preferred Output Line (Call at ~5–10 Hz):
```text
MAG:kp,bz,solar_speed,hall_raw,hall_delta,risk_level,lcd_line1|lcd_line2
```

#### Example Line:
```text
MAG:7.8,-16.4,740,544,32,SEVERE,ALERT: SEVERE G4|Kp:7.8 Bz:-16nT
```

### JSON Format (Also Fully Supported):
```json
{"kp": 7.8, "bz": -16.4, "speed": 740, "hall": 544, "delta": 32, "risk": "SEVERE", "lcd1": "ALERT: SEVERE G4", "lcd2": "Kp:7.8 Bz:-16nT"}
```

### Existing Diagnostic Logs:
Any other text printed by your sketch (e.g., `WiFi connected`, `Calibrating baseline...`) is preserved and routed to the dashboard's built-in **Live Serial Monitor drawer** (`⌨ Serial Monitor Stream`), allowing judges to inspect raw hardware debugging without interrupting telemetry parsing!

---

## 📁 Project Structure

```
magnetar/
├── bridge.py                         # Lightweight local Python bridge & SSE server (pyserial)
├── arduino_telemetry_snippet.ino     # Quick 10-line drop-in function for your existing sketch
├── arduino_full_reference_sketch.ino # Complete reference sketch with all pins & replay engine
├── README.md                         # This file
└── public/
    ├── index.html                    # Dashboard layout matching project wireframe
    ├── style.css                     # Custom scientific observatory theme & palette
    └── app.js                        # SSE client, Canvas charts, audio chimes & replay logic
```

---

## 🏆 Hackathon Presentation Checklist

1. **Hardware on the bench:** Place the Arduino UNO R4, Hall sensor, RGB LED, and LCD next to the laptop running the dashboard.
2. **Bring a magnet near the Hall sensor:** Show that the **Local Field Deviation $\Delta B$** meter on screen moves in sync with the physical sensor!
3. **Trigger the Storm Replay:** Either press physical button **D2** on the Arduino OR click **"Replay Storm (60s)"** on the website.
4. **Watch the synchronized escalation:**
   - **0s - 12s (Quiet):** Green LED, silent buzzer, Kp 1.8, Northward $B_z$ deflecting solar plasma.
   - **12s - 24s (Watch):** Amber LED, Kp jumps to 4.2, CME shock front arrives at 520 km/s.
   - **24s - 42s (Severe G4):** Red LED flashes, buzzer alarms, $B_z$ plunges to $-18\text{ nT}$, Hall probe registers ground perturbations, LCD displays `ALERT: SEVERE G4`.
   - **42s - 60s (Recovery):** Field stabilizes and returns to nominal quiet conditions.
5. **Demonstrate Offline Resiliency:** Point out to judges that the system communicates directly over **USB Serial (115200 baud)** with zero internet or cloud dependencies needed.
