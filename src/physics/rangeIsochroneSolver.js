/**
 * HALO Mars — Dual-Pass Directed Dijkstra & 16-Case Marching Squares (Module C)
 * Preallocates all typed arrays once at construction (0 B/frame GC in hot loops).
 */

import {
  computeDirectedEdgeCostFast,
  ensureEdgeGeometryCache,
  prepareBioStateConstants
} from './bioEnergeticEngine.js';

const GRID_N = 150;
const TOTAL_CELLS = GRID_N * GRID_N;
const CELL_M = 10000.0 / 149.0;
const BASE_GX = 75;
const BASE_GY = 75;
const BASE_IDX = BASE_GY * GRID_N + BASE_GX;
const OVERLAY_Y_OFFSET = 16.0;
const MAX_RETURN_PATH_STEPS = 500;

const NEIGHBOR_DX = new Int8Array([-1, 0, 1, -1, 1, -1, 0, 1]);
const NEIGHBOR_DY = new Int8Array([-1, -1, -1, 0, 0, 1, 1, 1]);
// Precomputed slot9 for Pass 1 (nIdx -> currIdx: -dx, -dy) and Pass 2 (currIdx -> nIdx: +dx, +dy)
const PASS1_SLOT9 = new Int8Array(8);
const PASS2_SLOT9 = new Int8Array(8);
for (let d = 0; d < 8; d++) {
  const dx = NEIGHBOR_DX[d];
  const dy = NEIGHBOR_DY[d];
  PASS1_SLOT9[d] = (-dy + 1) * 3 + (-dx + 1);
  PASS2_SLOT9[d] = (dy + 1) * 3 + (dx + 1);
}

/**
 * Pre-allocated zero-GC binary min-heap keyed on node index [0..22499].
 */
export class FlatBinaryMinHeap {
  constructor(capacity = TOTAL_CELLS) {
    this.capacity = capacity;
    this.heapNodes = new Int32Array(capacity);
    this.heapPriorities = new Float32Array(capacity);
    this.heapPos = new Int32Array(capacity);
    this.size = 0;
    this.heapPos.fill(-1);
  }

  reset() {
    for (let i = 0; i < this.size; i++) {
      this.heapPos[this.heapNodes[i]] = -1;
    }
    this.size = 0;
  }

  pushOrDecrease(node, priority) {
    let idx = this.heapPos[node];
    if (idx === -1) {
      idx = this.size++;
      this.heapNodes[idx] = node;
      this.heapPriorities[idx] = priority;
      this.heapPos[node] = idx;
      this._siftUp(idx);
    } else if (priority < this.heapPriorities[idx]) {
      this.heapPriorities[idx] = priority;
      this._siftUp(idx);
    }
  }

  popMin() {
    if (this.size === 0) return -1;
    const minNode = this.heapNodes[0];
    this.heapPos[minNode] = -1;
    const lastIdx = --this.size;
    if (lastIdx > 0) {
      const movedNode = this.heapNodes[lastIdx];
      this.heapNodes[0] = movedNode;
      this.heapPriorities[0] = this.heapPriorities[lastIdx];
      this.heapPos[movedNode] = 0;
      this._siftDown(0);
    }
    return minNode;
  }

  _siftUp(idx) {
    const node = this.heapNodes[idx];
    const prio = this.heapPriorities[idx];
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      const parentPrio = this.heapPriorities[parentIdx];
      if (prio >= parentPrio) break;
      const parentNode = this.heapNodes[parentIdx];
      this.heapNodes[idx] = parentNode;
      this.heapPriorities[idx] = parentPrio;
      this.heapPos[parentNode] = idx;
      idx = parentIdx;
    }
    this.heapNodes[idx] = node;
    this.heapPriorities[idx] = prio;
    this.heapPos[node] = idx;
  }

  _siftDown(idx) {
    const half = this.size >> 1;
    const node = this.heapNodes[idx];
    const prio = this.heapPriorities[idx];

    while (idx < half) {
      let childIdx = (idx << 1) + 1;
      let childPrio = this.heapPriorities[childIdx];
      const rightIdx = childIdx + 1;
      if (rightIdx < this.size && this.heapPriorities[rightIdx] < childPrio) {
        childIdx = rightIdx;
        childPrio = this.heapPriorities[rightIdx];
      }
      if (prio <= childPrio) break;
      const childNode = this.heapNodes[childIdx];
      this.heapNodes[idx] = childNode;
      this.heapPriorities[idx] = childPrio;
      this.heapPos[childNode] = idx;
      idx = childIdx;
    }
    this.heapNodes[idx] = node;
    this.heapPriorities[idx] = prio;
    this.heapPos[node] = idx;
  }
}

