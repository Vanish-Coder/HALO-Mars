/**
 * BioRadius — Martian EVA Bioenergetics, Thermoregulation & 4-System Triage (Module B)
 * Unabridged Santee-Gernhardt / Apollo SP-368 partial-gravity locomotion (3.71 m/s²),
 * Stefan-Boltzmann radiative/convective thermal balance, and NASA-STD-3001 strain coupling.
 */

const GRID_N = 150;
const TOTAL_CELLS = GRID_N * GRID_N;
const CELL_M = 10000.0 / 149.0;
const DIAG_CELL_M = CELL_M * 1.41421356;
const RAD_TO_DEG = 180.0 / Math.PI;
const G_MARS = 3.71;
const G_RATIO = G_MARS / 9.80665;
const STEFAN_BOLTZMANN = 5.67037e-8;
const T_SUIT_4 = 268.0 * 268.0 * 268.0 * 268.0;
const T_LIT_4 = 235.0 * 235.0 * 235.0 * 235.0;
const T_SHAD_4 = 165.0 * 165.0 * 165.0 * 165.0;
const Q_RAD_LIT = 0.22 * STEFAN_BOLTZMANN * 1.95 * (T_SUIT_4 - T_LIT_4);
const Q_RAD_SHAD = 0.22 * STEFAN_BOLTZMANN * 1.95 * (T_SUIT_4 - T_SHAD_4);
const INV_SQRT_115 = 1.0 / Math.sqrt(1.15);
const INV_SQRT_185 = 1.0 / Math.sqrt(1.85);
const INV_SQRT_135 = 1.0 / Math.sqrt(1.35);
const INV_SQRT_105 = 1.0 / Math.sqrt(1.05);
const LN2 = Math.LN2;
const INV_3600 = 1.0 / 3600.0;

// 9-slot lookup for dx, dy in {-1, 0, 1}: slot = (dy + 1) * 3 + (dx + 1)
const DIR9_DIST = new Float64Array(9);
const DIR9_UX = new Float64Array(9);
const DIR9_UY = new Float64Array(9);
for (let dy = -1; dy <= 1; dy++) {
  for (let dx = -1; dx <= 1; dx++) {
    const slot = (dy + 1) * 3 + (dx + 1);
    if (dx === 0 && dy === 0) continue;
    const d = dx !== 0 && dy !== 0 ? DIAG_CELL_M : CELL_M;
    DIR9_DIST[slot] = d;
    DIR9_UX[slot] = (dx * CELL_M) / d;
    DIR9_UY[slot] = (dy * CELL_M) / d;
  }
}

/**
 * Lazily precomputes exact per-edge slope angle & Tobler-Mars velocity exponential
 * for every adjacent grid edge on the DEM to eliminate trig/exp overhead in Dijkstra.
 */
export function ensureEdgeGeometryCache(dem) {
  if (dem._edgeSlopeDeg && dem._edgeToblerExp) return;
  const elevs = dem.elevations;
  const totalSlots = TOTAL_CELLS * 9;
  const slopeDegArr = new Float32Array(totalSlots);
  const toblerExpArr = new Float32Array(totalSlots);

  for (let gy = 0; gy < GRID_N; gy++) {
    const rowBase = gy * GRID_N;
    for (let gx = 0; gx < GRID_N; gx++) {
      const fromIdx = rowBase + gx;
      const eFrom = elevs[fromIdx];
      const baseSlot = fromIdx * 9;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = gy + dy;
        if (ny < 0 || ny >= GRID_N) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = gx + dx;
          if (nx < 0 || nx >= GRID_N) continue;

          const slot = (dy + 1) * 3 + (dx + 1);
          const distM = DIR9_DIST[slot];
          const dz = elevs[ny * GRID_N + nx] - eFrom;
          const theta = Math.atan2(dz, distM);
          slopeDegArr[baseSlot + slot] = Math.abs(theta) * RAD_TO_DEG;
          toblerExpArr[baseSlot + slot] = Math.exp(-3.5 * Math.abs(Math.tan(theta) + 0.05));
        }
      }
    }
  }

  dem._edgeSlopeDeg = slopeDegArr;
  dem._edgeToblerExp = toblerExpArr;
}

/**
 * Creates a fresh canonical EVA mission state with locked normative defaults.
 */
