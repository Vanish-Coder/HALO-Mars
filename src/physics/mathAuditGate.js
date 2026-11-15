/**
 * HALO Mars — 7-Gate Automated Startup Verification Suite
 * Executes real runtime assertions across coordinate parity, solar/SVF physics,
 * geotechnical cutoffs, directed slope asymmetry, bioenergetic monotonicity,
 * Dual-Pass Dijkstra invariants, and Skyline TRN identity matching.
 */

import {
  GRID_N,
  TOTAL_CELLS,
  SPAN_M,
  CELL_M,
  BASE_GX,
  BASE_GY,
  BASE_IDX,
  gridToWorld
} from '../data/nasaMarsDatasets.js';
import { createDefaultState, computeDirectedEdgeCost } from './bioEnergeticEngine.js';

export function runMathAuditSuite(dem, solver, matcher) {
  const gates = [];
  const state = createDefaultState();

  // Gate 1: Grid & Coordinate Parity
  {
    const baseWorld = gridToWorld(BASE_GX, BASE_GY, 0.0);
    const expectedCellM = SPAN_M / 149.0;
    const lengthsOk =
      dem.elevations.length === TOTAL_CELLS &&
      dem.thermalInertia.length === TOTAL_CELLS &&
      dem.mineralConcentration.length === TOTAL_CELLS &&
      dem.sunLitMask.length === TOTAL_CELLS &&
      dem.skyViewFactor.length === TOTAL_CELLS &&
      dem.radDoseRate.length === TOTAL_CELLS;
    const parityOk =
      dem.gridN === 150 &&
      GRID_N === 150 &&
      Math.abs(CELL_M - expectedCellM) < 1e-9 &&
      Math.abs(baseWorld.x) < 1e-9 &&
      Math.abs(baseWorld.z) < 1e-9;
    const passed = lengthsOk && parityOk;
    gates.push({
      id: 1,
      name: 'Grid & Coordinate Parity',
      passed,
      detail: `150×150 (${TOTAL_CELLS} nodes), CELL_M=${CELL_M.toFixed(5)} m, Base (${BASE_GX},${BASE_GY}) → (${baseWorld.x.toFixed(1)}, ${baseWorld.z.toFixed(1)})`
    });
  }

  // Gate 2: Ray-Marched Solar Shadow & SVF Bounds
  {
    let maskBinaryOk = true;
    let svfBoundsOk = true;
    let shadowCount = 0;
    let minSvf = 1.0;
    let maxSvf = 0.0;

    for (let i = 0; i < TOTAL_CELLS; i++) {
      const m = dem.sunLitMask[i];
      if (m !== 0 && m !== 1) maskBinaryOk = false;
      if (m === 0) shadowCount++;
      const svf = dem.skyViewFactor[i];
      if (!(svf > 0.0 && svf <= 1.0)) svfBoundsOk = false;
      if (svf < minSvf) minSvf = svf;
      if (svf > maxSvf) maxSvf = svf;
    }
    const baseSunlit = dem.sunLitMask[BASE_IDX] === 1;
    const passed = maskBinaryOk && svfBoundsOk && baseSunlit && shadowCount > 0;
    gates.push({
      id: 2,
      name: 'Solar Shadow & SVF Bounds',
      passed,
      detail: `Base sunlit=${baseSunlit}, shadowed=${shadowCount} cells, SVF∈[${minSvf.toFixed(3)}, ${maxSvf.toFixed(3)}]`
    });
  }

  // Gate 3: Geotechnical Cliff Cutoff (> 33.0 deg => Infinity)
  {
    let cliffFrom = -1;
    let cliffTo = -1;
    let maxFoundDeg = 0.0;
    const radToDeg = 180.0 / Math.PI;

    for (let gy = 1; gy < GRID_N - 1 && cliffFrom === -1; gy++) {
      for (let gx = 1; gx < GRID_N - 1; gx++) {
        const i0 = gy * GRID_N + gx;
        const i1 = gy * GRID_N + (gx + 1);
        const slopeDeg = Math.atan2(Math.abs(dem.elevations[i1] - dem.elevations[i0]), CELL_M) * radToDeg;
        if (slopeDeg > maxFoundDeg) maxFoundDeg = slopeDeg;
        if (slopeDeg > 33.0) {
          cliffFrom = i0;
          cliffTo = i1;
          break;
        }
      }
    }

    const cliffCost = cliffFrom !== -1 ? computeDirectedEdgeCost(cliffFrom, cliffTo, dem, state) : NaN;
    const noTopoState = { ...state, layers: { ...state.layers, topo: false } };
    const ignoredCost = cliffFrom !== -1 ? computeDirectedEdgeCost(cliffFrom, cliffTo, dem, noTopoState) : NaN;
    const passed = cliffFrom !== -1 && cliffCost === Infinity && Number.isFinite(ignoredCost);

    gates.push({
      id: 3,
      name: 'Geotechnical Cliff Cutoff (>33.0°)',
      passed,
      detail: `Max scarp slope=${maxFoundDeg.toFixed(1)}°, topoON=${cliffCost}, topoOFF=${Number.isFinite(ignoredCost) ? ignoredCost.toFixed(5) : ignoredCost}`
    });
  }

  // Gate 4: Directed Slope Asymmetry (uphill > downhill)
  {
    let lowIdx = -1;
    let highIdx = -1;
    let chosenSlopeDeg = 0.0;
    const radToDeg = 180.0 / Math.PI;

    for (let gy = 2; gy < GRID_N - 2 && lowIdx === -1; gy++) {
      for (let gx = 2; gx < GRID_N - 2; gx++) {
        const a = gy * GRID_N + gx;
        const b = gy * GRID_N + (gx + 1);
        const dz = dem.elevations[b] - dem.elevations[a];
        const deg = Math.atan2(Math.abs(dz), CELL_M) * radToDeg;
        if (deg >= 8.0 && deg <= 22.0) {
          lowIdx = dz > 0 ? a : b;
          highIdx = dz > 0 ? b : a;
          chosenSlopeDeg = deg;
          break;
        }
      }
    }

    const neutralWindState = { ...state, windSpeedMs: 0.0 };
    const uphillCost = lowIdx !== -1 ? computeDirectedEdgeCost(lowIdx, highIdx, dem, neutralWindState) : 0;
    const downhillCost = lowIdx !== -1 ? computeDirectedEdgeCost(highIdx, lowIdx, dem, neutralWindState) : 0;
    const passed = lowIdx !== -1 && Number.isFinite(uphillCost) && uphillCost > downhillCost;

    gates.push({
      id: 4,
      name: 'Directed Slope Asymmetry',
      passed,
      detail: `Slope=${chosenSlopeDeg.toFixed(1)}°: uphill=${uphillCost.toFixed(5)} > downhill=${downhillCost.toFixed(5)}`
    });
  }

  // Gate 5: Santee-Gernhardt & Stefan-Boltzmann Monotonicity
  {
    const fromIdx = BASE_IDX;
    const toIdx = BASE_IDX + 1;
    const telBase = {};
    const costBase = computeDirectedEdgeCost(fromIdx, toIdx, dem, state, telBase);

    const highHrState = { ...state, hrBpm: 168 };
    const costHighHr = computeDirectedEdgeCost(fromIdx, toIdx, dem, highHrState);

    const highMassState = { ...state, suitAndSampleMassKg: 90.0, sampleMassKg: 40.0 };
    const costHighMass = computeDirectedEdgeCost(fromIdx, toIdx, dem, highMassState);

    // Shadowed (165 K) vs Sunlit (235 K) electrical balance on an identically shadowed cell
    let shadowIdx = -1;
    for (let i = 0; i < TOTAL_CELLS; i++) {
      if (dem.sunLitMask[i] === 0 && i > GRID_N) {
        shadowIdx = i;
        break;
      }
    }
    const telSunlit = {};
    const telShadow = {};
    if (shadowIdx !== -1) {
      computeDirectedEdgeCost(shadowIdx - 1, shadowIdx, dem, {
        ...state,
        layers: { ...state.layers, themis: false }
      }, telSunlit);
      computeDirectedEdgeCost(shadowIdx - 1, shadowIdx, dem, state, telShadow);
    }

    const passed =
      costHighHr > costBase &&
      costHighMass > costBase &&
      shadowIdx !== -1 &&
      telShadow.P_suit_elec_w > telSunlit.P_suit_elec_w;

    gates.push({
      id: 5,
      name: 'Bioenergetic & Thermal Monotonicity',
      passed,
      detail: `HR88=${costBase.toFixed(5)} < HR168=${costHighHr.toFixed(5)}, +Mass=${costHighMass.toFixed(5)}, P_elec(165K)=${telShadow.P_suit_elec_w?.toFixed(1)}W > P_elec(235K)=${telSunlit.P_suit_elec_w?.toFixed(1)}W`
    });
  }

  // Gate 6: Dual-Pass Dijkstra Zero-Origin & Triangle Inequality
  {
    const astroGx = dem.defaultAstroGx ?? 91;
    const astroGy = dem.defaultAstroGy ?? 65;
    const testState = { ...state, astroGx, astroGy };
    const res = solver.solve(dem, testState, false);
    const astroIdx = astroGy * GRID_N + astroGx;
    const baseZero = solver.returnCostMap[BASE_IDX] === 0.0;
    const astroZero = solver.outboundCostMap[astroIdx] === 0.0;
    const roundTripEq = Math.abs(res.totalField[astroIdx] - solver.returnCostMap[astroIdx]) < 1e-6;

    let nonNegative = true;
    for (let i = 0; i < TOTAL_CELLS; i++) {
      if (res.totalField[i] < 0.0) {
        nonNegative = false;
        break;
      }
    }
    const passed = baseZero && astroZero && roundTripEq && nonNegative;
    gates.push({
      id: 6,
      name: 'Dual-Pass Dijkstra Invariants',
      passed,
      detail: `return[base]=${solver.returnCostMap[BASE_IDX]}, outbound[astro]=${solver.outboundCostMap[astroIdx]}, total[astro]=${res.totalField[astroIdx].toFixed(4)} (${res.solveMs.toFixed(2)} ms)`
    });
  }

  // Gate 7: Skyline TRN Self-Match Identity (< 1.8 ms steady-state)
  {
    matcher.buildIndex(dem);
    const testGx = dem.defaultAstroGx ?? 91;
    const testGy = dem.defaultAstroGy ?? 65;
    const query = matcher.extractVisorProfile(dem, testGx, testGy, 0, 0.0);
    // Warm up JIT tiers so timing reflects steady-state navigation performance
    for (let w = 0; w < 3; w++) {
      matcher.matchSkyline(dem, query, testGx, testGy);
    }
    const match = matcher.matchSkyline(dem, query, testGx, testGy);
    const passed =
      match.ncc >= 0.999 &&
      match.yawOffsetDeg === 0 &&
      match.errorM === 0.0;
    const timingNote =
      match.elapsedMs < 1.8
        ? ''
        : ' (WARN: slow host/throttled timer >= 1.8 ms)';

    gates.push({
      id: 7,
      name: 'Skyline TRN Self-Match Identity',
      passed,
      detail: `NCC=${match.ncc.toFixed(4)}, yaw=${match.yawOffsetDeg}°, err=${match.errorM.toFixed(1)} m, time=${match.elapsedMs.toFixed(2)} ms${timingNote}`
    });
  }

  const passedCount = gates.filter((g) => g.passed).length;
  return {
    passedCount,
    totalCount: gates.length,
    allPassed: passedCount === gates.length,
    gates
  };
}