function writeInterpolatedEdge(
  edgeId,
  threshold,
  v00,
  v10,
  v11,
  v01,
  x0,
  x1,
  z0,
  z1,
  e00,
  e10,
  e11,
  e01,
  outSegments,
  slotOffset
) {
  let t;
  if (edgeId === 0) {
    const denom = v10 - v00;
    t = Math.abs(denom) > 1e-6 ? (threshold - v00) / denom : 0.5;
    t = t < 0.0 ? 0.0 : t > 1.0 ? 1.0 : t;
    outSegments[slotOffset] = x0 + t * (x1 - x0);
    outSegments[slotOffset + 1] = e00 + t * (e10 - e00) + OVERLAY_Y_OFFSET;
    outSegments[slotOffset + 2] = z0;
  } else if (edgeId === 1) {
    const denom = v11 - v10;
    t = Math.abs(denom) > 1e-6 ? (threshold - v10) / denom : 0.5;
    t = t < 0.0 ? 0.0 : t > 1.0 ? 1.0 : t;
    outSegments[slotOffset] = x1;
    outSegments[slotOffset + 1] = e10 + t * (e11 - e10) + OVERLAY_Y_OFFSET;
    outSegments[slotOffset + 2] = z0 + t * (z1 - z0);
  } else if (edgeId === 2) {
    const denom = v01 - v11;
    t = Math.abs(denom) > 1e-6 ? (threshold - v11) / denom : 0.5;
    t = t < 0.0 ? 0.0 : t > 1.0 ? 1.0 : t;
    outSegments[slotOffset] = x1 + t * (x0 - x1);
    outSegments[slotOffset + 1] = e11 + t * (e01 - e11) + OVERLAY_Y_OFFSET;
    outSegments[slotOffset + 2] = z1;
  } else {
    const denom = v00 - v01;
    t = Math.abs(denom) > 1e-6 ? (threshold - v01) / denom : 0.5;
    t = t < 0.0 ? 0.0 : t > 1.0 ? 1.0 : t;
    outSegments[slotOffset] = x0;
    outSegments[slotOffset + 1] = e01 + t * (e00 - e01) + OVERLAY_Y_OFFSET;
    outSegments[slotOffset + 2] = z1 + t * (z0 - z1);
  }
}

function buildPass1CacheKey(dem, state) {
  const l = state.layers;
  return `${dem.id}|${state.hrBpm}|${state.suitMassKg}|${state.sampleMassKg}|${state.suitAndSampleMassKg}|${state.calorieReserveKcal}|${state.o2ReserveKg}|${state.batteryWh}|${state.nominalSpeedMs}|${state.windSpeedMs}|${state.windAzRad}|${state.spo2Pct}|${state.coreTempC}|${state.ppCo2MmHg}|${state.sepStormActive ? 1 : 0}|${l.topo ? 1 : 0}${l.themis ? 1 : 0}${l.crism ? 1 : 0}${l.meda ? 1 : 0}${l.rad ? 1 : 0}`;
}

export class RangeIsochroneSolver {
  constructor() {
    this.heap = new FlatBinaryMinHeap(TOTAL_CELLS);
    this.returnCostMap = new Float32Array(TOTAL_CELLS);
    this.outboundCostMap = new Float32Array(TOTAL_CELLS);
    this.totalField = new Float32Array(TOTAL_CELLS);
    this.returnParentMap = new Int32Array(TOTAL_CELLS);
    this.returnPathIndices = new Int32Array(MAX_RETURN_PATH_STEPS + 1);
    this.returnPathLength = 0;

    const maxSegFloats = (GRID_N - 1) * (GRID_N - 1) * 2 * 6;
    this.contour100Segments = new Float32Array(maxSegFloats);
    this.contour100FloatCount = 0;
    this.contour075Segments = new Float32Array(maxSegFloats);
    this.contour075FloatCount = 0;

    this.safeCellCount = 0;
    this.cautionCellCount = 0;
    this.lastSolveMs = 0.0;
    this._lastPass1Key = '';
    this._bioConst = {};

    this._scratchState = {
      siteId: '',
      activeLayer: 'topo',
      astroGx: 75,
      astroGy: 75,
      hrBpm: 88,
      suitMassKg: 50,
      sampleMassKg: 15,
      suitAndSampleMassKg: 65,
      calorieReserveKcal: 1150,
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
      layers: { topo: true, themis: true, crism: true, meda: true, rad: true }
    };
  }

