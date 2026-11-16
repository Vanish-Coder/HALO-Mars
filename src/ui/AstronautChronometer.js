/**
 * HALO Mars — Hero Status Card, Wayfinder Watch Chronometer & Collapsible Telemetry Drawers
 * Renders Apple Watch Ultra Wayfinder dial, CR2032 1Hz Always-On monochrome mode,
 * 360° DEM vs. Visor Skyline waveform, and 4-system NASA-STD-3001 triage sparklines with zero GC.
 */

import { iconSvg } from './icons.js';

const MAX_SPARK_SAMPLES = 90;

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatEvaClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

function getSemanticHex(status) {
  if (status === 'EXCEEDED') return '#FF453A';
  if (status === 'CAUTION') return '#FF9F0A';
  return '#30D158';
}

export class AstronautChronometer {
  constructor() {
    this.elHeroPill = document.getElementById('hero-status-pill');
    this.elHeroBurn = document.getElementById('hero-burn-rate');
    this.elHeroO2Batt = document.getElementById('hero-o2-batt');

    this.watchCanvas = document.getElementById('chronometer-canvas');
    this.watchCtx = this.watchCanvas ? this.watchCanvas.getContext('2d') : null;
    this.elPowerReadout = document.getElementById('power-telemetry-readout');

    this.elSummarySkyline = document.getElementById('summary-skyline');
    this.skylineCanvas = document.getElementById('skyline-canvas');
    this.skylineCtx = this.skylineCanvas ? this.skylineCanvas.getContext('2d') : null;
    this.elSkylineMeta = document.getElementById('skyline-meta');
    this.elTrnNcc = document.getElementById('trn-val-ncc');
    this.elTrnPos = document.getElementById('trn-val-pos');
    this.elTrnYaw = document.getElementById('trn-val-yaw');
    this.elTrnMs = document.getElementById('trn-val-ms');

    this.elSummaryVitals = document.getElementById('summary-vitals');
    this.elVitalCv = document.getElementById('vital-cv');
    this.elVitalSpo2 = document.getElementById('vital-spo2');
    this.elVitalTemp = document.getElementById('vital-temp');
    this.elVitalCo2 = document.getElementById('vital-co2');
    this.sparkCanvas = document.getElementById('sparkline-canvas');
    this.sparkCtx = this.sparkCanvas ? this.sparkCanvas.getContext('2d') : null;

    // Preallocated ring buffer for 0 B/frame sparkline history
    this.hrRing = new Float32Array(MAX_SPARK_SAMPLES);
    this.kcalRing = new Float32Array(MAX_SPARK_SAMPLES);
    this.radiusRing = new Float32Array(MAX_SPARK_SAMPLES);
    this.ringHead = 0;
    this.ringCount = 0;
  }

  pushSparklineSample(hrBpm, calorieReserveKcal, safeRadiusKm) {
    const idx = this.ringHead;
    this.hrRing[idx] = hrBpm;
    this.kcalRing[idx] = calorieReserveKcal;
    this.radiusRing[idx] = Math.max(0, safeRadiusKm);
    this.ringHead = (idx + 1) % MAX_SPARK_SAMPLES;
    if (this.ringCount < MAX_SPARK_SAMPLES) {
      this.ringCount++;
    }
  }

  renderHeroStatusCard(heroMetrics, localTelemetry, state) {
    if (!this.elHeroPill) return;

    this.elHeroPill.classList.remove('state-safe', 'state-caution', 'state-exceeded');
    let statusIcon = 'check-circle';
    let statusText = '';
    if (heroMetrics.status === 'EXCEEDED') {
      this.elHeroPill.classList.add('state-exceeded');
      statusIcon = 'alert-octagon';
      statusText = `EXCEEDED SAFE RETURN — TURN BACK NOW (DEFICIT: -${heroMetrics.kcalDeficit} kcal / -${heroMetrics.o2DeficitPct}% O2)`;
    } else if (heroMetrics.status === 'CAUTION') {
      this.elHeroPill.classList.add('state-caution');
      statusIcon = 'alert-triangle';
      statusText = 'CAUTION ZONE — APPROACHING TURNAROUND LIMIT';
    } else {
      this.elHeroPill.classList.add('state-safe');
      statusText = `INSIDE SAFE RETURN (+${heroMetrics.marginPct}% MARGIN • ${heroMetrics.turnaroundDistKm.toFixed(2)} km TO TURNAROUND)`;
    }
    this.elHeroPill.innerHTML = `${iconSvg(statusIcon, 'ui-icon ui-icon-sm')} ${escapeHtml(statusText)}`;

    if (this.elHeroBurn && localTelemetry) {
      const kcalHr = Math.round(localTelemetry.kcalPerHr || 0);
      const watts = Math.round(localTelemetry.E_dot_watts || 0);
      this.elHeroBurn.textContent = `Burn: ${kcalHr} kcal/hr (${watts} W)`;
    }

    if (this.elHeroO2Batt && state) {
      this.elHeroO2Batt.textContent = `O₂: ${state.o2ReserveKg.toFixed(2)} kg • Batt: ${Math.round(state.batteryWh)} Wh`;
    }
  }

