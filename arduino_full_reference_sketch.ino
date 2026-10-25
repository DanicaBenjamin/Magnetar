/* ==============================================================================
   MAGNETAR — Arduino UNO R4 WiFi Complete Reference Sketch
   ==============================================================================
   Physical Hardware Map:
     - Board:          Arduino UNO R4 WiFi
     - Hall Sensor:    Analog Pin A0 (Linear 49E or similar)
     - I2C LCD:        16x2 LCD via I2C (Address 0x27 or 0x3F) on SDA/SCL
     - Alert RGB LED:  Red = Pin 9, Green = Pin 10, Blue = Pin 11 (PWM)
     - Alert Buzzer:   Pin 8 (PWM tone output)
     - Replay Button:  Pin 2 (INPUT_PULLUP, triggers scripted storm replay)
     - USB Serial:     115200 Baud machine-readable telemetry stream
   ============================================================================== */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// --- PIN ASSIGNMENTS ---
const int PIN_HALL_SENSOR   = A0;
const int PIN_REPLAY_BUTTON = 2;
const int PIN_BUZZER        = 8;
const int PIN_RGB_RED       = 9;
const int PIN_RGB_GREEN     = 10;
const int PIN_RGB_BLUE      = 11;

// --- HARDWARE PERIPHERALS ---
// Adjust I2C address if your display uses 0x3F instead of 0x27
LiquidCrystal_I2C lcd(0x27, 16, 2);

// --- CALIBRATION & TELEMETRY VARIABLES ---
int hallBaseline = 512;
int hallRaw = 512;
int hallDelta = 0;

// Space weather variables (fallbacks when offline)
float kpIndex = 1.8;
float imfBz = 3.6;          // in nT (positive = Northward, negative = Southward)
float solarWindSpeed = 390; // in km/s

// Risk Level enum
enum ThreatLevel { QUIET, WATCH, WARNING, SEVERE };
ThreatLevel currentThreat = QUIET;
const char* threatStrings[] = { "QUIET", "WATCH", "WARNING", "SEVERE" };

// Scripted Storm Replay state
bool replayActive = false;
unsigned long replayStartTime = 0;
const unsigned long REPLAY_DURATION_MS = 60000; // 60 seconds

// Timing
unsigned long lastTelemetrySend = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 150; // ~6.6 Hz serial updates

// LCD buffer
char lcdLine1[17] = "MAGNETAR: QUIET";
char lcdLine2[17] = "Kp:1.8 Bz:+3.6nT";

void setup() {
  // Initialize Serial at 115200 baud
  Serial.begin(115200);
  delay(100);

  Serial.println("==================================================");
  Serial.println("[MAGNETAR] System Initializing...");
  Serial.println("[MAGNETAR] Controller: Arduino UNO R4 WiFi");

  // Setup Pins
  pinMode(PIN_HALL_SENSOR, INPUT);
  pinMode(PIN_REPLAY_BUTTON, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_RGB_RED, OUTPUT);
  pinMode(PIN_RGB_GREEN, OUTPUT);
  pinMode(PIN_RGB_BLUE, OUTPUT);

  // Initialize LCD
  Wire.begin();
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("MAGNETAR GEO-01");
  lcd.setCursor(0, 1);
  lcd.print("CALIBRATING...");

  // Calibrate Hall Sensor Baseline (average of 32 readings)
  long sum = 0;
  for (int i = 0; i < 32; i++) {
    sum += analogRead(PIN_HALL_SENSOR);
    delay(10);
  }
  hallBaseline = sum / 32;

  Serial.print("[MAGNETAR] Hall Sensor Baseline Calibrated: ");
  Serial.println(hallBaseline);
  Serial.println("[MAGNETAR] Ready. Streaming serial telemetry...");
  Serial.println("==================================================");

  setRgbColor(0, 255, 0); // Green for quiet
  tone(PIN_BUZZER, 1000, 100);
}