  invalidateCache() {
    this._lastPass1Key = '';
  }

  /**
   * Executes Pass 1 (Return to Base, cached across pin drags) & Pass 2 (Outbound from Astronaut),
   * computes combined round-trip totalField, traces return path, and extracts T=0.75 & T=1.0 contours.
   */
  solve(dem, state, extractContours = true, forcePass1 = false) {
    ensureEdgeGeometryCache(dem);
    const t0 = performance.now();
    const baseIdx = dem.baseIdx ?? BASE_IDX;
    const astroGx = Math.max(0, Math.min(GRID_N - 1, state.astroGx | 0));
    const astroGy = Math.max(0, Math.min(GRID_N - 1, state.astroGy | 0));
    const astroIdx = astroGy * GRID_N + astroGx;

    const returnCost = this.returnCostMap;
    const returnParent = this.returnParentMap;
    const outboundCost = this.outboundCostMap;
    const totalField = this.totalField;
    const heap = this.heap;
    const bioConst = prepareBioStateConstants(state, this._bioConst);

    // Pass 1: Return Cost Map (reverse direction nIdx -> currIdx toward Base)
    const pass1Key = buildPass1CacheKey(dem, state);
    if (forcePass1 || pass1Key !== this._lastPass1Key) {
      returnCost.fill(Infinity);
      returnParent.fill(-1);
      heap.reset();
      returnCost[baseIdx] = 0.0;
      heap.pushOrDecrease(baseIdx, 0.0);

      while (heap.size > 0) {
        const currIdx = heap.popMin();
        const currCost = returnCost[currIdx];

        const cx = currIdx % GRID_N;
        const cy = (currIdx / GRID_N) | 0;

        for (let d = 0; d < 8; d++) {
          const nx = cx + NEIGHBOR_DX[d];
          const ny = cy + NEIGHBOR_DY[d];
          if (nx < 0 || nx >= GRID_N || ny < 0 || ny >= GRID_N) continue;
          const nIdx = ny * GRID_N + nx;

          const stepCost = computeDirectedEdgeCostFast(nIdx, currIdx, dem, bioConst, PASS1_SLOT9[d]);
          if (stepCost === Infinity) continue;

          const alt = currCost + stepCost;
          if (alt < returnCost[nIdx]) {
            returnCost[nIdx] = alt;
            returnParent[nIdx] = currIdx;
            heap.pushOrDecrease(nIdx, alt);
          }
        }
      }
      this._lastPass1Key = pass1Key;
    }

    // Pass 2: Outbound Cost Map (forward direction currIdx -> nIdx from Astronaut)
    outboundCost.fill(Infinity);
    heap.reset();
    outboundCost[astroIdx] = 0.0;
    heap.pushOrDecrease(astroIdx, 0.0);

    while (heap.size > 0) {
      const currIdx = heap.popMin();
      const currCost = outboundCost[currIdx];

      const cx = currIdx % GRID_N;
      const cy = (currIdx / GRID_N) | 0;

      for (let d = 0; d < 8; d++) {
        const nx = cx + NEIGHBOR_DX[d];
        const ny = cy + NEIGHBOR_DY[d];
        if (nx < 0 || nx >= GRID_N || ny < 0 || ny >= GRID_N) continue;
        const nIdx = ny * GRID_N + nx;

        const stepCost = computeDirectedEdgeCostFast(currIdx, nIdx, dem, bioConst, PASS2_SLOT9[d]);
        if (stepCost === Infinity) continue;

        const alt = currCost + stepCost;
        if (alt < outboundCost[nIdx]) {
          outboundCost[nIdx] = alt;
          heap.pushOrDecrease(nIdx, alt);
        }
      }
    }

    // Combined Round-Trip Field
    let safeCount = 0;
    let cautionCount = 0;
    for (let i = 0; i < TOTAL_CELLS; i++) {
      const sum = outboundCost[i] + returnCost[i];
      totalField[i] = sum;
      if (sum <= 0.75) {
        safeCount++;
      } else if (sum <= 1.0) {
        cautionCount++;
      }
    }
    this.safeCellCount = safeCount;
    this.cautionCellCount = cautionCount;

    // Exact Return Path Backtrace from Astronaut -> Base via returnParentMap (cap 500 steps)
    let pathLen = 0;
    let cur = astroIdx;
    while (cur !== -1 && pathLen < MAX_RETURN_PATH_STEPS) {
      this.returnPathIndices[pathLen++] = cur;
      if (cur === baseIdx) break;
      cur = returnParent[cur];
    }
    this.returnPathLength = pathLen;

    if (extractContours) {
      if (safeCount + cautionCount > 0) {
        this.contour100FloatCount = this.extractMarchingSquaresSegments(
          totalField,
          1.0,
          dem,
          this.contour100Segments
        );
        this.contour075FloatCount = this.extractMarchingSquaresSegments(
          totalField,
          0.75,
          dem,
          this.contour075Segments
        );
      } else {
        this.contour100FloatCount = 0;
        this.contour075FloatCount = 0;
      }
      // When the astronaut steps outside the safe return envelope (totalField > 1.0 everywhere),
      // project the base returnCost boundary so the glowing red turnaround ring stays visible.
      if (this.contour100FloatCount === 0 && safeCount + cautionCount === 0) {
        this.contour100FloatCount = this.extractMarchingSquaresSegments(
          returnCost,
          1.0,
          dem,
          this.contour100Segments
        );
        this.contour075FloatCount = this.extractMarchingSquaresSegments(
          returnCost,
          0.75,
          dem,
          this.contour075Segments
        );
      }
    }

    this.lastSolveMs = performance.now() - t0;
    return {
      totalField,
      returnCostMap: returnCost,
      outboundCostMap: outboundCost,
      returnParentMap: returnParent,
      astroIdx,
      safeCellCount: safeCount,
      cautionCellCount: cautionCount,
      reachableCellCount: safeCount + cautionCount,
      solveMs: this.lastSolveMs
    };
  }