  renderWayfinderWatch(heroMetrics, localTelemetry, powerProfile, state, evaSec = 0) {
    if (this.elPowerReadout && powerProfile) {
      this.elPowerReadout.textContent = powerProfile.telemetryBadge;
    }

    const ctx = this.watchCtx;
    const canvas = this.watchCanvas;
    if (!ctx || !canvas) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const rOuter = Math.min(w, h) * 0.44;
    const eco = !!(state && state.ecoMode);

    ctx.clearRect(0, 0, w, h);

    if (eco) {
      // 1-Bit CR2032 Always-On Mode: strict #000000 + #30D158 monochrome watch face
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(cx, cy, rOuter + 14, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#30D158';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
      ctx.stroke();

      // Sparse 12-hour cardinal & bezel ticks for low-pixel OLED duty cycle
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * Math.PI * 2 - Math.PI * 0.5;
        const innerR = i % 3 === 0 ? rOuter - 18 : rOuter - 10;
        ctx.lineWidth = i % 3 === 0 ? 3.5 : 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * innerR, cy + Math.sin(ang) * innerR);
        ctx.lineTo(cx + Math.cos(ang) * (rOuter - 3), cy + Math.sin(ang) * (rOuter - 3));
        ctx.stroke();
      }

      // Single resource arc showing remaining safe margin
      const rEcoRing = rOuter - 26;
      const marginFrac = Math.max(0, Math.min(1, 1.0 - heroMetrics.fieldValue));
      if (marginFrac > 0.01) {
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(cx, cy, rEcoRing, -Math.PI * 0.5, -Math.PI * 0.5 + Math.PI * 2 * marginFrac);
        ctx.stroke();
      } else {
        ctx.setLineDash([8, 8]);
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(cx, cy, rEcoRing, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = '#30D158';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 15px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText('1Hz ECO WATCH', cx, cy - 50);

      const isExceeded = heroMetrics.status === 'EXCEEDED';
      ctx.font = isExceeded
        ? '800 36px ui-monospace, SFMono-Regular, Menlo, monospace'
        : '800 48px ui-monospace, SFMono-Regular, Menlo, monospace';
      const centerHeadline = isExceeded
        ? 'TURN BACK'
        : `+${Math.max(0, heroMetrics.marginPct)}%`;
      ctx.fillText(centerHeadline, cx, cy - 8);

      ctx.font = '700 19px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(`EVA ${formatEvaClock(evaSec)}`, cx, cy + 34);
      ctx.font = '600 14px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText('14.1 mA • 5.6 HRS', cx, cy + 62);
      return;
    }

    // Standard 60 Hz Apple Watch Ultra Wayfinder Chronograph Face
    const light = !!(state && state.lightMode);
    const grad = ctx.createRadialGradient(cx, cy, 12, cx, cy, rOuter + 14);
    if (light) {
      grad.addColorStop(0, '#FFFFFF');
      grad.addColorStop(0.85, '#F2F5FA');
      grad.addColorStop(1, '#E2E8F0');
    } else {
      grad.addColorStop(0, '#141923');
      grad.addColorStop(0.85, '#090C12');
      grad.addColorStop(1, '#05070B');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter + 12, 0, Math.PI * 2);
    ctx.fill();

    // Titanium bezel rim
    ctx.strokeStyle = light ? 'rgba(15, 23, 42, 0.28)' : 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter + 8, 0, Math.PI * 2);
    ctx.stroke();

    // 60-tick bezel compass/chronograph graduations
    for (let i = 0; i < 60; i++) {
      const ang = (i / 60) * Math.PI * 2 - Math.PI * 0.5;
      const isMajor = i % 5 === 0;
      const r0 = isMajor ? rOuter - 12 : rOuter - 7;
      ctx.strokeStyle = light
        ? isMajor
          ? 'rgba(27, 34, 48, 0.85)'
          : 'rgba(27, 34, 48, 0.28)'
        : isMajor
          ? 'rgba(255, 255, 255, 0.85)'
          : 'rgba(255, 255, 255, 0.28)';
      ctx.lineWidth = isMajor ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * rOuter, cy + Math.sin(ang) * rOuter);
      ctx.stroke();
    }