export function createDefaultState() {
  return {
    siteId: 'MOUNT_SHARP_BOXWORK',
    activeLayer: 'topo',
    astroGx: 85,
    astroGy: 65,
    hrBpm: 88,
    suitMassKg: 50.0,
    sampleMassKg: 15.0,
    suitAndSampleMassKg: 65.0,
    calorieReserveKcal: 750,
    o2ReserveKg: 0.52,
    batteryWh: 780,
    nominalSpeedMs: 1.15,
    windSpeedMs: 8.5,
    windAzRad: 1.92,
    spo2Pct: 98.0,
    coreTempC: 37.1,
    ppCo2MmHg: 1.8,
    sepStormActive: false,
    ecoMode: false,
    layers: {
      topo: true,
      themis: true,
      crism: true,
      meda: true,
      rad: true
    }
  };
}

function computeCarriedMassKg(state) {
  const suitKg = state.suitMassKg ?? 50.0;
  const sampleKg =
    state.sampleMassKg ?? Math.max(0.0, (state.suitAndSampleMassKg ?? 65.0) - suitKg);
  return suitKg + (state.layers.crism ? sampleKg : 0.0);
}

/**
 * Precomputes state-invariant bioenergetic scalars into a reusable scratch object
 * so Dijkstra inner loops perform zero redundant trig/pow/object lookups.
 */
export function prepareBioStateConstants(state, out = {}) {
  const windAzRad = state.windAzRad ?? 1.92;
  const windMag = state.layers.meda ? state.windSpeedMs : 0.0;
  const M_total_kg = 82.0 + computeCarriedMassKg(state);

  const spo2_factor = 98.0 / (state.spo2Pct > 82.0 ? state.spo2Pct : 82.0);
  const therm_factor = state.coreTempC > 37.5 ? Math.exp(((state.coreTempC - 37.5) / 10.0) * LN2) : 1.0;
  const co2_factor = state.ppCo2MmHg > 2.5 ? 1.0 + (state.ppCo2MmHg - 2.5) * 0.075 : 1.0;

  out.topo = !!state.layers.topo;
  out.themis = !!state.layers.themis;
  out.rad = !!state.layers.rad;
  out.nominalSpeedMs = state.nominalSpeedMs;
  out.hrBpm = state.hrBpm;
  out.wx = windMag * Math.sin(windAzRad);
  out.wy = -windMag * Math.cos(windAzRad);
  out.levelCoeff = 2.65 * M_total_kg * G_RATIO;
  out.gradeForce = M_total_kg * G_MARS;
  out.spo2_factor = spo2_factor;
  out.therm_factor = therm_factor;
  out.co2_factor = co2_factor;
  out.bioBase = spo2_factor * therm_factor * co2_factor;
  out.invO2Usable = 1.0 / (state.o2ReserveKg - 0.12 > 0.05 ? state.o2ReserveKg - 0.12 : 0.05);
  out.invBattUsable = 1.0 / (state.batteryWh - 90.0 > 25.0 ? state.batteryWh - 90.0 : 25.0);
  out.invKcalUsable = 1.0 / (state.calorieReserveKcal - 250.0 > 40.0 ? state.calorieReserveKcal - 250.0 : 40.0);
  out.invUSvLimit = 1.0 / (state.layers.rad && state.sepStormActive ? 8500.0 : 150000.0);
  return out;
}

const _defaultScratchConst = {};

/**
 * Fast inner-loop edge cost using precomputed `bioConst` and cached DEM edge geometry.
 */