void loop() {
  unsigned long now = millis();

  // 1. Check physical button press (Pin 2 with INPUT_PULLUP, LOW when pressed)
  if (digitalRead(PIN_REPLAY_BUTTON) == LOW) {
    delay(50); // debounce
    if (digitalRead(PIN_REPLAY_BUTTON) == LOW) {
      if (!replayActive) {
        startStormReplay();
      } else {
        stopStormReplay();
      }
      while (digitalRead(PIN_REPLAY_BUTTON) == LOW); // wait for release
    }
  }

  // 2. Read incoming commands from Python bridge (e.g. 'R' = Replay, 'C' = Calibrate)
  if (Serial.available() > 0) {
    char cmd = Serial.read();
    if (cmd == 'R' || cmd == 'r') {
      startStormReplay();
    } else if (cmd == 'C' || cmd == 'c') {
      calibrateBaseline();
    } else if (cmd == 'S' || cmd == 's') {
      stopStormReplay();
    }
  }

  // 3. Read Hall sensor
  hallRaw = analogRead(PIN_HALL_SENSOR);
  hallDelta = hallRaw - hallBaseline;

  // 4. If Scripted Storm Replay is active, compute scripted progression
  if (replayActive) {
    unsigned long elapsed = now - replayStartTime;
    if (elapsed >= REPLAY_DURATION_MS) {
      stopStormReplay();
    } else {
      updateReplaySimulation(elapsed);
    }
  } else {
    // Normal live / offline operation
    classifyThreat();
  }

  // 5. Update physical outputs (RGB LED, Buzzer, 16x2 LCD)
  updatePhysicalAlerts();

  // 6. Send Machine-Readable Telemetry over Serial to Python Bridge
  if (now - lastTelemetrySend >= TELEMETRY_INTERVAL_MS) {
    lastTelemetrySend = now;
    sendSerialTelemetry();
  }
}

// --- THREAT CLASSIFICATION LOGIC ---
void classifyThreat() {
  int absDelta = abs(hallDelta);
  if (kpIndex >= 7.0 || imfBz <= -15.0 || absDelta >= 28) {
    currentThreat = SEVERE;
    snprintf(lcdLine1, sizeof(lcdLine1), "ALERT: SEVERE G4");
    snprintf(lcdLine2, sizeof(lcdLine2), "Bz:%.0fnT V:%.0fk", imfBz, solarWindSpeed);
  } else if (kpIndex >= 5.0 || imfBz <= -8.0 || absDelta >= 16) {
    currentThreat = WARNING;
    snprintf(lcdLine1, sizeof(lcdLine1), "MAGNETAR: WARN  ");
    snprintf(lcdLine2, sizeof(lcdLine2), "Kp:%.1f Bz:%.0fnT", kpIndex, imfBz);
  } else if (kpIndex >= 3.5 || imfBz <= -3.0 || absDelta >= 8) {
    currentThreat = WATCH;
    snprintf(lcdLine1, sizeof(lcdLine1), "MAGNETAR: WATCH ");
    snprintf(lcdLine2, sizeof(lcdLine2), "CME ARRIVING... ");
  } else {
    currentThreat = QUIET;
    snprintf(lcdLine1, sizeof(lcdLine1), "MAGNETAR: QUIET ");
    snprintf(lcdLine2, sizeof(lcdLine2), "Kp:%.1f Bz:+%.1fnT", kpIndex, imfBz);
  }
}