  /**
   * Complete 16-case Marching Squares with bilinear saddle disambiguation (cases 5 & 10).
   * Zero inner-loop closures or heap allocations.
   */
  extractMarchingSquaresSegments(field, threshold, dem, outSegments) {
    const elevs = dem.elevations;
    const capVal = threshold + 1.5 > 4.0 ? threshold + 1.5 : 4.0;
    let writeIdx = 0;

    for (let gy = 0; gy < GRID_N - 1; gy++) {
      const row0 = gy * GRID_N;
      const row1 = row0 + GRID_N;
      const z0 = (gy - BASE_GY) * CELL_M;
      const z1 = z0 + CELL_M;

      for (let gx = 0; gx < GRID_N - 1; gx++) {
        const i00 = row0 + gx;
        const i10 = i00 + 1;
        const i01 = row1 + gx;
        const i11 = i01 + 1;

        const r00 = field[i00];
        const r10 = field[i10];
        const r11 = field[i11];
        const r01 = field[i01];

        const mask =
          (r00 <= threshold ? 1 : 0) |
          (r10 <= threshold ? 2 : 0) |
          (r11 <= threshold ? 4 : 0) |
          (r01 <= threshold ? 8 : 0);

        if (mask === 0 || mask === 15) continue;

        const v00 = r00 < capVal ? r00 : capVal;
        const v10 = r10 < capVal ? r10 : capVal;
        const v11 = r11 < capVal ? r11 : capVal;
        const v01 = r01 < capVal ? r01 : capVal;

        const x0 = (gx - BASE_GX) * CELL_M;
        const x1 = x0 + CELL_M;

        const e00 = elevs[i00];
        const e10 = elevs[i10];
        const e11 = elevs[i11];
        const e01 = elevs[i01];

        let eA1 = -1;
        let eB1 = -1;
        let eA2 = -1;
        let eB2 = -1;

        switch (mask) {
          case 1:
          case 14:
            eA1 = 3;
            eB1 = 0;
            break;
          case 2:
          case 13:
            eA1 = 0;
            eB1 = 1;
            break;
          case 3:
          case 12:
            eA1 = 3;
            eB1 = 1;
            break;
          case 4:
          case 11:
            eA1 = 1;
            eB1 = 2;
            break;
          case 6:
          case 9:
            eA1 = 0;
            eB1 = 2;
            break;
          case 7:
          case 8:
            eA1 = 3;
            eB1 = 2;
            break;
          case 5: {
            const vCenter = 0.25 * (v00 + v10 + v11 + v01);
            if (vCenter <= threshold) {
              eA1 = 3;
              eB1 = 2;
              eA2 = 0;
              eB2 = 1;
            } else {
              eA1 = 3;
              eB1 = 0;
              eA2 = 1;
              eB2 = 2;
            }
            break;
          }
          case 10: {
            const vCenter = 0.25 * (v00 + v10 + v11 + v01);
            if (vCenter <= threshold) {
              eA1 = 3;
              eB1 = 0;
              eA2 = 1;
              eB2 = 2;
            } else {
              eA1 = 0;
              eB1 = 1;
              eA2 = 3;
              eB2 = 2;
            }
            break;
          }
        }

        if (eA1 !== -1) {
          writeInterpolatedEdge(
            eA1,
            threshold,
            v00,
            v10,
            v11,
            v01,
            x0,
            x1,
            z0,
            z1,
            e00,
            e10,
            e11,
            e01,
            outSegments,
            writeIdx
          );
          writeInterpolatedEdge(
            eB1,
            threshold,
            v00,
            v10,
            v11,
            v01,
            x0,
            x1,
            z0,
            z1,
            e00,
            e10,
            e11,
            e01,
            outSegments,
            writeIdx + 3
          );
          writeIdx += 6;
        }
        if (eA2 !== -1) {
          writeInterpolatedEdge(
            eA2,
            threshold,
            v00,
            v10,
            v11,
            v01,
            x0,
            x1,
            z0,
            z1,
            e00,
            e10,
            e11,
            e01,
            outSegments,
            writeIdx
          );
          writeInterpolatedEdge(
            eB2,
            threshold,
            v00,
            v10,
            v11,
            v01,
            x0,
            x1,
            z0,
            z1,
            e00,
            e10,
            e11,
            e01,
            outSegments,
            writeIdx + 3
          );
          writeIdx += 6;
        }
      }
    }

    return writeIdx;
  }