export function computeDirectedEdgeCostFast(fromIdx, toIdx, dem, c, slot) {
  const cacheIdx = fromIdx * 9 + slot;
  const slope_deg = dem._edgeSlopeDeg[cacheIdx];
  if (c.topo && slope_deg > 33.0) {
    return Infinity;
  }

  let eta = 1.15;
  let invSqrtEta = INV_SQRT_115;
  if (c.themis) {
    const tiu = dem.thermalInertia[toIdx];
    if (tiu < 100.0) {
      eta = 1.85;
      invSqrtEta = INV_SQRT_185;
    } else if (tiu < 220.0) {
      eta = 1.35;
      invSqrtEta = INV_SQRT_135;
    } else {
      eta = 1.05;
      invSqrtEta = INV_SQRT_105;
    }
  }

  const dist_m = DIR9_DIST[slot];
  const v_raw = c.nominalSpeedMs * invSqrtEta * dem._edgeToblerExp[cacheIdx];
  const v_ms = v_raw > 0.18 ? v_raw : 0.18;
  const dt_sec = dist_m / v_ms;

  const v_rel_air = v_ms - (c.wx * DIR9_UX[slot] + c.wy * DIR9_UY[slot]);
  const absRelAir = v_rel_air >= 0.0 ? v_rel_air : -v_rel_air;
  const P_aero_w = 0.0088 * v_rel_air * absRelAir * v_ms;

  const dz_m = dem.elevations[toIdx] - dem.elevations[fromIdx];
  const P_level_w = c.levelCoeff * (v_ms * v_ms) * eta;
  let P_grade_w;
  if (dz_m >= 0.0) {
    P_grade_w = (c.gradeForce * (dz_m / dt_sec)) / 0.24;
  } else {
    P_grade_w = Math.abs(c.gradeForce * (dz_m / dt_sec)) * (slope_deg > 10.0 ? 0.32 : -0.08);
  }
  const rawSum = 165.0 + P_level_w + P_grade_w + P_aero_w;
  const E_raw_w = rawSum > 140.0 ? rawSum : 140.0;

  const hrAdd = E_raw_w > 320.0 ? (E_raw_w - 320.0) * 0.085 : 0.0;
  const hr_effective = c.hrBpm + hrAdd < 198.0 ? c.hrBpm + hrAdd : 198.0;
  const hrrRaw = ((hr_effective - 60.0) / 132.0) * 100.0;
  const hrr_pct = hrrRaw < 0.0 ? 0.0 : hrrRaw > 100.0 ? 100.0 : hrrRaw;

  const cv_factor = hrr_pct > 75.0 ? 1.0 + Math.pow((hrr_pct - 75.0) / 25.0, 1.6) * 0.35 : 1.0;
  const E_dot_watts = E_raw_w * cv_factor * c.bioBase;

  const isSunlit = !c.themis || dem.sunLitMask[toIdx] === 1;
  const T_env_K = isSunlit ? 235.0 : 165.0;
  const qRad = isSunlit ? Q_RAD_LIT : Q_RAD_SHAD;
  const convAir = absRelAir > 0.5 ? absRelAir : 0.5;
  const Q_loss_w = qRad + 3.2 * Math.sqrt(convAir) * (268.0 - T_env_K);
  const Q_met_waste_w = 0.80 * E_dot_watts;
  const heatDeficit = Q_loss_w > Q_met_waste_w ? Q_loss_w - Q_met_waste_w : 0.0;
  const heatExcess = Q_met_waste_w > Q_loss_w ? (Q_met_waste_w - Q_loss_w) * 0.28 : 0.0;
  const P_suit_elec_w = 110.0 + heatDeficit + heatExcess;

  const fracO2 = E_dot_watts * 8.28e-8 * dt_sec * c.invO2Usable;
  const fracBatt = P_suit_elec_w * dt_sec * INV_3600 * c.invBattUsable;
  const fracKcal = E_dot_watts * 0.859845 * INV_3600 * dt_sec * c.invKcalUsable;
  const fracRad = (c.rad ? dem.radDoseRate[toIdx] : 9.2) * dt_sec * INV_3600 * c.invUSvLimit;

  let edgeCost = fracO2 > fracBatt ? fracO2 : fracBatt;
  if (fracKcal > edgeCost) edgeCost = fracKcal;
  if (fracRad > edgeCost) edgeCost = fracRad;
  return edgeCost;
}

/**
 * Computes directed fractional resource edge cost from `fromIdx` to `toIdx`.
 * Hot-path function: allocates zero heap objects (0 B/frame GC).
 * Optionally populates `outTelemetry` when provided for UI/audit inspection.
 */
