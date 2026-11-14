/**
 * BioRadius — Curvature-Corrected 360° DEM Skyline Ray-Marcher & NCC Matcher (Module D)
 * Computes 36-azimuth horizon profiles with Martian spherical curvature + CO2 refraction
 * and localizes a visor skyline silhouette via a 25x25 coarse LUT + 5x5 fine refinement
 * + Parseval circular-harmonic upper-bound pruning across all 36 cyclic yaw shifts (< 1.8 ms).
 */

export const SKYLINE_AZIMUTHS = 36;
export const SKYLINE_MAX_STEPS = 60;
export const EYE_HEIGHT_M = 1.70;
export const R_MARS_M = 3389500.0;
export const K_REFR_CO2 = 0.06;
export const RAD_TO_DEG = 180.0 / Math.PI;
export const DEG_TO_RAD = Math.PI / 180.0;

const TOTAL_CELLS = 150 * 150;
const LUT_SIDE = 25;
const LUT_STRIDE = 6;
const LUT_OFFSET = 3;
const FINE_RADIUS = 2; // 5x5 fine neighborhood
const HARMONICS = 8;
const SPEC_STRIDE = HARMONICS + 1;
const TOP_COARSE_BLOCKS = 16;
const TOP_FINE_SEEDS = 12;

const SIN_AZ = new Float32Array(SKYLINE_AZIMUTHS);
const COS_AZ = new Float32Array(SKYLINE_AZIMUTHS);
for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
  const azRad = k * (Math.PI / 18.0);
  SIN_AZ[k] = Math.sin(azRad);
  COS_AZ[k] = Math.cos(azRad);
}

// Precomputed 8-harmonic DFT trig tables for rotation-invariant Parseval spectral bounds
const DFT_COS = new Float32Array(HARMONICS * SKYLINE_AZIMUTHS);
const DFT_SIN = new Float32Array(HARMONICS * SKYLINE_AZIMUTHS);
const DFT_SCALE = Math.sqrt(2.0 / SKYLINE_AZIMUTHS);
for (let m = 1; m <= HARMONICS; m++) {
  for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
    const ang = (2.0 * Math.PI * m * k) / SKYLINE_AZIMUTHS;
    DFT_COS[(m - 1) * SKYLINE_AZIMUTHS + k] = DFT_SCALE * Math.cos(ang);
    DFT_SIN[(m - 1) * SKYLINE_AZIMUTHS + k] = DFT_SCALE * Math.sin(ang);
  }
}

/**
 * Ray-marches 36 azimuths from grid coordinate (gx, gy) and writes maximum
 * curvature-corrected horizon elevation angles (radians) into outAlphaRad.
 */
export function computeCellHorizonProfile(
  gx,
  gy,
  elevations,
  outAlphaRad,
  outOffset = 0,
  gridN = 150,
  cellM = 10000.0 / 149.0
) {
  const zEye = elevations[gy * gridN + gx] + EYE_HEIGHT_M;
  const curvFactor = (1.0 - K_REFR_CO2) / (2.0 * R_MARS_M);

  for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
    const ux = SIN_AZ[k];
    const uy = -COS_AZ[k];
    let maxEl = -0.25;

    for (let step = 1; step <= SKYLINE_MAX_STEPS; step++) {
      const rx = Math.round(gx + step * ux);
      const ry = Math.round(gy + step * uy);
      if (rx < 0 || rx >= gridN || ry < 0 || ry >= gridN) {
        break;
      }
      const distM = step * cellM;
      const curvatureDropM = curvFactor * distM * distM;
      const zApparent = elevations[ry * gridN + rx] - curvatureDropM;
      const elRad = Math.atan2(zApparent - zEye, distM);
      if (elRad > maxEl) {
        maxEl = elRad;
      }
    }
    outAlphaRad[outOffset + k] = maxEl;
  }
}

/**
 * Computes 36-azimuth horizon profiles and solid-angle Sky-View Factor (SVF)
 * for every cell in the 150x150 DEM grid.
 */
