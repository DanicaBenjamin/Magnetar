/*
  MAGNETAR - Geomagnetic Storm Early Warning Node  (Arduino UNO R4 WiFi)

  PREDICT : NOAA SWPC solar wind speed, Bz and Kp -> cloud risk level
  CONFIRM : Hall sensor deviation from baseline   -> local risk level
  ACT     : RGB LED, buzzer, I2C LCD (+ optional relay)

  Button = replay demo of a scripted storm. Move a magnet by hand near the
  Hall sensor to create the local disturbance.

  Libraries (Library Manager): ArduinoJson (v7), LiquidCrystal_I2C
  WiFiS3 ships with the "Arduino UNO R4 Boards" core.
  Board: Arduino UNO R4 WiFi
*/

#include <WiFiS3.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ================= USER CONFIG =================
const char* WIFI_SSID = "Cal Hacks 13.0";
const char* WIFI_PASS = "hackers!";
const uint8_t LCD_ADDR = 0x27;      // try 0x3F if the LCD stays blank
const bool USE_WIFI = true;         // false = skip Wi-Fi entirely (replay demo only)

// ================= PINS =================
// From your table
const int PIN_LED_R  = 2;           // RGB, common cathode
const int PIN_LED_G  = 3;
const int PIN_LED_B  = 4;
const int PIN_BUZZER = 8;           // active buzzer, HIGH = on
const int PIN_HALL_A = A0;          // Hall analog out
const int PIN_HALL_D = 7;           // Hall digital out (serial display only)
// NOT in your table: chosen for the button and relay
const int PIN_BUTTON = 10;          // button to GND, starts/stops replay demo
const int PIN_RELAY  = 11;          // optional relay IN
const bool RELAY_ACTIVE_LOW = true;

// ================= TUNING =================
const int HALL_THRESH[3] = {40, 120, 300};   // 12-bit counts: watch / warning / severe
const unsigned long FETCH_INTERVAL_MS = 60000;
const unsigned long REPLAY_FRAME_MS   = 7000;

// ================= NOAA (no API key) =================
const char* HOST = "services.swpc.noaa.gov";
const char* PATH_KP    = "/products/noaa-planetary-k-index.json";
const char* PATH_SPEED = "/products/summary/solar-wind-speed.json";
const char* PATH_MAG   = "/products/summary/solar-wind-mag-field.json";

// ================= REPLAY SCENARIO =================
// Illustrative values shaped like a big storm. Not exact recorded data.
struct Frame { float kp; float speed; float bz; };
const Frame REPLAY[] = {
  {2, 400,   2}, {3, 450,  -3}, {4, 560,  -9}, {5, 680, -18},
  {7, 850, -35}, {9, 950, -45}, {6, 700, -15}, {3, 480,  -4}
};
const int REPLAY_N = sizeof(REPLAY) / sizeof(REPLAY[0]);

// Shown when there is no live data (offline, or a fetch failed).
// Illustrative values shaped like a moderate past storm. Marked "S" on the LCD.
const Frame STORED = {4, 560, -9};

// ================= STATE =================
LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);

float kp = 0, windSpeed = 0, bz = 0;
bool dataOk = false;
bool useWifi = false;               // set in setup() once Wi-Fi actually connects

bool demoActive = false;
int demoFrame = 0;
unsigned long demoFrameStart = 0;

float hallSmooth = 0, hallBase = 0;
int hallDev = 0;
int cloudLevel = 0, localLevel = 0, finalLevel = 0;
bool fetching = false;

unsigned long lastFetch = 0, lastDisplay = 0, lastHall = 0;
const char* SPACE_WORD[4] = {"calm", "active", "STORM!", "SEVERE"};
const char* LOCAL_WORD[4] = {"quiet", "change", "FIELD!", "STRONG"};

void useStored() {
  kp = STORED.kp;
  windSpeed = STORED.speed;
  bz = STORED.bz;
}

// ================= NOAA FETCH =================
// Value may arrive as a number or a quoted string.
float toF(JsonVariantConst v) {
  if (v.is<const char*>()) return atof(v.as<const char*>());
  return v.as<float>();
}

// HTTP/1.0 request avoids chunked transfer encoding, so the body is plain JSON.
bool httpGetJson(const char* path, JsonDocument& doc) {
  WiFiSSLClient client;
  client.setTimeout(8000);
  if (!client.connect(HOST, 443)) {
    Serial.print("connect failed: "); Serial.println(path);
    return false;
  }
  client.print("GET "); client.print(path); client.println(" HTTP/1.0");
  client.print("Host: "); client.println(HOST);
  client.println("User-Agent: storm-warning-node");
  client.println("Connection: close");
  client.println();

  if (!client.find("\r\n\r\n")) { client.stop(); return false; }   // skip headers
  DeserializationError err = deserializeJson(doc, client);
  client.stop();
  if (err) { Serial.print("JSON error: "); Serial.println(err.c_str()); return false; }
  return true;
}