export function computeDirectedEdgeCost(fromIdx, toIdx, dem, state, outTelemetry = null) {
  if (!dem._edgeSlopeDeg) {
    ensureEdgeGeometryCache(dem);
  }

  const fromGx = fromIdx % GRID_N;
  const fromGy = (fromIdx / GRID_N) | 0;
  const toGx = toIdx % GRID_N;
  const toGy = (toIdx / GRID_N) | 0;
  const dx = toGx - fromGx;
  const dy = toGy - fromGy;

  if (outTelemetry === null && dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1 && (dx !== 0 || dy !== 0)) {
    const c = prepareBioStateConstants(state, _defaultScratchConst);
    return computeDirectedEdgeCostFast(fromIdx, toIdx, dem, c, (dy + 1) * 3 + (dx + 1));
  }

  const dz_m = dem.elevations[toIdx] - dem.elevations[fromIdx];
  let dist_m;
  let ux;
  let uy;
  let slope_deg;
  let toblerExp;

  if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1 && (dx !== 0 || dy !== 0)) {
    const slot = (dy + 1) * 3 + (dx + 1);
    const cacheIdx = fromIdx * 9 + slot;
    dist_m = DIR9_DIST[slot];
    ux = DIR9_UX[slot];
    uy = DIR9_UY[slot];
    slope_deg = dem._edgeSlopeDeg[cacheIdx];
    toblerExp = dem._edgeToblerExp[cacheIdx];
  } else {
    dist_m = Math.hypot(dx * CELL_M, dy * CELL_M);
    ux = (dx * CELL_M) / dist_m;
    uy = (dy * CELL_M) / dist_m;
    const theta_rad = Math.atan2(dz_m, dist_m);
    slope_deg = Math.abs(theta_rad) * RAD_TO_DEG;
    toblerExp = Math.exp(-3.5 * Math.abs(Math.tan(theta_rad) + 0.05));
  }

  if (state.layers.topo && slope_deg > 33.0) {
    return Infinity;
  }

  let eta = 1.15;
  let invSqrtEta = INV_SQRT_115;
  if (state.layers.themis) {
    const tiu = dem.thermalInertia[toIdx];
    if (tiu < 100.0) {
      eta = 1.85;
      invSqrtEta = INV_SQRT_185;
    } else if (tiu < 220.0) {
      eta = 1.35;
      invSqrtEta = INV_SQRT_135;
    } else {
      eta = 1.05;
      invSqrtEta = INV_SQRT_105;
    }
  }

  const v_raw = state.nominalSpeedMs * invSqrtEta * toblerExp;
  const v_ms = v_raw > 0.18 ? v_raw : 0.18;
  const dt_sec = dist_m / v_ms;

  const windAzRad = state.windAzRad ?? 1.92;
  const windMag = state.layers.meda ? state.windSpeedMs : 0.0;
  const wx = windMag * Math.sin(windAzRad);
  const wy = -windMag * Math.cos(windAzRad);
  const v_rel_air = v_ms - (wx * ux + wy * uy);
  const P_aero_w = 0.0088 * v_rel_air * Math.abs(v_rel_air) * v_ms;

  const M_total_kg = 82.0 + computeCarriedMassKg(state);

  const P_level_w = 2.65 * M_total_kg * G_RATIO * (v_ms * v_ms) * eta;
  let P_grade_w;
  if (dz_m >= 0.0) {
    P_grade_w = (M_total_kg * G_MARS * (dz_m / dt_sec)) / 0.24;
  } else {
    P_grade_w = Math.abs(M_total_kg * G_MARS * (dz_m / dt_sec)) * (slope_deg > 10.0 ? 0.32 : -0.08);
  }
  const rawSum = 165.0 + P_level_w + P_grade_w + P_aero_w;
  const E_raw_w = rawSum > 140.0 ? rawSum : 140.0;

  const hrAdd = E_raw_w > 320.0 ? (E_raw_w - 320.0) * 0.085 : 0.0;
  const hr_effective = state.hrBpm + hrAdd < 198.0 ? state.hrBpm + hrAdd : 198.0;
  const hrrRaw = ((hr_effective - 60.0) / 132.0) * 100.0;
  const hrr_pct = hrrRaw < 0.0 ? 0.0 : hrrRaw > 100.0 ? 100.0 : hrrRaw;

  const cv_factor = hrr_pct > 75.0 ? 1.0 + Math.pow((hrr_pct - 75.0) / 25.0, 1.6) * 0.35 : 1.0;
  const spo2_factor = 98.0 / (state.spo2Pct > 82.0 ? state.spo2Pct : 82.0);
  const therm_factor = state.coreTempC > 37.5 ? Math.exp(((state.coreTempC - 37.5) / 10.0) * LN2) : 1.0;
  const co2_factor = state.ppCo2MmHg > 2.5 ? 1.0 + (state.ppCo2MmHg - 2.5) * 0.075 : 1.0;
  const bioScalar = cv_factor * spo2_factor * therm_factor * co2_factor;
  const E_dot_watts = E_raw_w * bioScalar;

  const o2_kg_step = E_dot_watts * 8.28e-8 * dt_sec;
  const o2_usable_kg = state.o2ReserveKg - 0.12 > 0.05 ? state.o2ReserveKg - 0.12 : 0.05;

  const isSunlit = !state.layers.themis || dem.sunLitMask[toIdx] === 1;
  const T_env_K = isSunlit ? 235.0 : 165.0;
  const qRad = isSunlit ? Q_RAD_LIT : Q_RAD_SHAD;
  const absRelAir = Math.abs(v_rel_air);
  const convAir = absRelAir > 0.5 ? absRelAir : 0.5;
  const Q_loss_w = qRad + 3.2 * Math.sqrt(convAir) * (268.0 - T_env_K);
  const Q_met_waste_w = 0.80 * E_dot_watts;
  const heatDeficit = Q_loss_w > Q_met_waste_w ? Q_loss_w - Q_met_waste_w : 0.0;
  const heatExcess = Q_met_waste_w > Q_loss_w ? (Q_met_waste_w - Q_loss_w) * 0.28 : 0.0;
  const P_suit_elec_w = 110.0 + heatDeficit + heatExcess;
  const wh_step = P_suit_elec_w * dt_sec * INV_3600;
  const batt_usable_Wh = state.batteryWh - 90.0 > 25.0 ? state.batteryWh - 90.0 : 25.0;

  const kcal_step = E_dot_watts * 0.859845 * INV_3600 * dt_sec;
  const kcal_usable = state.calorieReserveKcal - 250.0 > 40.0 ? state.calorieReserveKcal - 250.0 : 40.0;

  const uSv_step = (state.layers.rad ? dem.radDoseRate[toIdx] : 9.2) * dt_sec * INV_3600;
  const uSv_limit = state.layers.rad && state.sepStormActive ? 8500.0 : 150000.0;

  const fracO2 = o2_kg_step / o2_usable_kg;
  const fracBatt = wh_step / batt_usable_Wh;
  const fracKcal = kcal_step / kcal_usable;
  const fracRad = uSv_step / uSv_limit;

  let edgeCost = fracO2 > fracBatt ? fracO2 : fracBatt;
  if (fracKcal > edgeCost) edgeCost = fracKcal;
  if (fracRad > edgeCost) edgeCost = fracRad;

  if (outTelemetry !== null) {
    outTelemetry.slope_deg = slope_deg;
    outTelemetry.eta = eta;
    outTelemetry.v_ms = v_ms;
    outTelemetry.dt_sec = dt_sec;
    outTelemetry.E_raw_w = E_raw_w;
    outTelemetry.E_dot_watts = E_dot_watts;
    outTelemetry.kcalPerHr = E_dot_watts * 0.859845;
    outTelemetry.hr_effective = hr_effective;
    outTelemetry.hrr_pct = hrr_pct;
    outTelemetry.cv_factor = cv_factor;
    outTelemetry.spo2_factor = spo2_factor;
    outTelemetry.therm_factor = therm_factor;
    outTelemetry.co2_factor = co2_factor;
    outTelemetry.bioScalar = bioScalar;
    outTelemetry.T_env_K = T_env_K;
    outTelemetry.Q_loss_w = Q_loss_w;
    outTelemetry.P_suit_elec_w = P_suit_elec_w;
    outTelemetry.o2_usable_kg = o2_usable_kg;
    outTelemetry.batt_usable_Wh = batt_usable_Wh;
    outTelemetry.kcal_usable = kcal_usable;
    outTelemetry.uSv_limit = uSv_limit;
    outTelemetry.fracO2 = fracO2;
    outTelemetry.fracBatt = fracBatt;
    outTelemetry.fracKcal = fracKcal;
    outTelemetry.fracRad = fracRad;
    outTelemetry.edgeCost = edgeCost;
  }

  return edgeCost;
}