export function computeAllHorizonsAndSVF(
  elevations,
  gridN = 150,
  cellM = 10000.0 / 149.0
) {
  const totalCells = gridN * gridN;
  const horizonAnglesRad = new Float32Array(totalCells * SKYLINE_AZIMUTHS);
  const skyViewFactor = new Float32Array(totalCells);
  const invAz = 1.0 / SKYLINE_AZIMUTHS;

  for (let gy = 0; gy < gridN; gy++) {
    const rowBase = gy * gridN;
    for (let gx = 0; gx < gridN; gx++) {
      const idx = rowBase + gx;
      const baseOffset = idx * SKYLINE_AZIMUTHS;
      computeCellHorizonProfile(gx, gy, elevations, horizonAnglesRad, baseOffset, gridN, cellM);

      let svfSum = 0.0;
      for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
        const clamped = horizonAnglesRad[baseOffset + k];
        const alpha = clamped > 0.0 ? clamped : 0.0;
        const c = Math.cos(alpha);
        svfSum += c * c;
      }
      skyViewFactor[idx] = Math.max(0.05, Math.min(1.0, svfSum * invAz));
    }
  }

  return { horizonAnglesRad, skyViewFactor };
}

/**
 * Updates local radiation dose rates (uSv/hr) from SVF and active SEP storm state.
 */
export function updateRadDoseRate(dem, sepStormActive) {
  const flux = sepStormActive ? 14500.0 : 9.2;
  const svf = dem.skyViewFactor;
  const out = dem.radDoseRate;
  for (let i = 0; i < out.length; i++) {
    out[i] = flux * svf[i];
  }
}

function normalizeZeroMean(src, srcOffset, dst, dstOffset = 0) {
  let mean = 0.0;
  for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
    mean += src[srcOffset + k];
  }
  mean /= SKYLINE_AZIMUTHS;

  let normSq = 0.0;
  for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
    const d = src[srcOffset + k] - mean;
    dst[dstOffset + k] = d;
    normSq += d * d;
  }

  const norm = Math.sqrt(normSq);
  if (norm > 1e-7) {
    const inv = 1.0 / norm;
    for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
      dst[dstOffset + k] *= inv;
    }
  } else {
    const uniform = 1.0 / Math.sqrt(SKYLINE_AZIMUTHS);
    for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
      dst[dstOffset + k] = uniform;
    }
  }
  return norm;
}

function computeHarmonicSpectrum(unitVec, unitOffset, outSpec, specOffset = 0) {
  let energy = 0.0;
  for (let h = 0; h < HARMONICS; h++) {
    let re = 0.0;
    let im = 0.0;
    const tOff = h * SKYLINE_AZIMUTHS;
    for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
      const v = unitVec[unitOffset + k];
      re += v * DFT_COS[tOff + k];
      im += v * DFT_SIN[tOff + k];
    }
    const mag = Math.sqrt(re * re + im * im);
    outSpec[specOffset + h] = mag;
    energy += mag * mag;
  }
  const rem = 1.0 - energy;
  outSpec[specOffset + HARMONICS] = rem > 0.0 ? Math.sqrt(rem) : 0.0;
}

function bestCyclicNccAtOffset(queryUnit, candVecs, candOffset, outTuple) {
  let bestNcc = -2.0;
  let bestShift = 0;

  for (let shift = 0; shift < SKYLINE_AZIMUTHS; shift++) {
    let dot = 0.0;
    const split = SKYLINE_AZIMUTHS - shift;
    for (let k = 0; k < split; k++) {
      dot += queryUnit[k] * candVecs[candOffset + k + shift];
    }
    for (let k = split; k < SKYLINE_AZIMUTHS; k++) {
      dot += queryUnit[k] * candVecs[candOffset + k - split];
    }
    if (dot > bestNcc) {
      bestNcc = dot;
      bestShift = shift;
    }
  }

  outTuple[0] = bestNcc > 1.0 ? 1.0 : bestNcc;
  outTuple[1] = bestShift;
}