  /**
   * Computes exact Hero Status Card metrics (margin %, km to turnaround, kcal & O2 deficits).
   */
  computeHeroMetrics(state) {
    const astroGx = Math.max(0, Math.min(GRID_N - 1, state.astroGx | 0));
    const astroGy = Math.max(0, Math.min(GRID_N - 1, state.astroGy | 0));
    const astroIdx = astroGy * GRID_N + astroGx;
    const fieldVal = this.totalField[astroIdx];
    const safeFieldVal = Number.isFinite(fieldVal) ? fieldVal : 2.5;

    const kcalUsable = Math.max(40.0, state.calorieReserveKcal - 250.0);
    const marginPct = Math.max(0, Math.round((1.0 - safeFieldVal) * 100));
    const kcalDeficit = Math.max(0, Math.round((safeFieldVal - 1.0) * kcalUsable));
    const o2DeficitPct = Math.max(0, Math.round((safeFieldVal - 1.0) * 100));

    const ax = (astroGx - BASE_GX) * CELL_M;
    const az = (astroGy - BASE_GY) * CELL_M;
    const rLen = Math.hypot(ax, az);
    const dirX = rLen > 1.0 ? ax / rLen : 0.70710678;
    const dirZ = rLen > 1.0 ? az / rLen : -0.70710678;

    let bestForwardM = Infinity;
    let bestNearestM = Infinity;
    const segs = this.contour100Segments;
    const count = this.contour100FloatCount;

    for (let i = 0; i < count; i += 6) {
      const sx = segs[i];
      const sz = segs[i + 2];
      const ex = segs[i + 3];
      const ez = segs[i + 5];

      const midX = 0.5 * (sx + ex) - ax;
      const midZ = 0.5 * (sz + ez) - az;
      const d = Math.hypot(midX, midZ);
      if (d < bestNearestM) bestNearestM = d;

      const rx = ex - sx;
      const rz = ez - sz;
      const denom = dirX * rz - dirZ * rx;
      if (Math.abs(denom) > 1e-6) {
        const qpx = sx - ax;
        const qpz = sz - az;
        const tRay = (qpx * rz - qpz * rx) / denom;
        const uSeg = (qpx * dirZ - qpz * dirX) / denom;
        if (tRay >= 0.0 && uSeg >= -0.05 && uSeg <= 1.05 && tRay < bestForwardM) {
          bestForwardM = tRay;
        }
      }
    }

    let turnaroundDistKm = 0.0;
    if (safeFieldVal <= 1.0) {
      if (Number.isFinite(bestForwardM)) {
        turnaroundDistKm = bestForwardM / 1000.0;
      } else if (Number.isFinite(bestNearestM)) {
        turnaroundDistKm = bestNearestM / 1000.0;
      }
    }

    let status = 'SAFE';
    if (safeFieldVal > 1.0) {
      status = 'EXCEEDED';
    } else if (safeFieldVal > 0.75) {
      status = 'CAUTION';
    }

    return {
      status,
      fieldValue: safeFieldVal,
      marginPct,
      turnaroundDistKm,
      kcalDeficit,
      o2DeficitPct
    };
  }