bool fetchKp(float& out) {
  JsonDocument doc;
  if (!httpGetJson(PATH_KP, doc)) return false;
  JsonArray arr = doc.as<JsonArray>();
  if (arr.isNull() || arr.size() < 2) return false;
  JsonVariant last = arr[arr.size() - 1];
  if (last.is<JsonArray>()) out = toF(last[1]);       // array-of-arrays format
  else                      out = toF(last["Kp"]);    // array-of-objects format
  return true;
}

bool fetchKey(const char* path, const char* k1, const char* k2, float& out) {
  JsonDocument doc;
  if (!httpGetJson(path, doc)) return false;
  JsonVariant v = doc[k1];
  if (v.isNull()) v = doc[k2];
  if (v.isNull()) { Serial.print("key not found in "); Serial.println(path); return false; }
  out = toF(v);
  return true;
}

void fetchLive() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    dataOk = false;
    useStored();
    return;
  }
  fetching = true;
  float k, s, b;
  bool okK = fetchKp(k);
  bool okS = fetchKey(PATH_SPEED, "WindSpeed", "speed", s);
  bool okB = fetchKey(PATH_MAG, "Bz", "bz_gsm", b);
  fetching = false;
  if (okK) kp = k;
  if (okS) windSpeed = s;
  if (okB) bz = b;
  dataOk = okK && okS && okB;
  if (!dataOk) useStored();     // never show a half-live, half-stale mix
}

// ================= RISK LOGIC =================
int classifyCloud(float k, float speed, float b) {
  if (k >= 7 || (speed > 600 && b < -15)) return 3;
  if (k >= 5 || (speed > 500 && b < -10)) return 2;
  if (k >= 4 || b < -5 || speed > 450)    return 1;
  return 0;
}

int classifyLocal(int dev) {
  if (dev >= HALL_THRESH[2]) return 3;
  if (dev >= HALL_THRESH[1]) return 2;
  if (dev >= HALL_THRESH[0]) return 1;
  return 0;
}

int readHallRaw() {
  long s = 0;
  for (int i = 0; i < 16; i++) s += analogRead(PIN_HALL_A);
  return s / 16;
}

void calibrateBaseline() {
  delay(400);                    // keep the magnet away while this runs
  long s = 0;
  for (int i = 0; i < 200; i++) { s += analogRead(PIN_HALL_A); delay(2); }
  hallBase = s / 200.0;
  hallSmooth = hallBase;
}

// ================= OUTPUTS =================
void setRelay(bool on) {
  digitalWrite(PIN_RELAY, RELAY_ACTIVE_LOW ? !on : on);
}

// D2 and D4 are not PWM pins, so colours are on/off only.
void updateOutputs() {
  unsigned long now = millis();
  bool r = false, g = false, b = false, buz = false;
  switch (finalLevel) {
    case 0: g = true; break;                                  // green
    case 1: r = true; g = true; break;                        // yellow
    case 2: r = ((now / 600) % 2) == 0; buz = (now % 2000) < 150; break;
    default: r = ((now / 150) % 2) == 0; buz = r; break;
  }
  if (fetching) b = true;                                     // blue while talking to NOAA
  digitalWrite(PIN_LED_R, r);
  digitalWrite(PIN_LED_G, g);
  digitalWrite(PIN_LED_B, b);
  digitalWrite(PIN_BUZZER, buz);
  setRelay(finalLevel >= 3);
}

void updateDisplay() {
  // Row 1: what space weather is doing. Row 2: what the local sensor feels.
  // Last character: R = replay demo, L = live NOAA data, S = stored past data.
  // The screen flips every 3 s: page 1 = plain words, page 2 = the numbers.
  char src = demoActive ? 'R' : (dataOk ? 'L' : 'S');
  char t0[20], t1[20], l0[17], l1[17];
  if ((millis() / 3000) % 2 == 0) {
    snprintf(t0, sizeof(t0), "Space: %s", SPACE_WORD[cloudLevel]);
    snprintf(t1, sizeof(t1), "Local: %s", LOCAL_WORD[localLevel]);
  } else {
    snprintf(t0, sizeof(t0), "Kp:%.1f Wind:%d", kp, min((int)windSpeed, 999));
    snprintf(t1, sizeof(t1), "Bz:%d Hall:%d", (int)bz, min(hallDev, 9999));
  }
  snprintf(l0, sizeof(l0), "%-15s%c", t0, src);
  snprintf(l1, sizeof(l1), "%-16s", t1);
  lcd.setCursor(0, 0); lcd.print(l0);
  lcd.setCursor(0, 1); lcd.print(l1);
}