    // Cardinal Wayfinder Bearing Letters
    ctx.fillStyle = light ? '#B45309' : '#FF9F0A';
    ctx.font = '700 14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const rCard = rOuter - 25;
    ctx.fillText('N', cx, cy - rCard);
    ctx.fillStyle = light ? 'rgba(27, 34, 48, 0.72)' : 'rgba(255, 255, 255, 0.55)';
    ctx.fillText('E', cx + rCard, cy);
    ctx.fillText('S', cx, cy + rCard);
    ctx.fillText('W', cx - rCard, cy);

    // Concentric Resource Rings (O2 outer, Calories/Battery inner) sized for wide center clearance
    const rArc1 = rOuter - 42;
    const rArc2 = rOuter - 54;
    const o2Frac = Math.max(0, Math.min(1, (state.o2ReserveKg - 0.12) / 0.45));
    const kcalFrac = Math.max(0, Math.min(1, (state.calorieReserveKcal - 250) / 1100));
    const battFrac = Math.max(0, Math.min(1, (state.batteryWh - 90) / 700));
    const lifeFrac = Math.min(kcalFrac, battFrac);
    const statusColor = light
      ? heroMetrics.status === 'EXCEEDED'
        ? '#C81E1E'
        : heroMetrics.status === 'CAUTION'
          ? '#B45309'
          : '#117A37'
      : getSemanticHex(heroMetrics.status);

    // Track backgrounds
    ctx.lineCap = 'round';
    ctx.strokeStyle = light ? 'rgba(15, 23, 42, 0.12)' : 'rgba(255, 255, 255, 0.09)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(cx, cy, rArc1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, rArc2, 0, Math.PI * 2);
    ctx.stroke();

    // O2 Arc
    ctx.strokeStyle = o2Frac < 0.25 ? '#FF453A' : o2Frac < 0.5 ? '#FF9F0A' : '#30D158';
    ctx.beginPath();
    ctx.arc(cx, cy, rArc1, -Math.PI * 0.5, -Math.PI * 0.5 + Math.PI * 2 * o2Frac);
    ctx.stroke();

    // Calorie/Battery Arc
    ctx.strokeStyle = lifeFrac < 0.25 ? '#FF453A' : '#0A84FF';
    ctx.beginPath();
    ctx.arc(cx, cy, rArc2, -Math.PI * 0.5, -Math.PI * 0.5 + Math.PI * 2 * lifeFrac);
    ctx.stroke();

    // Home Bearing Marker on the outer compass bezel (pointing inward toward Hab Base)
    const dxHome = 75 - state.astroGx;
    const dyHome = 75 - state.astroGy;
    if (dxHome !== 0 || dyHome !== 0) {
      const homeAng = Math.atan2(dyHome, dxHome);
      ctx.fillStyle = '#0A84FF';
      const tipX = cx + Math.cos(homeAng) * (rOuter - 16);
      const tipY = cy + Math.sin(homeAng) * (rOuter - 16);
      const leftX = cx + Math.cos(homeAng - 0.075) * (rOuter - 3);
      const leftY = cy + Math.sin(homeAng - 0.075) * (rOuter - 3);
      const rightX = cx + Math.cos(homeAng + 0.075) * (rOuter - 3);
      const rightY = cy + Math.sin(homeAng + 0.075) * (rOuter - 3);
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(leftX, leftY);
      ctx.lineTo(rightX, rightY);
      ctx.closePath();
      ctx.fill();
    }