  /**
   * Computes single-layer counterfactual safe-area attribution badges (§2.5).
   * Restores the active state's solver buffers at completion.
   */
  computeLayerAttributions(dem, state) {
    let blockedCliffCells = 0;
    const slopes = dem.maxSlopeDeg;
    if (slopes) {
      for (let i = 0; i < TOTAL_CELLS; i++) {
        if (slopes[i] > 33.0) blockedCliffCells++;
      }
    }

    const s = this._scratchState;
    Object.assign(s, state);
    s.layers = { ...state.layers };

    const baseline = this.solve(dem, s, false, true);
    const nBase = Math.max(1, baseline.reachableCellCount);

    const calcCounterfactualPct = (layerKey) => {
      const prevVal = s.layers[layerKey];
      s.layers[layerKey] = !prevVal;
      const alt = this.solve(dem, s, false, true);
      s.layers[layerKey] = prevVal;

      const nAlt = Math.max(1, alt.reachableCellCount);
      if (prevVal) {
        return Math.round(((nBase - nAlt) / nAlt) * 100);
      }
      return Math.round(((nAlt - nBase) / nBase) * 100);
    };

    const themisPct = calcCounterfactualPct('themis');
    const crismPct = calcCounterfactualPct('crism');
    const medaPct = calcCounterfactualPct('meda');
    const radPct = calcCounterfactualPct('rad');

    // Restore active state's exact field, return path, and Marching Squares contours
    this.solve(dem, state, true, true);

    const sampleLoadKg = state.sampleMassKg ?? Math.max(0, (state.suitAndSampleMassKg ?? 65) - 50);
    const fmtSignedPct = (pct) => (pct > 0 ? `+${pct}%` : `${pct}%`);

    return {
      topo: state.layers.topo
        ? `>33° Cliffs: ${blockedCliffCells} Blocked`
        : `Cliffs OFF (${blockedCliffCells} Ignored)`,
      themis: state.layers.themis
        ? `THEMIS Sand: ${fmtSignedPct(themisPct)} Area`
        : `THEMIS OFF (${fmtSignedPct(themisPct)} Area)`,
      crism: state.layers.crism
        ? `Samples (+${Math.round(sampleLoadKg)}kg): ${fmtSignedPct(crismPct)} Area`
        : `Sample Load OFF`,
      meda: state.layers.meda
        ? `MEDA Wind: ${fmtSignedPct(medaPct)} Area`
        : `Wind OFF (${fmtSignedPct(medaPct)} Area)`,
      rad: state.layers.rad
        ? state.sepStormActive
          ? `SEP Storm: ${fmtSignedPct(radPct)} Area`
          : `RAD Nominal (${fmtSignedPct(radPct)} Area)`
        : `RAD/DONKI OFF`
    };
  }