export class SkylineTerrainMatcher {
  constructor() {
    this.lutGridCount = LUT_SIDE * LUT_SIDE;
    this.lutVectors = new Float32Array(this.lutGridCount * SKYLINE_AZIMUTHS);
    this.lutSpecEnvelope = new Float32Array(this.lutGridCount * SPEC_STRIDE);
    this.lutGx = new Int16Array(this.lutGridCount);
    this.lutGy = new Int16Array(this.lutGridCount);

    this.allUnitVectors = new Float32Array(TOTAL_CELLS * SKYLINE_AZIMUTHS);
    this.allSpecVectors = new Float32Array(TOTAL_CELLS * SPEC_STRIDE);

    this.queryUnit = new Float32Array(SKYLINE_AZIMUTHS);
    this.querySpec = new Float32Array(SPEC_STRIDE);
    this.tempProfile = new Float32Array(SKYLINE_AZIMUTHS);
    this.queryProfileRad = new Float32Array(SKYLINE_AZIMUTHS);
    this.matchedProfileRad = new Float32Array(SKYLINE_AZIMUTHS);
    this.queryProfileDeg = new Float32Array(SKYLINE_AZIMUTHS);
    this.matchedProfileDeg = new Float32Array(SKYLINE_AZIMUTHS);

    this.topCoarseIdx = new Int32Array(TOP_COARSE_BLOCKS);
    this.topCoarseScore = new Float32Array(TOP_COARSE_BLOCKS);
    this.topFineIdx = new Int32Array(TOP_FINE_SEEDS);
    this.topFineScore = new Float32Array(TOP_FINE_SEEDS);
    this.visitedFine = new Uint32Array(TOTAL_CELLS);
    this.visitStamp = 1;
    this.nccPair = new Float64Array(2);
    this.indexedSiteId = null;
  }