const _revTelemetryScratch = {};

/**
 * Evaluates local physiological triage state for the astronaut's current cell,
 * selecting the peak exertion between the return step and reverse approach step.
 */
export function evaluateLocalBioTelemetry(astroIdx, nextIdx, dem, state, outTelemetry = {}) {
  const targetIdx = nextIdx >= 0 && nextIdx !== astroIdx ? nextIdx : astroIdx > 0 ? astroIdx - 1 : astroIdx + 1;
  computeDirectedEdgeCost(astroIdx, targetIdx, dem, state, outTelemetry);
  if (!Number.isFinite(outTelemetry.edgeCost)) {
    const fallbackIdx = astroIdx > 150 ? astroIdx - 150 : astroIdx + 150;
    computeDirectedEdgeCost(astroIdx, fallbackIdx, dem, state, outTelemetry);
  }
  const revCost = computeDirectedEdgeCost(targetIdx, astroIdx, dem, state, _revTelemetryScratch);
  if (
    Number.isFinite(revCost) &&
    Number.isFinite(_revTelemetryScratch.E_dot_watts) &&
    (!Number.isFinite(outTelemetry.E_dot_watts) || _revTelemetryScratch.E_dot_watts > outTelemetry.E_dot_watts)
  ) {
    Object.assign(outTelemetry, _revTelemetryScratch);
  }
  return outTelemetry;
}