// ================= DEMO CONTROL =================
void loadFrame(int i) {
  kp = REPLAY[i].kp;
  windSpeed = REPLAY[i].speed;
  bz = REPLAY[i].bz;
  demoFrameStart = millis();
}

void toggleDemo() {
  if (!demoActive) {
    calibrateBaseline();         // keep the magnet away for ~1 second
    demoActive = true;
    demoFrame = 0;
    loadFrame(0);
  } else {
    demoActive = false;
    lastFetch = 0;
    if (!dataOk) useStored();
  }
}

void checkButton() {
  static bool lastBtn = HIGH;
  static unsigned long lastChange = 0;
  bool b = digitalRead(PIN_BUTTON);
  if (b != lastBtn && millis() - lastChange > 50) {
    lastChange = millis();
    lastBtn = b;
    if (b == LOW) toggleDemo();
  }
}

// ================= SPLASH SCREEN =================
// The LCD can't show Unicode, so the moon and stars are custom 5x8 characters.
const uint8_t CH_MOON = 0, CH_STAR = 1, CH_SPARK = 2;
byte moonGlyph[8]  = {0b00110, 0b01100, 0b11000, 0b11000, 0b11000, 0b11000, 0b01100, 0b00110};
byte starGlyph[8]  = {0b00100, 0b10101, 0b01110, 0b11111, 0b01110, 0b10101, 0b00100, 0b00000};
byte sparkGlyph[8] = {0b00000, 0b00000, 0b00100, 0b01110, 0b00100, 0b00000, 0b00000, 0b00000};

void splash() {
  lcd.createChar(CH_MOON, moonGlyph);
  lcd.createChar(CH_STAR, starGlyph);
  lcd.createChar(CH_SPARK, sparkGlyph);
  lcd.clear();
  lcd.setCursor(3, 0);
  lcd.write(CH_MOON);
  lcd.print(" Magnetar");
  lcd.setCursor(14, 0);
  lcd.write(CH_STAR);
  for (int f = 0; f < 8; f++) {            // twinkling row, about 2.4 s
    lcd.setCursor(0, 1);
    for (int i = 0; i < 16; i++) {
      if ((i * 5 + f * 3) % 7 == 0)      lcd.write(CH_STAR);
      else if ((i * 3 + f) % 5 == 0)     lcd.write(CH_SPARK);
      else                               lcd.print(' ');
    }
    delay(300);
  }
}

// ================= SETUP / LOOP =================
void setup() {
  Serial.begin(115200);

  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_HALL_D, INPUT);
  pinMode(PIN_RELAY, OUTPUT);
  setRelay(false);
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  analogReadResolution(12);

  useStored();                  // start with stored past data, replaced if live data arrives
  Wire.begin();
  lcd.init();
  lcd.backlight();
  splash();
  if (USE_WIFI) {
    lcd.setCursor(0, 1); lcd.print("Wi-Fi...        ");
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 10000) delay(250);
    useWifi = (WiFi.status() == WL_CONNECTED);
  }
  lcd.setCursor(0, 1);
  lcd.print(useWifi ? "Wi-Fi OK        " : "Offline: use btn");
  delay(1200);
  calibrateBaseline();
  Serial.print("Hall baseline: "); Serial.println(hallBase);
  lastFetch = 0;
}

void loop() {
  checkButton();

  if (millis() - lastHall >= 20) {
    lastHall = millis();
    hallSmooth = 0.7f * hallSmooth + 0.3f * readHallRaw();
    hallDev = (int)fabsf(hallSmooth - hallBase);
  }

  if (demoActive) {
    if (millis() - demoFrameStart >= REPLAY_FRAME_MS) {
      demoFrame++;
      if (demoFrame >= REPLAY_N) { demoActive = false; lastFetch = 0; if (!dataOk) useStored(); }
      else loadFrame(demoFrame);
    }
  } else if (useWifi && (lastFetch == 0 || millis() - lastFetch >= FETCH_INTERVAL_MS)) {
    lastFetch = millis();
    updateOutputs();            // show blue before the blocking fetch
    fetchLive();
  }

  cloudLevel = classifyCloud(kp, windSpeed, bz);
  localLevel = classifyLocal(hallDev);
  finalLevel = max(cloudLevel, localLevel);

  updateOutputs();

  if (millis() - lastDisplay >= 250) {
    lastDisplay = millis();
    updateDisplay();
    Serial.print("L"); Serial.print(finalLevel);
    Serial.print(" cloud="); Serial.print(cloudLevel);
    Serial.print(" local="); Serial.print(localLevel);
    Serial.print(" dev="); Serial.print(hallDev);
    Serial.print(" DO="); Serial.print(digitalRead(PIN_HALL_D));
    Serial.print(" kp="); Serial.print(kp, 1);
    Serial.print(" v="); Serial.print(windSpeed, 0);
    Serial.print(" bz="); Serial.println(bz, 1);
  }
}