  /**
   * Exports the live T=1.0 & T=0.75 Marching Squares safe return contours, optimal return corridor,
   * and base/astronaut markers as an RFC 7946 GeoJSON FeatureCollection for QGIS / JPL MMGIS.
   * @param {object} dem
   * @param {object} state
   * @param {object | null} [heroMetrics]
   */
  exportSafeReturnGeoJson(dem, state, heroMetrics = null) {
    const features = [];

    const pushContourFeature = (segments, floatCount, threshold, label, classification) => {
      const lines = [];
      for (let i = 0; i + 5 < floatCount; i += 6) {
        lines.push([
          localMetersToPlanetocentric(segments[i], segments[i + 2], dem),
          localMetersToPlanetocentric(segments[i + 3], segments[i + 5], dem)
        ]);
      }
      features.push({
        type: 'Feature',
        properties: {
          name: label,
          classification,
          threshold_t: threshold,
          segmentCount: lines.length,
          siteId: dem.id
        },
        geometry: {
          type: 'MultiLineString',
          coordinates: lines
        }
      });
    };

    pushContourFeature(
      this.contour100Segments,
      this.contour100FloatCount,
      1.0,
      'Safe Return Perimeter (T = 1.0)',
      'SAFE_RETURN_LIMIT'
    );
    pushContourFeature(
      this.contour075Segments,
      this.contour075FloatCount,
      0.75,
      'Nominal Return Margin (T = 0.75)',
      'CAUTION_RETURN_LIMIT'
    );

    const routeCoords = [];
    for (let i = 0; i < this.returnPathLength; i++) {
      const idx = this.returnPathIndices[i];
      const gx = idx % GRID_N;
      const gy = Math.floor(idx / GRID_N);
      routeCoords.push(
        localMetersToPlanetocentric((gx - BASE_GX) * CELL_M, (gy - BASE_GY) * CELL_M, dem)
      );
    }
    if (routeCoords.length >= 2) {
      features.push({
        type: 'Feature',
        properties: {
          name: 'Optimal Safe Return Corridor',
          classification: 'RETURN_CORRIDOR',
          waypointCount: routeCoords.length,
          status: heroMetrics?.status ?? 'UNKNOWN',
          limitingFactor: heroMetrics?.limitingFactor ?? 'UNKNOWN',
          marginPct: heroMetrics?.marginPct ?? null
        },
        geometry: {
          type: 'LineString',
          coordinates: routeCoords
        }
      });
    }

    features.push({
      type: 'Feature',
      properties: {
        name: 'Habitat / Pressurized Rover Base',
        role: 'BASE_CAMP',
        gx: BASE_GX,
        gy: BASE_GY
      },
      geometry: {
        type: 'Point',
        coordinates: localMetersToPlanetocentric(0, 0, dem)
      }
    });

    features.push({
      type: 'Feature',
      properties: {
        name: 'Astronaut EVA Location',
        role: 'EVA_PIN',
        gx: state.astroGx,
        gy: state.astroGy,
        hrBpm: state.hrBpm,
        sepStormActive: Boolean(state.sepStormActive),
        status: heroMetrics?.status ?? 'UNKNOWN',
        posrRatio: heroMetrics?.posrRatio ?? null
      },
      geometry: {
        type: 'Point',
        coordinates: localMetersToPlanetocentric(
          (state.astroGx - BASE_GX) * CELL_M,
          (state.astroGy - BASE_GY) * CELL_M,
          dem
        )
      }
    });

    return JSON.stringify(
      {
        type: 'FeatureCollection',
        name: `HALO_Mars_${dem.id}_SafeReturn`,
        metadata: {
          generator: 'HALO Mars EVA Telemetry & Planner',
          exportedAtUtc: new Date().toISOString(),
          planetaryBody: 'Mars (IAU R=3389500m Planetocentric)',
          siteId: dem.id,
          siteName: dem.name,
          sourceFormat: dem.sourceFormat ?? 'PDS Surrogate',
          originLat: dem.originLat ?? 0,
          originLon: dem.originLon ?? 0,
          status: heroMetrics?.status ?? null,
          limitingFactor: heroMetrics?.limitingFactor ?? null,
          marginPct: heroMetrics?.marginPct ?? null
        },
        features
      },
      null,
      2
    );
  }

