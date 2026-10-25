/* ==============================================================================
   MAGNETAR — Arduino UNO R4 Serial Telemetry Drop-In Snippet
   ==============================================================================
   Add this single helper function and call it inside your existing loop().
   It emits a machine-readable telemetry line at 115200 baud that the MAGNETAR
   Python bridge automatically reads and displays on the dashboard.
   
   Format:
   MAG:kp,bz,solar_speed,hall_raw,hall_delta,risk_level,lcd_line1|lcd_line2
   ============================================================================== */

// Call this function once every 100ms - 250ms in your loop()
void sendDashboardTelemetry(float kp, float bz, float solarSpeed, 
                            int hallRaw, int hallDelta, 
                            const char* riskLevel, 
                            const char* lcdLine1, const char* lcdLine2) {
  // Machine-readable prefix 'MAG:'
  Serial.print("MAG:");
  Serial.print(kp, 1);
  Serial.print(",");
  Serial.print(bz, 1);
  Serial.print(",");
  Serial.print(solarSpeed, 0);
  Serial.print(",");
  Serial.print(hallRaw);
  Serial.print(",");
  Serial.print(hallDelta);
  Serial.print(",");
  Serial.print(riskLevel);
  Serial.print(",");
  Serial.print(lcdLine1);
  Serial.print("|");
  Serial.println(lcdLine2);
}

/* ==============================================================================
   OPTIONAL: Check for commands from the Python Bridge
   (e.g., when the user clicks 'Replay' or 'Zero Baseline' on the web dashboard)
   ============================================================================== */
void handleBridgeCommands() {
  if (Serial.available() > 0) {
    char cmd = Serial.read();
    if (cmd == 'R' || cmd == 'r') {
      // Trigger your scripted storm replay function
      Serial.println("[ARDUINO] Command received: START REPLAY");
      // startStormReplay();
    } else if (cmd == 'C' || cmd == 'c') {
      // Recalibrate local Hall baseline
      Serial.println("[ARDUINO] Command received: CALIBRATE BASELINE");
      // calibrateHallSensor();
    }
  }
}
