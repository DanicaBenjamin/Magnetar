/**
 * MAGNETAR Ã¢â‚¬â€ Scientific Dashboard Controller
 * Handles SSE live telemetry stream, offline fallback simulation,
 * dual-trace oscilloscope canvas rendering, audio alert chimes,
 * and serial hardware controls.
 */

(function () {
  'use strict';

  // Support opening via http://localhost:8080 OR file:///...
  const API_BASE = (window.location.protocol === 'file:' || window.location.port !== '8080')
    ? 'http://localhost:8080'
    : '';

  // --- STATE ---
  const state = {
    connected: false,
    serialPort: 'COM7',
    baudRate: 115200,
    packetCount: 0,
    mode: 'STANDBY',
    source: 'STORED_OFFLINE',
    kp: 4.0,
    bz: -9.0,
    solarSpeed: 560,
    hallRaw: 2048,
    hallBaseline: 2048,
    hallDelta: 0,
    hallDo: 1,
    relayTriggered: false,
    cloudLevel: 1,
    localLevel: 0,
    finalLevel: 1,
    riskLevel: 'WATCH',
    spaceWord: 'active',
    localWord: 'quiet',
    lcdLine1: 'Space: active  S',
    lcdLine2: 'Local: quiet    ',
    rgbColor: '#fed857',
    buzzer: 'OFF',
    audioMuted: true,
    replayActive: false,
    history: {
      timestamps: [],
      bz: [],
      speed: [],
      hallDelta: [],
      maxPoints: 600
    }
  };

  // Peak tracking for the session
  const stats = {
    minBz: 4.2,
    maxSpeed: 385,
    maxDelta: 0,
    maxKp: 1.6
  };

  // Web Audio Context for physical buzzer audio mirroring
  let audioCtx = null;
  let buzzerOsc = null;
  let buzzerGain = null;

  function initAudio() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function playAlertBeep(level) {
    if (state.audioMuted || !audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (level === 'WATCH') {
        osc.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.16);
      } else if (level === 'WARNING') {
        osc.frequency.setValueAtTime(1200, now);
        osc.frequency.setValueAtTime(900, now + 0.1);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.26);
      } else if (level === 'SEVERE') {
        osc.frequency.setValueAtTime(1800, now);
        osc.frequency.setValueAtTime(2200, now + 0.08);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.21);
      }
    } catch (e) {
      console.warn('Audio beep error', e);
    }
  }

  // --- DOM REFERENCES ---
  const el = {
    // Sidebar
    portInput: document.getElementById('portInput'),
    portList: document.getElementById('portList'),
    portSelect: document.getElementById('portSelect'),
    btnRefreshPorts: document.getElementById('btnRefreshPorts'),
    btnConnect: document.getElementById('btnConnect'),
    connStatusPill: document.getElementById('connStatusPill'),
    connStatusText: document.getElementById('connStatusText'),
    statPort: document.getElementById('statPort'),
    statPackets: document.getElementById('statPackets'),
    statMode: document.getElementById('statMode'),
    statHallDo: document.getElementById('statHallDo'),
    statRelay: document.getElementById('statRelay'),
    audioToggle: document.getElementById('audioToggle'),
    btnConsoleToggle: document.getElementById('btnConsoleToggle'),
    btnTriggerReplay: document.getElementById('btnTriggerReplay'),
    btnZeroBaseline: document.getElementById('btnZeroBaseline'),

    // Top Panel
    threatBadge: document.getElementById('threatBadge'),
    threatVal: document.getElementById('threatVal'),
    sourceBadge: document.getElementById('sourceBadge'),
    metricKp: document.getElementById('metricKp'),
    metricBz: document.getElementById('metricBz'),
    metricSpeed: document.getElementById('metricSpeed'),
    metricDelta: document.getElementById('metricDelta'),
    subtextBz: document.getElementById('subtextBz'),
    subtextSpeed: document.getElementById('subtextSpeed'),
    subtextKp: document.getElementById('subtextKp'),
    canvas: document.getElementById('telemetryChart'),

    // Middle Left (Arduino Hardware)
    badgeConfirmLevel: document.getElementById('badgeConfirmLevel'),
    badgePredictLevel: document.getElementById('badgePredictLevel'),
    statLocalWord: document.getElementById('statLocalWord'),
    lcdSrcChar: document.getElementById('lcdSrcChar'),
    hallRawVal: document.getElementById('hallRawVal'),
    hallBaselineVal: document.getElementById('hallBaselineVal'),
    hallDeltaVal: document.getElementById('hallDeltaVal'),
    deviationFill: document.getElementById('deviationFill'),
    lcdLine1: document.getElementById('lcdLine1'),
    lcdLine2: document.getElementById('lcdLine2'),
    hwLed: document.getElementById('hwLed'),
    hwLedText: document.getElementById('hwLedText'),
    hwBuzzerText: document.getElementById('hwBuzzerText'),
    hwRelayText: document.getElementById('hwRelayText'),

    // Middle Right (Space Weather)
    swKpVal: document.getElementById('swKpVal'),
    swKpGScale: document.getElementById('swKpGScale'),
    swKpBars: document.getElementById('swKpBars'),
    swBzVal: document.getElementById('swBzVal'),
    swBzPolarity: document.getElementById('swBzPolarity'),
    swSpeedVal: document.getElementById('swSpeedVal'),
    swSpeedStatus: document.getElementById('swSpeedStatus'),

    // Bottom Yellow Ribbon
    bottomEyebrow: document.getElementById('bottomEyebrow'),
    bottomMessage: document.getElementById('bottomMessage'),
    pillGrid: document.getElementById('pillGrid'),
    pillRadio: document.getElementById('pillRadio'),
    pillLead: document.getElementById('pillLead'),
    btnQuickReplay: document.getElementById('btnQuickReplay'),
    btnTestSpike: document.getElementById('btnTestSpike'),
    btnExportCsv: document.getElementById('btnExportCsv'),

    // Console Drawer
    consoleDrawer: document.getElementById('consoleDrawer'),
    consoleClose: document.getElementById('consoleClose'),
    consoleBody: document.getElementById('consoleBody'),
    consoleInput: document.getElementById('consoleInput')
  };

  // --- CHART RENDERING (Pure HTML5 Canvas, zero external libraries) ---
  const ctx = el.canvas ? el.canvas.getContext('2d') : null;

  function resizeCanvas() {
    if (!el.canvas) return;
    const rect = el.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (el.canvas.width !== width || el.canvas.height !== height) {
      el.canvas.width = width;
      el.canvas.height = height;
    }
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);
  setTimeout(resizeCanvas, 50);

  function drawChart() {
    if (!ctx || !el.canvas) return;
    const rect = el.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);

    // Draw background gridlines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    const gridCols = 8;
    const gridRows = 4;
    for (let i = 1; i < gridCols; i++) {
      const x = (w / gridCols) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let j = 1; j < gridRows; j++) {
      const y = (h / gridRows) * j;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const pts = state.history.bz.length;
    if (pts === 0) return;

    // Auto-scale helper: zooms into actual data range so every wiggle is visible
    function autoRange(arr, minPad) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < arr.length; i++) { lo = Math.min(lo, arr[i]); hi = Math.max(hi, arr[i]); }
      let spread = hi - lo;
      if (spread < minPad * 2) {
        const mid = (hi + lo) / 2;
        lo = mid - minPad;
        hi = mid + minPad;
      } else {
        lo -= spread * 0.15;
        hi += spread * 0.15;
      }
      return [lo, hi];
    }

    // Compute auto-scaled ranges for each trace
    const [bzLo, bzHi] = autoRange(state.history.bz, 3.0);
    const [spdLo, spdHi] = autoRange(state.history.speed, 5);
    const [delLo, delHi] = autoRange(state.history.hallDelta, 4);

    // Bz zero reference line (if 0 is within view)
    const bzZeroY = ((bzHi - 0) / (bzHi - bzLo)) * h;
    if (bzZeroY > 5 && bzZeroY < h - 5) {
      ctx.fillStyle = 'rgba(255, 59, 48, 0.04)';
      ctx.fillRect(0, bzZeroY, w, h - bzZeroY);
      ctx.strokeStyle = 'rgba(254, 216, 87, 0.3)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, bzZeroY);
      ctx.lineTo(w, bzZeroY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(254, 216, 87, 0.6)';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillText('0 nT', 6, bzZeroY - 4);
    }

    // Y-axis scale labels
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#ff5555';
    ctx.fillText('Bz ' + bzHi.toFixed(0), w - 4, 12);
    ctx.fillText(bzLo.toFixed(0) + ' nT', w - 4, h - 4);
    ctx.fillStyle = '#4eba86';
    ctx.fillText('\u0394 ' + delHi.toFixed(0), w - 60, 12);
    ctx.fillText(delLo.toFixed(0), w - 60, h - 4);
    ctx.globalAlpha = 1.0;
    ctx.textAlign = 'left';

    const noaaWindow = state.source.includes('NOAA');
    const windowMs = noaaWindow ? 60 * 60 * 1000 : 60000;
    const now = Date.now();

    // Generic trace drawer
    function drawTrace(arr, lo, hi, color, lw) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let i = 0; i < pts; i++) {
        const x = noaaWindow
          ? ((state.history.timestamps[i] - (now - windowMs)) / windowMs) * w
          : (i / Math.max(1, pts - 1)) * w;
        const v = Math.max(lo, Math.min(hi, arr[i]));
        const y = ((hi - v) / (hi - lo)) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (pts === 1) {
        const x = noaaWindow
          ? ((state.history.timestamps[0] - (now - windowMs)) / windowMs) * w
          : w;
        const v = Math.max(lo, Math.min(hi, arr[0]));
        const y = ((hi - v) / (hi - lo)) * h;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2, lw), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw all three traces
    drawTrace(state.history.bz, bzLo, bzHi, '#ff5555', 2);        // Bz (red)
    drawTrace(state.history.speed, spdLo, spdHi, '#fed857', 1.5);  // Wind (yellow)
    drawTrace(state.history.hallDelta, delLo, delHi, '#4eba86', 2.5); // Hall ÃŽâ€B (green, thickest)
  }


  // --- UI UPDATE ROUTINES ---
  function updateUI() {
    // 1. Status & Threat Level
    const threatClass = `level-${state.riskLevel.toLowerCase()}`;
    el.threatBadge.className = `threat-level-badge ${threatClass}`;
    el.threatVal.textContent = state.riskLevel;

    // Source Badge
    el.sourceBadge.textContent = state.source.replace(/_/g, ' ');
    el.sourceBadge.className = `source-badge ${state.connected || state.source.includes('NOAA') ? 'live' : state.replayActive ? 'replay' : ''}`;

    // 2. Top Metrics
    el.metricKp.textContent = Number(state.kp).toFixed(1);
    el.metricBz.textContent = (state.bz > 0 ? '+' : '') + Number(state.bz).toFixed(1);
    el.metricSpeed.textContent = Math.round(state.solarSpeed);
    el.metricDelta.textContent = (state.hallDelta > 0 ? '+' : '') + state.hallDelta;

    // Subtexts
    if (state.bz < -10) {
      el.subtextBz.textContent = 'STRONG SOUTHWARD (CRITICAL)';
      el.subtextBz.style.color = '#ff5555';
    } else if (state.bz < 0) {
      el.subtextBz.textContent = 'Southward Reconnection';
      el.subtextBz.style.color = 'var(--status-watch)';
    } else {
      el.subtextBz.textContent = 'Northward (Shielded)';
      el.subtextBz.style.color = 'var(--status-quiet)';
    }

    if (state.solarSpeed > 700) {
      el.subtextSpeed.textContent = 'SHOCK FRONT (CME SPEED)';
      el.subtextSpeed.style.color = '#ff5555';
    } else if (state.solarSpeed > 500) {
      el.subtextSpeed.textContent = 'Elevated Wind Velocity';
      el.subtextSpeed.style.color = 'var(--status-watch)';
    } else {
      el.subtextSpeed.textContent = 'Nominal Solar Stream';
      el.subtextSpeed.style.color = 'var(--status-quiet)';
    }

    // 3. Arduino Local Hardware Mirror
    if (el.hallRawVal) el.hallRawVal.textContent = state.hallRaw;
    if (el.hallBaselineVal) el.hallBaselineVal.textContent = Math.round(state.hallBaseline);
    if (el.hallDeltaVal) el.hallDeltaVal.textContent = (state.hallDelta > 0 ? '+' : '') + state.hallDelta + ' counts';

    // Deviation bar (center-zero meter for 12-bit ADC, maxDev = 350, thresholds: 40/120/300)
    const maxDev = 350;
    const clampDelta = Math.max(-maxDev, Math.min(maxDev, state.hallDelta));
    if (clampDelta >= 0) {
      const wPercent = (clampDelta / maxDev) * 50;
      el.deviationFill.style.left = '50%';
      el.deviationFill.style.width = `${wPercent}%`;
      el.deviationFill.style.background = clampDelta >= 300 ? 'var(--status-severe)' : clampDelta >= 120 ? 'var(--status-warning)' : clampDelta >= 40 ? 'var(--status-watch)' : 'var(--status-quiet)';
    } else {
      const wPercent = (Math.abs(clampDelta) / maxDev) * 50;
      el.deviationFill.style.left = `${50 - wPercent}%`;
      el.deviationFill.style.width = `${wPercent}%`;
      el.deviationFill.style.background = clampDelta <= -300 ? 'var(--status-severe)' : clampDelta <= -120 ? 'var(--status-warning)' : clampDelta <= -40 ? 'var(--status-watch)' : 'var(--status-quiet)';
    }

    // Architecture badges (Predict vs Confirm)
    const levelColors = ['var(--status-quiet)', 'var(--status-watch)', 'var(--status-warning)', 'var(--status-severe)'];
    if (el.badgeConfirmLevel) {
      const c = levelColors[state.localLevel] || levelColors[0];
      el.badgeConfirmLevel.textContent = `CONFIRM: ${state.localWord.toUpperCase()} (${state.localLevel})`;
      el.badgeConfirmLevel.style.borderColor = c;
      el.badgeConfirmLevel.style.color = c;
    }
    if (el.badgePredictLevel) {
      const c = levelColors[state.cloudLevel] || levelColors[0];
      el.badgePredictLevel.textContent = `PREDICT: ${state.spaceWord.toUpperCase()} (${state.cloudLevel})`;
      el.badgePredictLevel.style.borderColor = c;
      el.badgePredictLevel.style.color = c;
    }
    if (el.statLocalWord) el.statLocalWord.textContent = `Word: ${state.localWord}`;
    if (el.statHallDo) el.statHallDo.textContent = state.hallDo === 0 ? 'DO: LOW (TRIP)' : 'DO: HIGH (NORM)';
    if (el.statRelay) el.statRelay.textContent = state.relayTriggered ? 'TRIPPED (SHUTDOWN)' : 'OPEN (STANDBY)';
    if (el.hwRelayText) {
      el.hwRelayText.textContent = state.relayTriggered ? 'TRIPPED' : 'OPEN';
      el.hwRelayText.style.color = state.relayTriggered ? 'var(--status-severe)' : 'var(--status-quiet)';
    }
    if (el.lcdSrcChar) {
      el.lcdSrcChar.textContent = state.source.includes('REPLAY') ? 'MODE: [R] REPLAY' : (state.source.includes('LIVE') ? 'MODE: [L] LIVE' : 'MODE: [S] STORED');
    }

    // 16x2 LCD Text
    el.lcdLine1.textContent = (state.lcdLine1 || '').padEnd(16, ' ').slice(0, 16);
    el.lcdLine2.textContent = (state.lcdLine2 || '').padEnd(16, ' ').slice(0, 16);

    // RGB LED Mirror
    el.hwLed.style.background = state.rgbColor;
    el.hwLed.style.boxShadow = `0 0 12px ${state.rgbColor}`;
    el.hwLedText.textContent = state.riskLevel;

    // Buzzer Text
    el.hwBuzzerText.textContent = state.buzzer;
    if (state.buzzer === 'ALARM') {
      el.hwBuzzerText.style.color = 'var(--status-severe)';
    } else if (state.buzzer === 'PULSE') {
      el.hwBuzzerText.style.color = 'var(--status-warning)';
    } else {
      el.hwBuzzerText.style.color = 'var(--text-secondary)';
    }

    // 4. Space Weather Deep Dive
    el.swKpVal.textContent = Number(state.kp).toFixed(1);
    let gScale = 'G0 (Quiet)';
    if (state.kp >= 9) gScale = 'G5 (Extreme Storm)';
    else if (state.kp >= 8) gScale = 'G4 (Severe Storm)';
    else if (state.kp >= 7) gScale = 'G3 (Strong Storm)';
    else if (state.kp >= 6) gScale = 'G2 (Moderate Storm)';
    else if (state.kp >= 5) gScale = 'G1 (Minor Storm)';
    else if (state.kp >= 4) gScale = 'Unsettled';
    el.swKpGScale.textContent = gScale;

    // Segmented Kp bars (9 segments)
    renderKpBars(state.kp);

    el.swBzVal.textContent = (state.bz > 0 ? '+' : '') + Number(state.bz).toFixed(1) + ' nT';
    el.swBzPolarity.textContent = state.bz < 0 ? 'SOUTHWARD (OPEN MAGNETOSPHERE)' : 'NORTHWARD (DEFLECTING)';
    el.swBzPolarity.style.color = state.bz < -10 ? '#ff5555' : state.bz < 0 ? 'var(--status-watch)' : 'var(--status-quiet)';

    el.swSpeedVal.textContent = Math.round(state.solarSpeed) + ' km/s';
    el.swSpeedStatus.textContent = state.solarSpeed > 700 ? 'High Speed Stream / CME' : state.solarSpeed > 500 ? 'Moderate Speed' : 'Quiet Stream';

    // 5. Sidebar Diagnostics
    el.statPort.textContent = state.serialPort || (state.connected ? 'Auto' : 'Disconnected');
    el.statPackets.textContent = state.packetCount.toLocaleString();
    el.statMode.textContent = state.replayActive ? 'REPLAY SCRIPT' : state.mode;

    if (state.connected) {
      if (el.connStatusPill) el.connStatusPill.innerHTML = '<span class="status-dot connected"></span> LIVE USB';
      if (el.connStatusText) el.connStatusText.textContent = `Online: ${state.serialPort || 'COM'}`;
      if (el.btnConnect) el.btnConnect.textContent = 'DISCONNECT';
    } else if (state.replayActive) {
      if (el.connStatusPill) el.connStatusPill.innerHTML = '<span class="status-dot searching"></span> REPLAY';
      if (el.connStatusText) el.connStatusText.textContent = 'Simulating Storm Scenario';
      if (el.btnConnect) el.btnConnect.textContent = 'CONNECT USB';
    } else {
      if (el.connStatusPill) el.connStatusPill.innerHTML = '<span class="status-dot offline"></span> OFFLINE';
      if (el.connStatusText) el.connStatusText.textContent = 'Standby (Click Replay to Demo)';
      if (el.btnConnect) el.btnConnect.textContent = 'CONNECT USB';
    }

    // 6. Bottom Golden Accent Ribbon Assessment
    updateAssessmentRibbon();

    // 7. Render dynamic chart
    drawChart();
  }

  function renderKpBars(kpVal) {
    if (!el.swKpBars) return;
    const rounded = Math.round(kpVal);
    let html = '';
    for (let i = 1; i <= 9; i++) {
      let activeClass = '';
      if (i <= rounded) {
        if (i <= 3) activeClass = 'active-quiet';
        else if (i <= 5) activeClass = 'active-watch';
        else if (i <= 7) activeClass = 'active-warning';
        else activeClass = 'active-severe';
      }
      html += `<div class="sw-bar-segment ${activeClass}"></div>`;
    }
    el.swKpBars.innerHTML = html;
  }

  function updateAssessmentRibbon() {
    if (state.riskLevel === 'SEVERE') {
      el.bottomEyebrow.textContent = 'CRITICAL ALERT // SEVERE G4 GEOMAGNETIC STORM IN PROGRESS';
      el.bottomMessage.textContent = 'Massive solar wind shock arrival and prolonged southward Bz reconnection. High-latitude electrical grids at risk of Geomagnetically Induced Currents (GIC). HF radio blackouts observed.';
      el.pillGrid.textContent = 'GRID: GIC VOLTAGE INSTABILITY';
      el.pillRadio.textContent = 'RADIO: WIDE-BAND HF BLACKOUT';
      el.pillLead.textContent = 'AURORAL OVAL: ~45Ã‚Â° LATITUDE';
    } else if (state.riskLevel === 'WARNING') {
      el.bottomEyebrow.textContent = 'STORM WARNING // G2-G3 GEOMAGNETIC DISTURBANCE DETECTED';
      el.bottomMessage.textContent = 'Moderate geomagnetic storm active. Induced ground perturbations registered on local Hall probe. Power systems should monitor transformer neutral currents.';
      el.pillGrid.textContent = 'GRID: MONITOR TRANSFORMERS';
      el.pillRadio.textContent = 'RADIO: HIGH LATITUDE ABSORPTION';
      el.pillLead.textContent = 'AURORAL OVAL: ~55Ã‚Â° LATITUDE';
    } else if (state.riskLevel === 'WATCH') {
      el.bottomEyebrow.textContent = 'STORM WATCH // CME IMPACT / ELEVATED SOLAR ACTIVITY';
      el.bottomMessage.textContent = 'Solar wind velocity rising above baseline. Minor magnetic field compression detected. Spacecraft operators should monitor surface charging.';
      el.pillGrid.textContent = 'GRID: NOMINAL / WATCH';
      el.pillRadio.textContent = 'RADIO: MINOR FLUCTUATION';
      el.pillLead.textContent = 'AURORAL OVAL: HIGH ARCTIC';
    } else {
      el.bottomEyebrow.textContent = 'SYSTEM NOMINAL // INTERPLANETARY CONDITIONS QUIET';
      el.bottomMessage.textContent = 'Earth magnetosphere stable. Solar wind velocity nominal (~380 km/s). Northward magnetic alignment deflecting incoming solar particles. Local ground baseline steady.';
      el.pillGrid.textContent = 'GRID: STABLE';
      el.pillRadio.textContent = 'RADIO: CLEAR';
      el.pillLead.textContent = 'AURORAL OVAL: POLAR REGION';
    }
  }

  function appendTelemetryHistory(bz, speed, delta) {
    const hist = state.history;
    hist.bz.push(Number(bz));
    hist.speed.push(Number(speed));
    hist.hallDelta.push(Number(delta));
    hist.timestamps.push(Date.now());

    const cutoff = Date.now() - 60000;
    while (hist.timestamps.length > 0 && (hist.timestamps[0] < cutoff || hist.bz.length > hist.maxPoints)) {
      hist.bz.shift();
      hist.speed.shift();
      hist.hallDelta.shift();
      hist.timestamps.shift();
    }
  }

  // --- SERIAL & SSE STREAM CONNECTION ---
  let evtSource = null;
  let simulatedTimer = null;

  function connectSSE() {
    if (evtSource) {
      evtSource.close();
    }

    try {
      evtSource = new EventSource(`${API_BASE}/api/stream`);

      evtSource.onmessage = function (e) {
        try {
          const data = JSON.parse(e.data);
          applyTelemetry(data);
        } catch (err) {
          console.error('SSE parse error', err);
        }
      };

      evtSource.onerror = function () {
        console.warn('SSE stream disconnected or bridge offline. Switching to client simulation fallback...');
        if (evtSource) {
          evtSource.close();
          evtSource = null;
        }
        startClientSimulation();
      };
    } catch (e) {
      console.warn('EventSource failed to initialize', e);
      startClientSimulation();
    }
  }

  function applyTelemetry(data) {
    // Check if risk level escalated to chime
    const oldRisk = state.riskLevel;

    state.connected = !!data.connected;
    state.serialPort = data.serial_port || state.serialPort;
    state.baudRate = data.baud_rate || state.baudRate;
    state.packetCount = data.packet_count || (state.packetCount + 1);
    state.mode = data.mode || state.mode;
    state.source = data.source || (state.connected ? 'USB_LIVE' : 'SIMULATION');

    state.kp = data.kp !== undefined ? data.kp : state.kp;
    state.bz = data.bz !== undefined ? data.bz : state.bz;
    state.solarSpeed = data.solar_speed !== undefined ? data.solar_speed : state.solarSpeed;
    state.hallRaw = data.hall_raw !== undefined ? data.hall_raw : state.hallRaw;
    state.hallBaseline = data.hall_baseline !== undefined ? data.hall_baseline : state.hallBaseline;
    state.hallDelta = data.hall_delta !== undefined ? data.hall_delta : (state.hallRaw - state.hallBaseline);
    state.hallDo = data.hall_do !== undefined ? data.hall_do : state.hallDo;
    state.relayTriggered = data.relay_triggered !== undefined ? data.relay_triggered : state.relayTriggered;
    state.cloudLevel = data.cloud_level !== undefined ? data.cloud_level : state.cloudLevel;
    state.localLevel = data.local_level !== undefined ? data.local_level : state.localLevel;
    state.finalLevel = data.final_level !== undefined ? data.final_level : state.finalLevel;
    state.spaceWord = data.space_word || state.spaceWord;
    state.localWord = data.local_word || state.localWord;
    state.riskLevel = data.risk_level || state.riskLevel;
    state.lcdLine1 = data.lcd_line1 || state.lcdLine1;
    state.lcdLine2 = data.lcd_line2 || state.lcdLine2;
    state.rgbColor = data.rgb_color || state.rgbColor;
    state.buzzer = data.buzzer || state.buzzer;
    state.replayActive = !!data.replay_active;

    if (Array.isArray(data.noaa_history) && data.noaa_history.length && !state.connected && !state.replayActive) {
      const samples = data.noaa_history;
      state.history.bz = samples.map(sample => Number(sample.bz));
      state.history.speed = samples.map(sample => Number(sample.solar_speed));
      state.history.hallDelta = samples.map(() => state.hallDelta);
      state.history.timestamps = samples.map(sample => {
        const stamp = String(sample.time_tag || '');
        return Date.parse(stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`);
      });
    } else {
      const sampleKey = `${state.source}:${state.packetCount}:${state.bz}:${state.solarSpeed}:${state.hallDelta}`;
      if (sampleKey !== state.lastHistorySampleKey) {
        appendTelemetryHistory(state.bz, state.solarSpeed, state.hallDelta);
        state.lastHistorySampleKey = sampleKey;
      }
    }

    if (state.riskLevel !== oldRisk && (state.riskLevel === 'WARNING' || state.riskLevel === 'SEVERE')) {
      playAlertBeep(state.riskLevel);
    }

    updateUI();
  }

  // Client-side fallback simulation in case the html is opened directly without python
  function startClientSimulation() {
    if (simulatedTimer) return;
    console.log('[MAGNETAR] Running self-contained client telemetry engine.');

    let tick = 0;
    simulatedTimer = setInterval(() => {
      tick++;
      // Subtle background noise
      const noise = Math.sin(tick * 0.2) * 0.3;
      if (!state.replayActive) {
        state.source = 'OFFLINE_DEMO_CLIENT';
        state.kp = 1.7 + noise * 0.2;
        state.bz = 3.8 + noise * 0.4;
        state.solarSpeed = 380 + Math.sin(tick * 0.1) * 15;
        state.hallDelta = Math.round(noise * 2);
        state.hallRaw = state.hallBaseline + state.hallDelta;
        state.riskLevel = 'QUIET';
        state.rgbColor = '#34c759';
        state.buzzer = 'OFF';
        state.lcdLine1 = 'MAGNETAR: QUIET';
        state.lcdLine2 = `Kp:${state.kp.toFixed(1)} Bz:${state.bz > 0 ? '+' : ''}${state.bz.toFixed(1)}nT`;
      }
      appendTelemetryHistory(state.bz, state.solarSpeed, state.hallDelta);
      updateUI();
    }, 400);
  }

  // --- API ACTIONS ---
  async function fetchPorts() {
    try {
      const res = await fetch(`${API_BASE}/api/ports`);
      if (res.ok) {
        const data = await res.json();
        renderPortDropdown(data.ports, data.current);
      }
    } catch (e) {
      console.log('Ports API unavailable (offline)');
    }
  }

  function renderPortDropdown(ports, current) {
    if (el.portList) {
      el.portList.innerHTML = '';
      const com7 = document.createElement('option');
      com7.value = 'COM7';
      com7.textContent = 'COM7 (USB Serial Device)';
      el.portList.appendChild(com7);

      if (ports && ports.length > 0) {
        ports.forEach(p => {
          if (p.port !== 'COM7') {
            const opt = document.createElement('option');
            opt.value = p.port;
            opt.textContent = `${p.port} (${p.description.slice(0, 22)})`;
            el.portList.appendChild(opt);
          }
        });
      }
    }
    if (el.portInput && !el.portInput.value) {
      el.portInput.value = current || 'COM7';
    }
  }

  async function triggerConnect() {
    if (state.connected) {
      try {
        await fetch(`${API_BASE}/api/disconnect`, { method: 'POST' });
        state.connected = false;
        updateUI();
      } catch (e) {
        console.error(e);
      }
    } else {
      const port = (el.portInput ? el.portInput.value.trim() : '') || 'COM7';
      try {
        const res = await fetch(`${API_BASE}/api/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: port, baud: state.baudRate })
        });
        if (res.ok) {
          state.serialPort = port;
          if (el.connStatusText) el.connStatusText.textContent = `Connecting to ${port}...`;
        }
      } catch (e) {
        alert('Could not reach Python bridge. Make sure bridge.py is running!');
      }
    }
  }

  async function triggerReplay(duration = 60) {
    initAudio();
    // Try sending to bridge
    try {
      const res = await fetch(`${API_BASE}/api/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', duration: duration })
      });
      if (res.ok) {
        state.replayActive = true;
        updateUI();
        return;
      }
    } catch (e) {
      // Bridge not responding, run client-side script
    }

    // Client-side replay implementation
    runClientReplay(duration);
  }

  const REPLAY_FRAMES = [
    { kp: 2.0, speed: 400, bz: 2.0, hallDelta: 10 },
    { kp: 3.0, speed: 450, bz: -3.0, hallDelta: 35 },
    { kp: 4.0, speed: 560, bz: -9.0, hallDelta: 75 },
    { kp: 5.0, speed: 680, bz: -18.0, hallDelta: 145 },
    { kp: 7.0, speed: 850, bz: -35.0, hallDelta: 315 },
    { kp: 9.0, speed: 950, bz: -45.0, hallDelta: 380 },
    { kp: 6.0, speed: 700, bz: -15.0, hallDelta: 155 },
    { kp: 3.0, speed: 480, bz: -4.0, hallDelta: 25 }
  ];

  function runClientReplay(duration = 56) {
    state.replayActive = true;
    state.source = 'HARDWARE_REPLAY_SIM';
    const startTime = Date.now();
    const frameDurationMs = 7000; // matching REPLAY_FRAME_MS in sketch
    const totalDurationMs = REPLAY_FRAMES.length * frameDurationMs;

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const frameIdx = Math.floor(elapsed / frameDurationMs);

      if (frameIdx >= REPLAY_FRAMES.length) {
        clearInterval(interval);
        state.replayActive = false;
        state.kp = 4.0;
        state.bz = -9.0;
        state.solarSpeed = 560;
        state.hallDelta = 0;
        state.hallRaw = state.hallBaseline;
        state.cloudLevel = 1;
        state.localLevel = 0;
        state.finalLevel = 1;
        state.riskLevel = 'WATCH';
        state.spaceWord = 'active';
        state.localWord = 'quiet';
        state.rgbColor = '#fed857';
        state.buzzer = 'OFF';
        state.relayTriggered = false;
        state.source = 'STORED_OFFLINE';
        updateUI();
        return;
      }

      const f = REPLAY_FRAMES[frameIdx];
      state.kp = f.kp;
      state.solarSpeed = f.speed;
      state.bz = f.bz;
      state.hallDelta = f.hallDelta;
      state.hallRaw = state.hallBaseline + state.hallDelta;

      // Cloud classification matching Arduino
      if (f.kp >= 7 || (f.speed > 600 && f.bz < -15)) state.cloudLevel = 3;
      else if (f.kp >= 5 || (f.speed > 500 && f.bz < -10)) state.cloudLevel = 2;
      else if (f.kp >= 4 || f.bz < -5 || f.speed > 450) state.cloudLevel = 1;
      else state.cloudLevel = 0;

      // Local classification matching HALL_THRESH {40, 120, 300}
      if (f.hallDelta >= 300) state.localLevel = 3;
      else if (f.hallDelta >= 120) state.localLevel = 2;
      else if (f.hallDelta >= 40) state.localLevel = 1;
      else state.localLevel = 0;

      state.finalLevel = Math.max(state.cloudLevel, state.localLevel);
      const levelNames = ['QUIET', 'WATCH', 'WARNING', 'SEVERE'];
      const spaceWords = ['calm', 'active', 'STORM!', 'SEVERE'];
      const localWords = ['quiet', 'change', 'FIELD!', 'STRONG'];
      const colors = ['#34c759', '#fed857', '#ff9500', '#ff3b30'];

      state.riskLevel = levelNames[state.finalLevel];
      state.spaceWord = spaceWords[state.cloudLevel];
      state.localWord = localWords[state.localLevel];
      state.rgbColor = colors[state.finalLevel];
      state.buzzer = state.finalLevel >= 3 ? 'ALARM' : (state.finalLevel === 2 ? 'CHIRP' : 'OFF');
      state.relayTriggered = (state.finalLevel >= 3);

      // Mirror LCD page flip
      if (Math.floor(Date.now() / 3000) % 2 === 0) {
        state.lcdLine1 = `Space: ${state.spaceWord.padEnd(7, ' ')}R`;
        state.lcdLine2 = `Local: ${state.localWord.padEnd(8, ' ')}`;
      } else {
        state.lcdLine1 = `Kp:${state.kp.toFixed(1)} Wind:${Math.round(state.solarSpeed)}R`;
        state.lcdLine2 = `Bz:${Math.round(state.bz)} Hall:${state.hallDelta}`;
      }

      if (state.finalLevel >= 2) playAlertBeep(state.riskLevel);

      appendTelemetryHistory(state.bz, state.solarSpeed, state.hallDelta);
      updateUI();
    }, 200);
  }

  async function calibrateBaseline() {
    try {
      await fetch(`${API_BASE}/api/calibrate`, { method: 'POST' });
    } catch (e) {
      // offline client fallback
    }
    state.hallBaseline = state.hallRaw;
    state.hallDelta = 0;
    updateUI();
  }

  function injectTestSpike() {
    initAudio();
    state.hallDelta += 38;
    state.hallRaw += 38;
    state.bz = -18.5;
    state.kp = 7.6;
    state.solarSpeed = 780;
    state.riskLevel = 'SEVERE';
    state.rgbColor = '#ff3b30';
    state.buzzer = 'ALARM';
    state.lcdLine1 = 'TEST INJECT SPIKE';
    state.lcdLine2 = 'Kp:7.6 Bz:-18nT';
    playAlertBeep('SEVERE');
    appendTelemetryHistory(state.bz, state.solarSpeed, state.hallDelta);
    updateUI();
  }

  function exportCsv() {
    const rows = [['Timestamp', 'Bz_nT', 'SolarSpeed_kms', 'HallDelta', 'Kp']];
    for (let i = 0; i < state.history.bz.length; i++) {
      rows.push([
        state.history.timestamps[i] ? new Date(state.history.timestamps[i]).toLocaleTimeString() : '',
        state.history.bz[i],
        state.history.speed[i],
        state.history.hallDelta[i],
        state.kp
      ]);
    }
    const csvContent = 'data:text/csv;charset=utf-8,' + rows.map(e => e.join(',')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `magnetar_telemetry_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // --- RAW SERIAL CONSOLE ---
  async function refreshConsoleLogs() {
    try {
      const res = await fetch(`${API_BASE}/api/logs`);
      if (res.ok) {
        const data = await res.json();
        if (data.logs && el.consoleBody) {
          el.consoleBody.innerHTML = '';
          data.logs.forEach(item => {
            const row = document.createElement('div');
            row.className = `console-line ${item.is_error ? 'err' : ''}`;
            row.textContent = `[${item.time}] ${item.text}`;
            el.consoleBody.appendChild(row);
          });
          el.consoleBody.scrollTop = el.consoleBody.scrollHeight;
        }
      }
    } catch (e) {}
  }

  // --- EVENT LISTENERS ---
  if (el.btnConnect) el.btnConnect.addEventListener('click', triggerConnect);
  if (el.btnRefreshPorts) el.btnRefreshPorts.addEventListener('click', fetchPorts);
  if (el.btnTriggerReplay) el.btnTriggerReplay.addEventListener('click', () => triggerReplay(60));
  if (el.btnQuickReplay) el.btnQuickReplay.addEventListener('click', () => triggerReplay(60));
  if (el.btnZeroBaseline) el.btnZeroBaseline.addEventListener('click', calibrateBaseline);
  if (el.btnTestSpike) el.btnTestSpike.addEventListener('click', injectTestSpike);
  if (el.btnExportCsv) el.btnExportCsv.addEventListener('click', exportCsv);

  if (el.audioToggle) {
    el.audioToggle.addEventListener('change', (e) => {
      state.audioMuted = !e.target.checked;
      if (!state.audioMuted) initAudio();
    });
  }

  if (el.btnConsoleToggle) {
    el.btnConsoleToggle.addEventListener('click', () => {
      el.consoleDrawer.classList.toggle('open');
      if (el.consoleDrawer.classList.contains('open')) {
        refreshConsoleLogs();
      }
    });
  }

  if (el.consoleClose) {
    el.consoleClose.addEventListener('click', () => {
      el.consoleDrawer.classList.remove('open');
    });
  }

  if (el.consoleInput) {
    el.consoleInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const val = el.consoleInput.value.trim();
        if (val) {
          el.consoleInput.value = '';
          try {
            await fetch(`${API_BASE}/api/command`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cmd: val })
            });
            setTimeout(refreshConsoleLogs, 150);
          } catch (err) {}
        }
      }
    });
  }

  // Kickoff
  fetchPorts();
  connectSSE();
  updateUI();
  setInterval(fetchPorts, 8000);
})();