  /**
   * Exports the backtraced optimal return corridor waypoints as a standard GPX 1.1 <rte> XML document.
   * @param {object} dem
   * @param {object} state
   */
  exportReturnCorridorGpx(dem, state) {
    const timestamp = new Date().toISOString();
    const basePt = localMetersToPlanetocentric(0, 0, dem);
    const astroPt = localMetersToPlanetocentric(
      (state.astroGx - BASE_GX) * CELL_M,
      (state.astroGy - BASE_GY) * CELL_M,
      dem
    );

    const routePts = [];
    if (this.returnPathLength >= 2) {
      for (let i = 0; i < this.returnPathLength; i++) {
        const idx = this.returnPathIndices[i];
        const gx = idx % GRID_N;
        const gy = Math.floor(idx / GRID_N);
        routePts.push(
          localMetersToPlanetocentric((gx - BASE_GX) * CELL_M, (gy - BASE_GY) * CELL_M, dem)
        );
      }
    } else {
      routePts.push(astroPt, basePt);
    }

    const rteptXml = routePts
      .map(
        ([lon, lat, elev], i) =>
          `      <rtept lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">\n        <ele>${elev.toFixed(1)}</ele>\n        <name>BR-RET-${String(i + 1).padStart(3, '0')}</name>\n      </rtept>`
      )
      .join('\n');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="HALO Mars EVA Telemetry &amp; Planner" xmlns="http://www.topografix.com/GPX/1/1">',
      '  <metadata>',
      `    <name>${escapeXml(dem.name)} — Safe Return Corridor</name>`,
      `    <time>${timestamp}</time>`,
      '  </metadata>',
      `  <wpt lat="${astroPt[1].toFixed(7)}" lon="${astroPt[0].toFixed(7)}">`,
      `    <ele>${astroPt[2].toFixed(1)}</ele>`,
      '    <name>EVA-PIN</name>',
      '    <desc>Current EVA astronaut position</desc>',
      '  </wpt>',
      `  <wpt lat="${basePt[1].toFixed(7)}" lon="${basePt[0].toFixed(7)}">`,
      `    <ele>${basePt[2].toFixed(1)}</ele>`,
      '    <name>HAB-BASE</name>',
      '    <desc>Habitat / Pressurized Rover safe haven</desc>',
      '  </wpt>',
      '  <rte>',
      `    <name>${escapeXml(dem.id)}_RETURN_CORRIDOR</name>`,
      rteptXml,
      '  </rte>',
      '</gpx>'
    ].join('\n');
  }
}

export const R_MARS_M = 3389500.0;

/**
 * Converts local tangent-plane meters (+X East, +Z South) into Mars planetocentric [lon, lat, elevM].
 * @param {number} xMeters
 * @param {number} zMeters
 * @param {object} dem
 * @returns {[number, number, number]}
 */
export function localMetersToPlanetocentric(xMeters, zMeters, dem) {
  const originLat = Number.isFinite(dem?.originLat) ? dem.originLat : 0.0;
  const originLon = Number.isFinite(dem?.originLon) ? dem.originLon : 0.0;
  const latRad0 = (originLat * Math.PI) / 180.0;
  const dLatDeg = (-zMeters / R_MARS_M) * (180.0 / Math.PI);
  const cosLat = Math.max(0.05, Math.cos(latRad0));
  const dLonDeg = (xMeters / (R_MARS_M * cosLat)) * (180.0 / Math.PI);

  let elevM = 0;
  if (dem?.elevations) {
    const gx = Math.max(0, Math.min(GRID_N - 1, Math.round(xMeters / CELL_M + BASE_GX)));
    const gy = Math.max(0, Math.min(GRID_N - 1, Math.round(zMeters / CELL_M + BASE_GY)));
    elevM = Number(dem.elevations[gy * GRID_N + gx].toFixed(2));
  }

  return [
    Number((originLon + dLonDeg).toFixed(7)),
    Number((originLat + dLatDeg).toFixed(7)),
    elevM
  ];
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