// --- PHYSICAL ALERTS (LED, BUZZER, LCD) ---
void updatePhysicalAlerts() {
  static unsigned long lastLcdUpdate = 0;
  static unsigned long lastBuzzerToggle = 0;
  static bool buzzerState = false;
  unsigned long now = millis();

  switch (currentThreat) {
    case QUIET:
      setRgbColor(0, 255, 0); // Green
      noTone(PIN_BUZZER);
      break;

    case WATCH:
      setRgbColor(255, 200, 0); // Amber Yellow
      noTone(PIN_BUZZER);
      break;

    case WARNING:
      setRgbColor(255, 80, 0); // Orange
      // Intermittent chirp every 1.5 seconds
      if (now - lastBuzzerToggle >= 1500) {
        lastBuzzerToggle = now;
        tone(PIN_BUZZER, 1200, 120);
      }
      break;

    case SEVERE:
      // Flashing Red LED & Urgent Alarm Tone
      if (now - lastBuzzerToggle >= 250) {
        lastBuzzerToggle = now;
        buzzerState = !buzzerState;
        if (buzzerState) {
          setRgbColor(255, 0, 0); // Red
          tone(PIN_BUZZER, 2000, 180);
        } else {
          setRgbColor(40, 0, 0);  // Dim
        }
      }
      break;
  }

  // Update LCD at ~4 Hz to prevent I2C bus flicker
  if (now - lastLcdUpdate >= 250) {
    lastLcdUpdate = now;
    lcd.setCursor(0, 0);
    lcd.print(lcdLine1);
    lcd.setCursor(0, 1);
    lcd.print(lcdLine2);
  }
}

// --- REPLAY SCRIPT ENGINE ---
void startStormReplay() {
  replayActive = true;
  replayStartTime = millis();
  Serial.println("[ARDUINO] >>> SCRIPTED STORM REPLAY STARTED (60 SECONDS)");
}

void stopStormReplay() {
  replayActive = false;
  kpIndex = 1.8;
  imfBz = 3.6;
  solarWindSpeed = 390;
  Serial.println("[ARDUINO] <<< SCRIPTED STORM REPLAY FINISHED");
}

void updateReplaySimulation(unsigned long elapsedMs) {
  float progress = (float)elapsedMs / (float)REPLAY_DURATION_MS;

  if (progress < 0.20) {
    // Stage 1: Quiet Sun
    kpIndex = 1.8 + progress * 2.0;
    imfBz = 3.5 - progress * 15.0;
    solarWindSpeed = 380 + progress * 200;
  } else if (progress < 0.40) {
    // Stage 2: Sudden Commencement / CME Shock
    float p = (progress - 0.20) / 0.20;
    kpIndex = 3.2 + p * 2.5;
    imfBz = -2.0 - p * 8.0;
    solarWindSpeed = 460 + p * 180;
  } else if (progress < 0.70) {
    // Stage 3: Severe Main Phase Peak
    float p = (progress - 0.40) / 0.30;
    kpIndex = 7.5 + sin(p * 3.1415) * 1.3;
    imfBz = -15.0 - sin(p * 3.1415) * 8.0;
    solarWindSpeed = 720 + sin(p * 3.1415) * 160;
  } else {
    // Stage 4: Recovery Phase
    float p = (progress - 0.70) / 0.30;
    kpIndex = 8.5 - p * 6.5;
    imfBz = -22.0 + p * 25.0;
    solarWindSpeed = 850 - p * 450;
  }

  classifyThreat();
}

void calibrateBaseline() {
  hallBaseline = hallRaw;
  Serial.print("[ARDUINO] Baseline zeroed to: ");
  Serial.println(hallBaseline);
}

void setRgbColor(int r, int g, int b) {
  analogWrite(PIN_RGB_RED, r);
  analogWrite(PIN_RGB_GREEN, g);
  analogWrite(PIN_RGB_BLUE, b);
}

// --- MACHINE-READABLE SERIAL OUTPUT ---
void sendSerialTelemetry() {
  // Format: MAG:kp,bz,speed,hall,delta,risk,lcdLine1|lcdLine2
  Serial.print("MAG:");
  Serial.print(kpIndex, 1);
  Serial.print(",");
  Serial.print(imfBz, 1);
  Serial.print(",");
  Serial.print(solarWindSpeed, 0);
  Serial.print(",");
  Serial.print(hallRaw);
  Serial.print(",");
  Serial.print(hallDelta);
  Serial.print(",");
  Serial.print(threatStrings[currentThreat]);
  Serial.print(",");
  Serial.print(lcdLine1);
  Serial.print("|");
  Serial.println(lcdLine2);
}