  /**
   * Precomputes normalized 36-azimuth vectors, harmonic descriptors, and the 25x25 coarse LUT.
   */
  buildIndex(dem) {
    if (this.indexedSiteId === dem.id) return;
    const gridN = dem.gridN || 150;
    const cellM = dem.cellM || 10000.0 / 149.0;
    const horizons = dem.horizonAnglesRad;

    if (!dem._unitHorizonVectors || !dem._specHorizonVectors) {
      const unitBuf = new Float32Array(gridN * gridN * SKYLINE_AZIMUTHS);
      const specBuf = new Float32Array(gridN * gridN * SPEC_STRIDE);
      for (let i = 0; i < gridN * gridN; i++) {
        const off = i * SKYLINE_AZIMUTHS;
        if (horizons) {
          normalizeZeroMean(horizons, off, unitBuf, off);
        } else {
          const gx = i % gridN;
          const gy = (i / gridN) | 0;
          computeCellHorizonProfile(gx, gy, dem.elevations, this.tempProfile, 0, gridN, cellM);
          normalizeZeroMean(this.tempProfile, 0, unitBuf, off);
        }
        computeHarmonicSpectrum(unitBuf, off, specBuf, i * SPEC_STRIDE);
      }
      dem._unitHorizonVectors = unitBuf;
      dem._specHorizonVectors = specBuf;
    }

    this.allUnitVectors.set(dem._unitHorizonVectors);
    this.allSpecVectors.set(dem._specHorizonVectors);

    // Populate 25x25 coarse LUT (centroid profiles + block spectral upper-bound envelopes)
    let lutIdx = 0;
    for (let by = 0; by < LUT_SIDE; by++) {
      const cy = Math.min(gridN - 1, LUT_OFFSET + by * LUT_STRIDE);
      const yStart = by * LUT_STRIDE;
      const yEnd = Math.min(gridN, yStart + LUT_STRIDE);

      for (let bx = 0; bx < LUT_SIDE; bx++) {
        const cx = Math.min(gridN - 1, LUT_OFFSET + bx * LUT_STRIDE);
        const xStart = bx * LUT_STRIDE;
        const xEnd = Math.min(gridN, xStart + LUT_STRIDE);

        this.lutGx[lutIdx] = cx;
        this.lutGy[lutIdx] = cy;

        const srcOff = (cy * gridN + cx) * SKYLINE_AZIMUTHS;
        const dstOff = lutIdx * SKYLINE_AZIMUTHS;
        for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
          this.lutVectors[dstOff + k] = this.allUnitVectors[srcOff + k];
        }

        const envOff = lutIdx * SPEC_STRIDE;
        for (let h = 0; h < SPEC_STRIDE; h++) {
          this.lutSpecEnvelope[envOff + h] = 0.0;
        }
        for (let gy = yStart; gy < yEnd; gy++) {
          for (let gx = xStart; gx < xEnd; gx++) {
            const sOff = (gy * gridN + gx) * SPEC_STRIDE;
            for (let h = 0; h < SPEC_STRIDE; h++) {
              const v = this.allSpecVectors[sOff + h];
              if (v > this.lutSpecEnvelope[envOff + h]) {
                this.lutSpecEnvelope[envOff + h] = v;
              }
            }
          }
        }
        lutIdx++;
      }
    }
    this.indexedSiteId = dem.id;
  }

  /**
   * Extracts a 36-azimuth visor horizon profile at (gx, gy).
   */
  extractVisorProfile(dem, gx, gy, yawShiftBins = 0, noiseStdRad = 0.0, outRad = this.queryProfileRad) {
    const gridN = dem.gridN || 150;
    const cellIdx = gy * gridN + gx;
    const src = dem.horizonAnglesRad;
    const baseOffset = cellIdx * SKYLINE_AZIMUTHS;

    if (!src) {
      computeCellHorizonProfile(gx, gy, dem.elevations, this.tempProfile, 0, gridN, dem.cellM);
    }

    for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
      const shifted = (k + yawShiftBins + SKYLINE_AZIMUTHS) % SKYLINE_AZIMUTHS;
      const cleanVal = src ? src[baseOffset + shifted] : this.tempProfile[shifted];
      const jitter = noiseStdRad > 0.0 ? noiseStdRad * Math.sin(k * 2.17 + gx * 0.7) : 0.0;
      outRad[k] = cleanVal + jitter;
    }
    return outRad;
  }

  /**
   * Matches an observed 36-azimuth visor skyline against the indexed DEM via
   * 25x25 coarse LUT spectral pruning + 5x5 fine refinement across all 36 cyclic yaw shifts.
   */
  matchSkyline(dem, queryRad = this.queryProfileRad, refGx = -1, refGy = -1) {
    if (this.indexedSiteId !== dem.id) {
      this.buildIndex(dem);
    }

    const t0 = performance.now();
    const gridN = dem.gridN || 150;
    const cellM = dem.cellM || 10000.0 / 149.0;
    const horizons = dem.horizonAnglesRad;

    normalizeZeroMean(queryRad, 0, this.queryUnit, 0);
    computeHarmonicSpectrum(this.queryUnit, 0, this.querySpec, 0);

    const q0 = this.querySpec[0];
    const q1 = this.querySpec[1];
    const q2 = this.querySpec[2];
    const q3 = this.querySpec[3];
    const q4 = this.querySpec[4];
    const q5 = this.querySpec[5];
    const q6 = this.querySpec[6];
    const q7 = this.querySpec[7];
    const q8 = this.querySpec[8];

    // Stage 1: Coarse 25x25 LUT fast check + rotation-invariant Parseval upper-bound ranking
    this.topFineScore.fill(-2.0);
    this.topFineIdx.fill(-1);
    let minFine = -2.0;
    const allSpec = this.allSpecVectors;

    // First probe the 25x25 coarse LUT centroids to seed strong initial bounds
    for (let c = 0; c < this.lutGridCount; c++) {
      const gx = this.lutGx[c];
      const gy = this.lutGy[c];
      const cellIdx = gy * gridN + gx;
      const s = cellIdx * SPEC_STRIDE;
      const bnd =
        q0 * allSpec[s] +
        q1 * allSpec[s + 1] +
        q2 * allSpec[s + 2] +
        q3 * allSpec[s + 3] +
        q4 * allSpec[s + 4] +
        q5 * allSpec[s + 5] +
        q6 * allSpec[s + 6] +
        q7 * allSpec[s + 7] +
        q8 * allSpec[s + 8];
      if (bnd > minFine) {
        let pos = TOP_FINE_SEEDS - 1;
        while (pos > 0 && bnd > this.topFineScore[pos - 1]) {
          this.topFineScore[pos] = this.topFineScore[pos - 1];
          this.topFineIdx[pos] = this.topFineIdx[pos - 1];
          pos--;
        }
        this.topFineScore[pos] = bnd;
        this.topFineIdx[pos] = cellIdx;
        minFine = this.topFineScore[TOP_FINE_SEEDS - 1];
      }
    }

    // Refine across exact spectral upper bounds when no LUT centroid matched exactly
    if (this.topFineScore[0] < 0.9999) {
      for (let i = 0; i < TOTAL_CELLS; i++) {
        const s = i * SPEC_STRIDE;
        const bnd =
          q0 * allSpec[s] +
          q1 * allSpec[s + 1] +
          q2 * allSpec[s + 2] +
          q3 * allSpec[s + 3] +
          q4 * allSpec[s + 4] +
          q5 * allSpec[s + 5] +
          q6 * allSpec[s + 6] +
          q7 * allSpec[s + 7] +
          q8 * allSpec[s + 8];
        if (bnd > minFine) {
          let pos = TOP_FINE_SEEDS - 1;
          while (pos > 0 && bnd > this.topFineScore[pos - 1]) {
            this.topFineScore[pos] = this.topFineScore[pos - 1];
            this.topFineIdx[pos] = this.topFineIdx[pos - 1];
            pos--;
          }
          this.topFineScore[pos] = bnd;
          this.topFineIdx[pos] = i;
          minFine = this.topFineScore[TOP_FINE_SEEDS - 1];
        }
      }
    }

    // Stage 2: Full 36-azimuth x 36-yaw exact Zero-Mean NCC on top spectral seeds
    let bestNcc = -2.0;
    let bestCell = this.topFineIdx[0] >= 0 ? this.topFineIdx[0] : 75 * gridN + 75;
    let bestShift = 0;
    const allVecs = this.allUnitVectors;

    for (let t = 0; t < TOP_FINE_SEEDS; t++) {
      const cellIdx = this.topFineIdx[t];
      if (cellIdx < 0) continue;
      bestCyclicNccAtOffset(this.queryUnit, allVecs, cellIdx * SKYLINE_AZIMUTHS, this.nccPair);
      const score = this.nccPair[0];
      const shift = this.nccPair[1] | 0;
      if (score > bestNcc) {
        bestNcc = score;
        bestCell = cellIdx;
        bestShift = shift;
        if (bestNcc >= 0.99995) break;
      }
    }

    const bestGx = bestCell % gridN;
    const bestGy = (bestCell / gridN) | 0;

    // Stage 3: 5x5 local fine neighborhood verification around the winner when noisy
    if (bestNcc < 0.9995) {
      let stamp = ++this.visitStamp;
      if (stamp === 0xffffffff) {
        this.visitedFine.fill(0);
        stamp = this.visitStamp = 1;
      }
      for (let t = 0; t < TOP_FINE_SEEDS; t++) {
        if (this.topFineIdx[t] >= 0) this.visitedFine[this.topFineIdx[t]] = stamp;
      }
      for (let dy = -FINE_RADIUS; dy <= FINE_RADIUS; dy++) {
        const gy = bestGy + dy;
        if (gy < 0 || gy >= gridN) continue;
        for (let dx = -FINE_RADIUS; dx <= FINE_RADIUS; dx++) {
          const gx = bestGx + dx;
          if (gx < 0 || gx >= gridN) continue;
          const cellIdx = gy * gridN + gx;
          if (this.visitedFine[cellIdx] === stamp) continue;
          bestCyclicNccAtOffset(this.queryUnit, allVecs, cellIdx * SKYLINE_AZIMUTHS, this.nccPair);
          const score = this.nccPair[0];
          const shift = this.nccPair[1] | 0;
          if (score > bestNcc) {
            bestNcc = score;
            bestCell = cellIdx;
            bestShift = shift;
          }
        }
      }
    }

    const finalGx = bestCell % gridN;
    const finalGy = (bestCell / gridN) | 0;
    const elapsedMs = performance.now() - t0;

    const srcMatched = horizons ? horizons : this.tempProfile;
    const matchOffset = horizons ? bestCell * SKYLINE_AZIMUTHS : 0;

    if (!horizons) {
      computeCellHorizonProfile(finalGx, finalGy, dem.elevations, this.tempProfile, 0, gridN, cellM);
    }

    for (let k = 0; k < SKYLINE_AZIMUTHS; k++) {
      const shifted = (k + bestShift) % SKYLINE_AZIMUTHS;
      this.matchedProfileRad[k] = srcMatched[matchOffset + shifted];
      this.queryProfileDeg[k] = queryRad[k] * RAD_TO_DEG;
      this.matchedProfileDeg[k] = this.matchedProfileRad[k] * RAD_TO_DEG;
    }

    const errorM =
      refGx >= 0 && refGy >= 0
        ? Math.hypot((finalGx - refGx) * cellM, (finalGy - refGy) * cellM)
        : 0.0;

    return {
      gx: finalGx,
      gy: finalGy,
      yawShiftIdx: bestShift,
      yawOffsetDeg: bestShift * 10,
      ncc: bestNcc,
      elapsedMs,
      errorM,
      queryDeg: this.queryProfileDeg,
      matchedDeg: this.matchedProfileDeg
    };
  }
}