    // Central Digital Telemetry Readout (sized strictly inside rArc2 center well)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = light ? 'rgba(27, 34, 48, 0.72)' : 'rgba(255, 255, 255, 0.58)';
    ctx.font = '700 13.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`EVA ${formatEvaClock(evaSec)}`, cx, cy - 32);

    ctx.fillStyle = statusColor;
    const isExceeded = heroMetrics.status === 'EXCEEDED';
    ctx.font = isExceeded
      ? '800 32px ui-monospace, SFMono-Regular, Menlo, monospace'
      : '800 42px ui-monospace, SFMono-Regular, Menlo, monospace';
    const mainVal = isExceeded
      ? `-${heroMetrics.kcalDeficit} kcal`
      : `+${Math.max(0, heroMetrics.marginPct)}%`;
    ctx.fillText(mainVal, cx, cy + 1);

    ctx.fillStyle = light ? '#1B2230' : 'rgba(255, 255, 255, 0.88)';
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    const hrDisp = Math.round(localTelemetry?.hr_effective || state.hrBpm);
    const subLabel = isExceeded
      ? `TURN BACK • ${hrDisp} BPM`
      : `${heroMetrics.turnaroundDistKm.toFixed(2)} km • ${hrDisp} BPM`;
    ctx.fillText(subLabel, cx, cy + 32);
  }

  renderSkylinePlot(skylineResult, state) {
    if (skylineResult) {
      const pct = (skylineResult.ncc * 100).toFixed(1);
      const err = Math.round(skylineResult.errorM);
      const ms = skylineResult.elapsedMs.toFixed(1);
      const yawSign = skylineResult.yawOffsetDeg >= 0 ? '+' : '';
      const yawStr = `${yawSign}${skylineResult.yawOffsetDeg.toFixed(0)}°`;

      if (this.elSummarySkyline) {
        this.elSummarySkyline.textContent = `360° Horizon Camera Match: ${pct}% (±${err}m • ${ms}ms)`;
      }
      if (this.elSkylineMeta) {
        this.elSkylineMeta.textContent = `Camera horizon lock: yaw ${yawStr} • Pos (${skylineResult.gx}, ${skylineResult.gy}) • Zero-GPS terrain match`;
      }
      if (this.elTrnNcc) this.elTrnNcc.textContent = `${pct}%`;
      if (this.elTrnPos) this.elTrnPos.textContent = `GX ${skylineResult.gx}, GY ${skylineResult.gy} (±${err}m)`;
      if (this.elTrnYaw) this.elTrnYaw.textContent = `Yaw ${yawStr} True-N`;
      if (this.elTrnMs) this.elTrnMs.textContent = `${ms} ms`;
    }

    const ctx = this.skylineCtx;
    const canvas = this.skylineCanvas;
    if (!ctx || !canvas || !skylineResult) return;

    const w = canvas.width;
    const h = canvas.height;
    const eco = !!(state && state.ecoMode);
    const light = !!(state && state.lightMode) && !eco;
    const padL = 42;
    const padR = 14;
    const padT = 30;
    const padB = 24;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = eco ? '#000000' : light ? '#F2F5FA' : '#080B11';
    ctx.fillRect(0, 0, w, h);

    // Find angle range for dynamic auto-scaling
    const q = skylineResult.queryDeg;
    const m = skylineResult.matchedDeg;
    let minD = 90;
    let maxD = -90;
    for (let i = 0; i < 36; i++) {
      if (q[i] < minD) minD = q[i];
      if (q[i] > maxD) maxD = q[i];
      if (m[i] < minD) minD = m[i];
      if (m[i] > maxD) maxD = m[i];
    }
    const lo = Math.min(-2, Math.floor(minD - 2));
    const hi = Math.max(8, Math.ceil(maxD + 2));
    const span = Math.max(1, hi - lo);

    const toX = (bin) => padL + (bin / 36) * plotW;
    const toY = (deg) => padT + (1.0 - (deg - lo) / span) * plotH;

    // Grid lines
    ctx.strokeStyle = eco
      ? 'rgba(48, 209, 88, 0.25)'
      : light
        ? 'rgba(15, 23, 42, 0.12)'
        : 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const x = padL + (k / 4) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
    }
    const zeroY = toY(0);
    ctx.beginPath();
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(padL + plotW, zeroY);
    ctx.stroke();

    // DEM Matched Silhouette Area Fill
    ctx.beginPath();
    ctx.moveTo(toX(0), padT + plotH);
    for (let i = 0; i < 36; i++) {
      ctx.lineTo(toX(i), toY(m[i]));
    }
    ctx.lineTo(toX(36), toY(m[0]));
    ctx.lineTo(toX(36), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = eco ? 'rgba(48, 209, 88, 0.14)' : 'rgba(48, 209, 88, 0.18)';
    ctx.fill();

    // DEM Matched Line
    ctx.beginPath();
    for (let i = 0; i < 36; i++) {
      const x = toX(i);
      const y = toY(m[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(toX(36), toY(m[0]));
    ctx.strokeStyle = '#30D158';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Visor Query Silhouette Dashed Line
    ctx.beginPath();
    for (let i = 0; i < 36; i++) {
      const x = toX(i);
      const y = toY(q[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(toX(36), toY(q[0]));
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = eco ? '#30D158' : '#0A84FF';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    // Plot frame border separating header legend from waveform area
    ctx.strokeStyle = eco
      ? 'rgba(48, 209, 88, 0.25)'
      : light
        ? 'rgba(15, 23, 42, 0.14)'
        : 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, plotW, plotH);

    // Axis labels
    ctx.fillStyle = eco ? '#30D158' : light ? '#1B2230' : 'rgba(255, 255, 255, 0.72)';
    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${hi}°`, 6, padT + 10);
    ctx.fillText(`${lo}°`, 6, padT + plotH - 2);

    const cardinals = ['0° N', '90° E', '180° S', '270° W', '360°'];
    ctx.textAlign = 'center';
    for (let k = 0; k < cardinals.length; k++) {
      const x = k === 0 ? padL + 16 : k === 4 ? padL + plotW - 18 : padL + (k / 4) * plotW;
      ctx.fillText(cardinals[k], x, h - 7);
    }

    // Legend (safely inside 0..29px header strip above plot box)
    ctx.textAlign = 'right';
    ctx.fillStyle = light ? '#117A37' : '#30D158';
    ctx.fillText('— DEM Horizon (Map)', w - 140, 14);
    ctx.fillStyle = eco ? '#30D158' : light ? '#0056B3' : '#0A84FF';
    ctx.fillText('-- Visor Camera', w - 12, 14);
  }

  renderVitalsAndSparkline(localTelemetry, heroMetrics, state) {
    if (localTelemetry && state) {
      const hrEff = Math.round(localTelemetry.hr_effective || state.hrBpm);
      const isLight = !!state.lightMode;
      const critColor = isLight ? '#C81E1E' : '#FF453A';
      const warnColor = isLight ? '#B45309' : '#FF9F0A';

      if (this.elVitalCv) {
        const cvStatus = localTelemetry.cv_factor > 1.05 ? 'High' : 'Normal';
        this.elVitalCv.textContent = `${hrEff} BPM • ${cvStatus} (${localTelemetry.cv_factor.toFixed(2)}×)`;
        this.elVitalCv.style.color = localTelemetry.cv_factor > 1.05 ? critColor : '';
      }
      if (this.elVitalSpo2) {
        const spo2Status =
          state.spo2Pct < 94.0 || localTelemetry.spo2_factor > 1.05 ? 'Low' : 'Normal';
        this.elVitalSpo2.textContent = `${state.spo2Pct.toFixed(1)}% • ${spo2Status} (${localTelemetry.spo2_factor.toFixed(2)}×)`;
        this.elVitalSpo2.style.color = localTelemetry.spo2_factor > 1.05 ? warnColor : '';
      }
      if (this.elVitalTemp) {
        const tempStatus =
          state.coreTempC > 37.8 || localTelemetry.therm_factor > 1.05 ? 'Elevated' : 'Normal';
        this.elVitalTemp.textContent = `${state.coreTempC.toFixed(1)}°C • ${tempStatus} (${localTelemetry.therm_factor.toFixed(2)}×)`;
        this.elVitalTemp.style.color = localTelemetry.therm_factor > 1.05 ? warnColor : '';
      }
      if (this.elVitalCo2) {
        const co2Status =
          state.ppCo2MmHg > 2.5 || localTelemetry.co2_factor > 1.05 ? 'High' : 'Normal';
        this.elVitalCo2.textContent = `${state.ppCo2MmHg.toFixed(1)} mmHg • ${co2Status} (${localTelemetry.co2_factor.toFixed(2)}×)`;
        this.elVitalCo2.style.color = localTelemetry.co2_factor > 1.05 ? warnColor : '';
      }

      let triageLabel = 'Normal';
      let summaryIcon = 'heart';
      if (
        heroMetrics.status === 'EXCEEDED' ||
        localTelemetry.bioScalar >= 1.25 ||
        localTelemetry.hrr_pct >= 85
      ) {
        triageLabel = 'Critical Strain';
        summaryIcon = 'alert-octagon';
      } else if (
        heroMetrics.status === 'CAUTION' ||
        localTelemetry.bioScalar >= 1.06 ||
        localTelemetry.hrr_pct >= 65
      ) {
        triageLabel = 'Elevated Strain';
        summaryIcon = 'alert-triangle';
      }
      if (this.elSummaryVitals) {
        const totalBurnMult = (localTelemetry.bioScalar || 1.0).toFixed(2);
        this.elSummaryVitals.innerHTML = `${iconSvg(summaryIcon, 'ui-icon ui-icon-sm')} Crew Health & Safety Trend: ${escapeHtml(triageLabel)} (${totalBurnMult}× burn)`;
      }
    }

    const ctx = this.sparkCtx;
    const canvas = this.sparkCanvas;
    if (!ctx || !canvas) return;

    const w = canvas.width;
    const h = canvas.height;
    const eco = !!(state && state.ecoMode);
    const light = !!(state && state.lightMode) && !eco;
    const padL = 40;
    const padR = 46;
    const padT = 30;
    const padB = 22;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = eco ? '#000000' : light ? '#F2F5FA' : '#080B11';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = eco
      ? 'rgba(48, 209, 88, 0.25)'
      : light
        ? 'rgba(15, 23, 42, 0.14)'
        : 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, plotW, plotH);
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH * 0.5);
    ctx.lineTo(padL + plotW, padT + plotH * 0.5);
    ctx.stroke();

    const n = this.ringCount;
    if (n >= 2) {
      const start = this.ringCount < MAX_SPARK_SAMPLES ? 0 : this.ringHead;

      const drawSeries = (arr, minVal, maxVal, color, dashed = false) => {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const rIdx = (start + i) % MAX_SPARK_SAMPLES;
          const x = padL + (i / Math.max(1, n - 1)) * plotW;
          const t = Math.max(0, Math.min(1, (arr[rIdx] - minVal) / (maxVal - minVal)));
          const y = padT + (1 - t) * plotH;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.2;
        if (dashed) ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      };

      // Dual-axis: HR (60-190 BPM), Calorie Reserve (300-2000 kcal), Safe Radius (0-4 km)
      drawSeries(this.radiusRing, 0, 4.0, '#30D158', false);
      drawSeries(this.hrRing, 60, 190, eco ? '#30D158' : '#FF453A', false);
      drawSeries(this.kcalRing, 300, 2000, eco ? '#30D158' : '#0A84FF', true);
    }

    // Labels & Legend (clean separation between 14px header strip and 30px plot top)
    const safeText = eco ? '#30D158' : light ? '#117A37' : '#30D158';
    const hrText = eco ? '#30D158' : light ? '#C81E1E' : '#FF453A';
    const kcalText = eco ? '#30D158' : light ? '#0056B3' : '#0A84FF';

    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = hrText;
    ctx.fillText('190', 6, padT + 10);
    ctx.fillText('60', 10, padT + plotH - 2);

    ctx.textAlign = 'right';
    ctx.fillStyle = safeText;
    ctx.fillText('4.0km', w - 4, padT + 10);
    ctx.fillText('0km', w - 4, padT + plotH - 2);

    ctx.textAlign = 'center';
    ctx.fillStyle = hrText;
    ctx.fillText('— Heart Rate (BPM)', w * 0.25, 14);
    ctx.fillStyle = safeText;
    ctx.fillText('— Safe Distance (km)', w * 0.54, 14);
    ctx.fillStyle = kcalText;
    ctx.fillText('-- Calories (kcal)', w * 0.82, 14);
  }
}

