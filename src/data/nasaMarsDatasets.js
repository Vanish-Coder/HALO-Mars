/**
 * HALO Mars — Martian Surface Datasets & Coordinate Parity (Module A)
 * Calibrated Parametric PDS Surrogates bounded strictly to published NASA PDS ranges.
 * All arrays are co-registered 150x150 row-major typed arrays (22,500 nodes).
 */

import { computeAllHorizonsAndSVF, updateRadDoseRate } from '../physics/skylineTerrainMatcher.js';

export const GRID_N = 150;
export const TOTAL_CELLS = GRID_N * GRID_N;
export const SPAN_M = 10000.0;
export const CELL_M = SPAN_M / (GRID_N - 1); // 67.11409395973155 m
export const BASE_GX = 75;
export const BASE_GY = 75;
export const BASE_IDX = BASE_GY * GRID_N + BASE_GX;
export const OVERLAY_Y_OFFSET = 16.0;

export const SUN_AZ_DEG = 118.0;
export const SUN_EL_DEG = 22.5;
const SUN_TAN_EL = Math.tan((SUN_EL_DEG * Math.PI) / 180.0);
const SUN_AZ_RAD = (SUN_AZ_DEG * Math.PI) / 180.0;
const SUN_UX = Math.sin(SUN_AZ_RAD);
const SUN_UY = -Math.cos(SUN_AZ_RAD);

export function gridToWorld(gx, gy, elevM = 0.0, extraY = 0.0) {
  return {
    x: (gx - BASE_GX) * CELL_M,
    y: elevM + extraY,
    z: (gy - BASE_GY) * CELL_M
  };
}

export function worldToGrid(x, z) {
  const gx = Math.max(0, Math.min(GRID_N - 1, Math.round(x / CELL_M + BASE_GX)));
  const gy = Math.max(0, Math.min(GRID_N - 1, Math.round(z / CELL_M + BASE_GY)));
  return { gx, gy, idx: gy * GRID_N + gx };
}

function hash2D(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296.0;
}

function valueNoise2D(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3.0 - 2.0 * fx);
  const uy = fy * fy * (3.0 - 2.0 * fy);

  const a = hash2D(ix, iy, seed);
  const b = hash2D(ix + 1, iy, seed);
  const c = hash2D(ix, iy + 1, seed);
  const d = hash2D(ix + 1, iy + 1, seed);

  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm2D(x, y, octaves, seed) {
  let sum = 0.0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0.0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (valueNoise2D(x * freq, y * freq, seed + i * 31) * 2.0 - 1.0);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/**
 * Ray-marches solar shadow mask using NAIF SPICE solar geometry (Az=118°, El=22.5°).
 */
export function computeSunLitMask(elevations) {
  const sunLitMask = new Uint8Array(TOTAL_CELLS);

  for (let gy = 0; gy < GRID_N; gy++) {
    const rowBase = gy * GRID_N;
    for (let gx = 0; gx < GRID_N; gx++) {
      const idx = rowBase + gx;
      const elev0 = elevations[idx];
      let lit = 1;

      for (let step = 1; step <= 60; step++) {
        const rx = Math.round(gx + step * SUN_UX);
        const ry = Math.round(gy + step * SUN_UY);
        if (rx < 0 || rx >= GRID_N || ry < 0 || ry >= GRID_N) {
          break;
        }
        const rayElev = elevations[ry * GRID_N + rx];
        if (rayElev - elev0 > step * CELL_M * SUN_TAN_EL) {
          lit = 0;
          break;
        }
      }
      sunLitMask[idx] = lit;
    }
  }
  return sunLitMask;
}

/**
 * Precomputes physical slope magnitude (degrees) at each cell for shader visualization
 * and cliff-count attribution.
 */
function computeCellMaxSlopeDeg(elevations) {
  const maxSlopeDeg = new Float32Array(TOTAL_CELLS);
  const radToDeg = 180.0 / Math.PI;
  const diagM = CELL_M * 1.41421356;

  for (let gy = 0; gy < GRID_N; gy++) {
    for (let gx = 0; gx < GRID_N; gx++) {
      const idx = gy * GRID_N + gx;
      const e0 = elevations[idx];
      let bestDeg = 0.0;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = gy + dy;
        if (ny < 0 || ny >= GRID_N) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = gx + dx;
          if (nx < 0 || nx >= GRID_N) continue;
          const dist = dx !== 0 && dy !== 0 ? diagM : CELL_M;
          const dz = Math.abs(elevations[ny * GRID_N + nx] - e0);
          const deg = Math.atan2(dz, dist) * radToDeg;
          if (deg > bestDeg) bestDeg = deg;
        }
      }
      maxSlopeDeg[idx] = bestDeg;
    }
  }
  return maxSlopeDeg;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function buildMountSharpBoxwork() {
  const elevations = new Float32Array(TOTAL_CELLS);
  const thermalInertia = new Float32Array(TOTAL_CELLS);
  const mineralConcentration = new Float32Array(TOTAL_CELLS);

  for (let gy = 0; gy < GRID_N; gy++) {
    for (let gx = 0; gx < GRID_N; gx++) {
      const idx = gy * GRID_N + gx;
      const nx = (gx - BASE_GX) / 75.0; // -1..+1
      const ny = (gy - BASE_GY) / 75.0; // -1..+1
      const r = Math.hypot(gx - BASE_GX, gy - BASE_GY);

      // Regional uphill Aeolis Mons ramp rising toward NNE/East
      let elev = -2240.0 + 175.0 * nx - 190.0 * ny + 18.0 * fbm2D(gx * 0.045, gy * 0.045, 4, 101);

      // Mineralized boxwork sulfate fracture ridges (15m - 45m prominence)
      const boxA = Math.abs(Math.sin((gx * 0.21 + gy * 0.09) + 0.9 * fbm2D(gx * 0.06, gy * 0.06, 2, 202)));
      const boxB = Math.abs(Math.sin((gx * -0.10 + gy * 0.22) + 0.8 * fbm2D(gx * 0.06, gy * 0.06, 2, 303)));
      const boxRidge = Math.max(Math.exp(-boxA * 6.5), Math.exp(-boxB * 6.5));
      const boxZone = Math.exp(-Math.pow((r - 24.0) / 36.0, 2));
      elev += 34.0 * boxRidge * (0.35 + 0.65 * boxZone);

      // Gediz Vallis >34 deg fault scarp wall in the NW-North sector & dramatic ridge crest
      const scarpPlane = (gy - 43) * 0.82 + (gx - 92) * 0.57;
      const scarpSteep = 1.0 / (1.0 + Math.exp(scarpPlane * 1.15));
      elev += 235.0 * scarpSteep;

      // Secondary southern steep crater wall (>34 deg)
      const crDist = Math.hypot(gx - 54, gy - 112);
      if (crDist < 22.0) {
        const rimT = Math.exp(-Math.pow((crDist - 15.0) / 2.2, 2));
        const bowlT = 1.0 / (1.0 + Math.exp((crDist - 13.5) * 1.35));
        elev += 55.0 * rimT - 115.0 * bowlT;
      }

      // Flatten immediate lander pad around Base (75,75) for safe touchdown & sunlit parity
      const padMask = Math.exp(-Math.pow(r / 4.2, 2));
      elev = elev * (1.0 - padMask) + -2240.0 * padMask;

      elevations[idx] = clamp(elev, -2450.0, -1720.0);

      // THEMIS Thermal Inertia (TIU): ~185 TIU regolith sheet, < 95 TIU sand troughs, > 240 TIU bedrock ridges
      const sandWave = Math.sin(gx * 0.14 - gy * 0.11 + 1.4 * fbm2D(gx * 0.05, gy * 0.05, 3, 404));
      const troughMask = sandWave > 0.32 ? (sandWave - 0.32) / 0.68 : 0.0;
      let tiu = 185.0 + 95.0 * boxRidge - 125.0 * troughMask + 24.0 * fbm2D(gx * 0.08, gy * 0.08, 2, 505);
      // Keep lander pad firm
      tiu = tiu * (1.0 - padMask) + 295.0 * padMask;
      thermalInertia[idx] = clamp(tiu, 52.0, 460.0);

      // CRISM Hydration / Ca-Sulfate + Smectite Mineral Index (0..1)
      const clayBand = Math.exp(-Math.pow((r - 27.5) / 10.5, 2));
      const mineral = 0.22 + 0.52 * boxRidge * boxZone + 0.30 * clayBand + 0.12 * fbm2D(gx * 0.09, gy * 0.09, 2, 606);
      mineralConcentration[idx] = clamp(mineral, 0.05, 0.99);
    }
  }

  const sunLitMask = computeSunLitMask(elevations);
  const maxSlopeDeg = computeCellMaxSlopeDeg(elevations);
  const { horizonAnglesRad, skyViewFactor } = computeAllHorizonsAndSVF(elevations, GRID_N, CELL_M);
  const radDoseRate = new Float32Array(TOTAL_CELLS);

  const dem = {
    id: 'MOUNT_SHARP_BOXWORK',
    name: 'Mount Sharp Boxwork (Gale Crater)',
    coordinatesLabel: '4.58°S, 137.44°E',
    originLat: -4.58,
    originLon: 137.44,
    minElev: -2450.0,
    maxElev: -1720.0,
    elevRangeLabel: '-2450m to -1720m',
    description:
      'Aeolis Mons mineralized Ca-sulfate boxwork fracture ridges, loose eolian sand troughs, and upper Gediz Vallis fault scarp.',
    gridN: GRID_N,
    spanM: SPAN_M,
    cellM: CELL_M,
    baseGx: BASE_GX,
    baseGy: BASE_GY,
    baseIdx: BASE_IDX,
    defaultAstroGx: 85,
    defaultAstroGy: 65,
    elevations,
    thermalInertia,
    mineralConcentration,
    sunLitMask,
    maxSlopeDeg,
    horizonAnglesRad,
    skyViewFactor,
    radDoseRate,
    waypoints: [
      {
        id: 'WP-1',
        name: 'WP-1: Boxwork Ca-Sulfate Ridge',
        distanceLabel: '0.95 km',
        gx: 85,
        gy: 65,
        scienceNote: 'Hydrated Ca-sulfate boxwork vein network (CRISM high index)'
      },
      {
        id: 'WP-2',
        name: 'WP-2: Fe/Mg Smectite Clay Unit',
        distanceLabel: '1.85 km',
        gx: 98,
        gy: 60,
        scienceNote: 'Phyllosilicate lacustrine mudstone bench'
      },
      {
        id: 'WP-3',
        name: 'WP-3: Upper Gediz Vallis Scarp',
        distanceLabel: '2.80 km',
        gx: 109,
        gy: 51,
        scienceNote: 'Sulfur-bearing debris ridge below >34° fault scarp'
      }
    ]
  };

  updateRadDoseRate(dem, false);
  return dem;
}

function buildJezeroDelta() {
  const elevations = new Float32Array(TOTAL_CELLS);
  const thermalInertia = new Float32Array(TOTAL_CELLS);
  const mineralConcentration = new Float32Array(TOTAL_CELLS);

  for (let gy = 0; gy < GRID_N; gy++) {
    for (let gx = 0; gx < GRID_N; gx++) {
      const idx = gy * GRID_N + gx;
      const nx = (gx - BASE_GX) / 75.0;
      const ny = (gy - BASE_GY) / 75.0;
      const r = Math.hypot(gx - BASE_GX, gy - BASE_GY);

      // Western Delta rising northwest toward Neretva Vallis inlet & carbonate rim
      let elev = -2465.0 - 115.0 * nx - 135.0 * ny + 14.0 * fbm2D(gx * 0.05, gy * 0.05, 4, 707);

      // Western Delta frontal scarp (35 deg cliff arc)
      const deltaArc = Math.hypot(gx - 34, gy - 52);
      const scarpStep = 1.0 / (1.0 + Math.exp((deltaArc - 34.0) * 1.15));
      elev += 205.0 * scarpStep;

      // Neretva Vallis braided distributary channels incised across delta apron
      const channelAxis = (gy - 66) - 0.55 * (gx - 68) + 4.5 * Math.sin(gx * 0.14);
      const braidA = Math.exp(-Math.pow(channelAxis / 3.8, 2));
      const braidB = Math.exp(-Math.pow((channelAxis - 8.5 * Math.cos(gx * 0.11)) / 2.6, 2));
      const channelCut = Math.max(braidA, 0.7 * braidB);
      elev -= 48.0 * channelCut;

      // Belva-like crater south-east of base with steep rim
      const belvaR = Math.hypot(gx - 108, gy - 104);
      if (belvaR < 20.0) {
        const rim = Math.exp(-Math.pow((belvaR - 14.0) / 2.0, 2));
        const pit = 1.0 / (1.0 + Math.exp((belvaR - 12.2) * 1.3));
        elev += 48.0 * rim - 96.0 * pit;
      }

      // Level Octavia E. Butler landing pad around Base (75,75)
      const padMask = Math.exp(-Math.pow(r / 4.2, 2));
      elev = elev * (1.0 - padMask) + -2465.0 * padMask;

      elevations[idx] = clamp(elev, -2580.0, -2080.0);

      // THEMIS TIU: ~188 TIU regolith apron, < 95 TIU channel sand, > 240 TIU scarp olivine/carbonate bedrock
      let tiu = 188.0 - 125.0 * channelCut + 115.0 * scarpStep + 24.0 * fbm2D(gx * 0.08, gy * 0.08, 2, 808);
      tiu = tiu * (1.0 - padMask) + 310.0 * padMask;
      thermalInertia[idx] = clamp(tiu, 58.0, 470.0);

      // CRISM Mg-Carbonate & Delta Clay signature
      const rimBand = Math.exp(-Math.pow((deltaArc - 34.0) / 8.0, 2));
      const mineral = 0.25 + 0.55 * rimBand + 0.22 * channelCut + 0.10 * fbm2D(gx * 0.09, gy * 0.09, 2, 909);
      mineralConcentration[idx] = clamp(mineral, 0.06, 0.99);
    }
  }

  const sunLitMask = computeSunLitMask(elevations);
  const maxSlopeDeg = computeCellMaxSlopeDeg(elevations);
  const { horizonAnglesRad, skyViewFactor } = computeAllHorizonsAndSVF(elevations, GRID_N, CELL_M);
  const radDoseRate = new Float32Array(TOTAL_CELLS);

  const dem = {
    id: 'JEZERO_DELTA',
    name: 'Jezero Crater Western Delta',
    coordinatesLabel: '18.38°N, 77.58°E',
    originLat: 18.38,
    originLon: 77.58,
    minElev: -2580.0,
    maxElev: -2080.0,
    elevRangeLabel: '-2580m to -2080m',
    description:
      'Perseverance Western Delta 35° frontal scarp, Neretva Vallis braided channels, and Margin Unit carbonate rim.',
    gridN: GRID_N,
    spanM: SPAN_M,
    cellM: CELL_M,
    baseGx: BASE_GX,
    baseGy: BASE_GY,
    baseIdx: BASE_IDX,
    defaultAstroGx: 60,
    defaultAstroGy: 63,
    elevations,
    thermalInertia,
    mineralConcentration,
    sunLitMask,
    maxSlopeDeg,
    horizonAnglesRad,
    skyViewFactor,
    radDoseRate,
    waypoints: [
      {
        id: 'WP-1',
        name: 'WP-1: Cape Nukshak Frontal Scarp',
        distanceLabel: '0.88 km',
        gx: 64,
        gy: 68,
        scienceNote: 'Stratified deltaic mudstone & sandstone foresets'
      },
      {
        id: 'WP-2',
        name: 'WP-2: Hawksbill Gap Delta Clays',
        distanceLabel: '1.75 km',
        gx: 55,
        gy: 58,
        scienceNote: 'Sulfate-bearing finely laminated phyllosilicate beds'
      },
      {
        id: 'WP-3',
        name: 'WP-3: Margin Unit Carbonate Rim',
        distanceLabel: '2.65 km',
        gx: 45,
        gy: 49,
        scienceNote: 'Shoreline Mg-carbonate & olivine crater rim unit'
      }
    ]
  };

  updateRadDoseRate(dem, false);
  return dem;
}

const SITE_BUILDERS = {
  MOUNT_SHARP_BOXWORK: buildMountSharpBoxwork,
  JEZERO_DELTA: buildJezeroDelta
};

const siteCache = new Map();

/**
 * Returns a cached 150x150 Martian landing site dataset (SURROGATE).
 */
export function getMarsSiteDataset(siteId = 'MOUNT_SHARP_BOXWORK') {
  if (siteCache.has(siteId)) {
    return siteCache.get(siteId);
  }
  if (!SITE_BUILDERS[siteId]) {
    throw new Error(`Unknown Mars site ID: ${siteId}`);
  }
  siteCache.set(siteId, SITE_BUILDERS[siteId]());
  return siteCache.get(siteId);
}

export function listMarsSites() {
  return ['MOUNT_SHARP_BOXWORK', 'JEZERO_DELTA'];
}

/**
 * Bilinearly resamples an arbitrary source raster onto the pre-allocated 150x150 grid.
 * Replaces nodata/non-finite samples with the mean of finite source cells before interpolation.
 * @param {ArrayLike<number>} srcValues
 * @param {number} srcCols
 * @param {number} srcRows
 * @param {number} [nodataValue=-9999]
 * @returns {{ elevations: Float32Array, minElev: number, maxElev: number }}
 */
export function resampleBilinearToGrid(srcValues, srcCols, srcRows, nodataValue = -9999) {
  if (!srcValues || srcCols < 2 || srcRows < 2) {
    throw new Error(`Invalid raster dimensions (${srcCols}x${srcRows}); minimum 2x2 required.`);
  }
  const expected = srcCols * srcRows;
  if (srcValues.length < expected) {
    throw new Error(`Raster buffer truncated: expected ${expected} samples, got ${srcValues.length}.`);
  }

  let finiteSum = 0;
  let finiteCount = 0;
  for (let i = 0; i < expected; i++) {
    const v = srcValues[i];
    if (Number.isFinite(v) && Math.abs(v - nodataValue) > 1e-4) {
      finiteSum += v;
      finiteCount++;
    }
  }
  if (finiteCount === 0) {
    throw new Error('Raster contains zero valid elevation samples.');
  }
  const fallbackElev = finiteSum / finiteCount;

  const clean = new Float32Array(expected);
  for (let i = 0; i < expected; i++) {
    const v = srcValues[i];
    clean[i] = Number.isFinite(v) && Math.abs(v - nodataValue) > 1e-4 ? v : fallbackElev;
  }

  const elevations = new Float32Array(TOTAL_CELLS);
  let minElev = Infinity;
  let maxElev = -Infinity;

  for (let gy = 0; gy < GRID_N; gy++) {
    const vNorm = (gy / (GRID_N - 1)) * (srcRows - 1);
    const y0 = Math.floor(vNorm);
    const y1 = Math.min(srcRows - 1, y0 + 1);
    const ty = vNorm - y0;
    const row0 = y0 * srcCols;
    const row1 = y1 * srcCols;

    for (let gx = 0; gx < GRID_N; gx++) {
      const uNorm = (gx / (GRID_N - 1)) * (srcCols - 1);
      const x0 = Math.floor(uNorm);
      const x1 = Math.min(srcCols - 1, x0 + 1);
      const tx = uNorm - x0;

      const z00 = clean[row0 + x0];
      const z10 = clean[row0 + x1];
      const z01 = clean[row1 + x0];
      const z11 = clean[row1 + x1];

      const zTop = z00 + (z10 - z00) * tx;
      const zBot = z01 + (z11 - z01) * tx;
      const z = zTop + (zBot - zTop) * ty;

      elevations[gy * GRID_N + gx] = z;
      if (z < minElev) minElev = z;
      if (z > maxElev) maxElev = z;
    }
  }

  return { elevations, minElev, maxElev };
}

/**
 * Parses an ESRI ASCII Grid (.asc) elevation file into a raw raster object.
 * @param {string} text
 */
export function parseEsriAscGrid(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/);
  const header = {
    ncols: 0,
    nrows: 0,
    xll: 0,
    yll: 0,
    cellsize: 100,
    nodata: -9999
  };
  let dataStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_]+)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)$/.exec(line);
    if (match) {
      const key = match[1].toLowerCase();
      const val = Number.parseFloat(match[2]);
      if (key === 'ncols') header.ncols = Math.trunc(val);
      else if (key === 'nrows') header.nrows = Math.trunc(val);
      else if (key === 'xllcorner' || key === 'xllcenter') header.xll = val;
      else if (key === 'yllcorner' || key === 'yllcenter') header.yll = val;
      else if (key === 'cellsize') header.cellsize = val;
      else if (key === 'nodata_value') header.nodata = val;
      dataStartLine = i + 1;
    } else {
      dataStartLine = i;
      break;
    }
  }

  if (header.ncols < 2 || header.nrows < 2) {
    throw new Error('ESRI .ASC header missing valid NCOLS / NROWS (>= 2).');
  }

  const total = header.ncols * header.nrows;
  const values = new Float32Array(total);
  let cursor = 0;

  for (let i = dataStartLine; i < lines.length && cursor < total; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/[\s,;]+/);
    for (let j = 0; j < tokens.length && cursor < total; j++) {
      if (!tokens[j]) continue;
      values[cursor++] = Number.parseFloat(tokens[j]);
    }
  }

  if (cursor < total) {
    throw new Error(`ESRI .ASC raster truncated: expected ${total} cells, parsed ${cursor}.`);
  }

  return {
    format: 'ESRI .ASC',
    cols: header.ncols,
    rows: header.nrows,
    cellsize: header.cellsize,
    nodata: header.nodata,
    originLon: Math.abs(header.xll) <= 360 ? header.xll : null,
    originLat: Math.abs(header.yll) <= 90 ? header.yll : null,
    values
  };
}

/**
 * Parses either a numeric elevation matrix CSV or a 3-column XYZ tabular PDS CSV.
 * @param {string} text
 */
export function parseCsvElevationTable(text) {
  const lines = String(text ?? '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (lines.length < 2) {
    throw new Error('CSV DEM file contains too few rows.');
  }

  const firstTokens = lines[0].split(/[,\s;]+/).filter(Boolean);
  const firstRowNumeric = firstTokens.every((tok) => Number.isFinite(Number(tok)));
  const startIdx = firstRowNumeric ? 0 : 1;
  const parsedRows = [];

  for (let i = startIdx; i < lines.length; i++) {
    const nums = lines[i]
      .split(/[,\s;]+/)
      .filter(Boolean)
      .map((tok) => Number.parseFloat(tok));
    if (nums.length > 0 && nums.some((n) => Number.isFinite(n))) {
      parsedRows.push(nums);
    }
  }

  if (parsedRows.length < 2) {
    throw new Error('CSV DEM contains fewer than 2 numeric data rows.');
  }

  // Case 1: Tabular XYZ triplets [x/lon, y/lat, elev_m]
  if (parsedRows[0].length === 3 && parsedRows.length >= 16) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let sumZ = 0;
    const valid = [];

    for (const row of parsedRows) {
      const [x, y, z] = row;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      valid.push([x, y, z]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumZ += z;
    }

    if (valid.length >= 4 && maxX > minX && maxY > minY) {
      const binN = Math.round(clamp(Math.sqrt(valid.length), 8, GRID_N));
      const sums = new Float64Array(binN * binN);
      const counts = new Uint32Array(binN * binN);
      const meanZ = sumZ / valid.length;

      for (const [x, y, z] of valid) {
        const bx = Math.min(binN - 1, Math.floor(((x - minX) / (maxX - minX)) * (binN - 1) + 0.5));
        const by = Math.min(binN - 1, Math.floor(((maxY - y) / (maxY - minY)) * (binN - 1) + 0.5));
        const idx = by * binN + bx;
        sums[idx] += z;
        counts[idx] += 1;
      }

      const values = new Float32Array(binN * binN);
      for (let i = 0; i < values.length; i++) {
        values[i] = counts[i] > 0 ? sums[i] / counts[i] : meanZ;
      }

      const midX = 0.5 * (minX + maxX);
      const midY = 0.5 * (minY + maxY);
      return {
        format: 'PDS .CSV (XYZ)',
        cols: binN,
        rows: binN,
        nodata: -9999,
        originLon: Math.abs(midX) <= 360 ? midX : null,
        originLat: Math.abs(midY) <= 90 ? midY : null,
        values
      };
    }
  }

  // Case 2: Dense numeric elevation matrix
  const cols = parsedRows[0].length;
  if (cols < 2) {
    throw new Error('Matrix CSV requires at least 2 numeric columns.');
  }
  const rows = parsedRows.length;
  const values = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const row = parsedRows[r];
    for (let c = 0; c < cols; c++) {
      values[r * cols + c] = c < row.length && Number.isFinite(row[c]) ? row[c] : -9999;
    }
  }

  return {
    format: 'Matrix .CSV',
    cols,
    rows,
    nodata: -9999,
    originLon: null,
    originLat: null,
    values
  };
}

/**
 * Parses a 16-bit binary elevation buffer (.raw / .bin / .img) into a raw raster object.
 * Defaults to unsigned 16-bit little-endian elevation values unless signed=true is specified.
 * @param {ArrayBuffer | ArrayBufferView} bufferLike
 * @param {object} [options]
 */
export function parseRaw16BitBuffer(
  bufferLike,
  { cols = 0, rows = 0, signed = false, littleEndian = true, scaleM = 1.0, offsetM = 0.0 } = {}
) {
  const bytes =
    bufferLike instanceof ArrayBuffer
      ? new Uint8Array(bufferLike)
      : ArrayBuffer.isView(bufferLike)
        ? new Uint8Array(bufferLike.buffer, bufferLike.byteOffset, bufferLike.byteLength)
        : null;
  if (!bytes || bytes.byteLength < 8 || bytes.byteLength % 2 !== 0) {
    throw new Error('16-bit .RAW buffer must contain an even byte length >= 8 bytes.');
  }

  const sampleCount = bytes.byteLength >> 1;
  let rCols = cols > 1 ? cols : 0;
  let rRows = rows > 1 ? rows : 0;
  if (!rCols || !rRows) {
    const sq = Math.round(Math.sqrt(sampleCount));
    if (sq * sq === sampleCount) {
      rCols = sq;
      rRows = sq;
    } else {
      rCols = Math.max(2, Math.floor(Math.sqrt(sampleCount)));
      rRows = Math.max(2, Math.floor(sampleCount / rCols));
    }
  }

  const total = rCols * rRows;
  if (total > sampleCount) {
    throw new Error(`16-bit .RAW buffer (${sampleCount} samples) smaller than ${rCols}x${rRows}.`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const raw = signed
      ? view.getInt16(i * 2, littleEndian)
      : view.getUint16(i * 2, littleEndian);
    values[i] = raw * scaleM + offsetM;
  }

  return {
    format: signed ? '16-bit Signed .RAW' : '16-bit Unsigned .RAW',
    cols: rCols,
    rows: rRows,
    nodata: -99999,
    originLon: null,
    originLat: null,
    values
  };
}

/**
 * Generates a realistic 160x160 Valles Marineris canyon rim & floor ESRI .ASC sample grid
 * for one-click field ingestion demos and headless tests.
 */
export function generateSampleAscGrid() {
  const cols = 160;
  const rows = 160;
  const lines = [
    `NCOLS ${cols}`,
    `NROWS ${rows}`,
    'XLLCENTER -58.42',
    'YLLCENTER -13.91',
    'CELLSIZE 62.5',
    'NODATA_VALUE -9999'
  ];

  for (let r = 0; r < rows; r++) {
    const rowVals = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const dx = (c - 80) / 80.0;
      const dy = (r - 80) / 80.0;
      const canyonWall = 1.0 / (1.0 + Math.exp((dy + 0.18 + 0.12 * Math.sin(dx * 5.0)) * 9.0));
      const spurRidge = 135.0 * Math.exp(-Math.pow((dx - 0.24) / 0.16, 2));
      const elev =
        -2680.0 +
        690.0 * canyonWall +
        spurRidge +
        38.0 * fbm2D(c * 0.06, r * 0.06, 3, 412);
      rowVals[c] = elev.toFixed(2);
    }
    lines.push(rowVals.join(' '));
  }
  return lines.join('\n');
}

function detectDemFormat(fileName, contentOrBuffer) {
  if (contentOrBuffer instanceof ArrayBuffer || ArrayBuffer.isView(contentOrBuffer)) {
    return 'raw';
  }
  const lower = String(fileName ?? '').toLowerCase();
  if (lower.endsWith('.raw') || lower.endsWith('.bin') || lower.endsWith('.img')) return 'raw';
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return 'csv';
  if (lower.endsWith('.asc') || lower.endsWith('.grd')) return 'asc';
  const head = String(contentOrBuffer ?? '').slice(0, 200).toLowerCase();
  if (head.includes('ncols') && head.includes('nrows')) return 'asc';
  return 'csv';
}

function deriveSurrogateGridsFromElevation(elevations, maxSlopeDeg, minElev, maxElev) {
  const thermalInertia = new Float32Array(TOTAL_CELLS);
  const mineralConcentration = new Float32Array(TOTAL_CELLS);
  const span = Math.max(1.0, maxElev - minElev);

  for (let gy = 0; gy < GRID_N; gy++) {
    for (let gx = 0; gx < GRID_N; gx++) {
      const idx = gy * GRID_N + gx;
      const normElev = (elevations[idx] - minElev) / span;
      const slopeNorm = clamp(maxSlopeDeg[idx] / 35.0, 0.0, 1.0);
      const r = Math.hypot(gx - BASE_GX, gy - BASE_GY);
      const padMask = Math.exp(-Math.pow(r / 4.2, 2));

      // Exposed bedrock scarps yield higher TIU (~280-410); flat eolian basins lower (~95-190)
      let tiu = 125.0 + 235.0 * slopeNorm + 45.0 * normElev + 20.0 * fbm2D(gx * 0.07, gy * 0.07, 2, 515);
      tiu = tiu * (1.0 - padMask) + 310.0 * padMask;
      thermalInertia[idx] = clamp(tiu, 65.0, 480.0);

      // Hydrated sulfates/clays peak along mid-elevation stratigraphic outcrop bands
      const outcropBand = Math.exp(-Math.pow((normElev - 0.55) / 0.22, 2));
      mineralConcentration[idx] = clamp(
        0.18 + 0.58 * outcropBand + 0.16 * slopeNorm + 0.08 * fbm2D(gx * 0.08, gy * 0.08, 2, 616),
        0.05,
        0.98
      );
    }
  }

  return { thermalInertia, mineralConcentration };
}

function pickSafeCustomWaypoints(maxSlopeDeg) {
  const candidates = [
    { id: 'WP-1', name: 'WP-1: Custom Proximal Bench', gx: 86, gy: 64, note: 'Local topographic bench (< 2 km traverse)' },
    { id: 'WP-2', name: 'WP-2: Custom Mid-Field Station', gx: 60, gy: 58, note: 'Cross-slope stratigraphic survey target' },
    { id: 'WP-3', name: 'WP-3: Custom Far Rim Target', gx: 98, gy: 48, note: 'High-relief margin near slope threshold' }
  ];

  return candidates.map((cand) => {
    let bestGx = cand.gx;
    let bestGy = cand.gy;
    if (maxSlopeDeg[bestGy * GRID_N + bestGx] >= 33.0) {
      let bestSlope = 999.0;
      for (let dy = -6; dy <= 6; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
          const gx = clamp(cand.gx + dx, 2, GRID_N - 3);
          const gy = clamp(cand.gy + dy, 2, GRID_N - 3);
          const s = maxSlopeDeg[gy * GRID_N + gx];
          if (s < bestSlope) {
            bestSlope = s;
            bestGx = gx;
            bestGy = gy;
          }
        }
      }
    }
    const km = (Math.hypot(bestGx - BASE_GX, bestGy - BASE_GY) * CELL_M) / 1000.0;
    return {
      id: cand.id,
      name: cand.name,
      distanceLabel: `${km.toFixed(2)} km`,
      gx: bestGx,
      gy: bestGy,
      scienceNote: cand.note
    };
  });
}

/**
 * Ingests an ESRI .ASC, NASA PDS .CSV, or 16-bit .RAW elevation buffer into the 150x150 solver arena,
 * recomputes slope normals, solar shadows, SVF, and 360-degree skyline horizons, and caches it under CUSTOM_MISSION_DEM.
 * @param {string} fileName
 * @param {string | ArrayBuffer | ArrayBufferView} contentOrBuffer
 * @param {boolean} [sepStormActive=false]
 * @param {object} [options]
 */
export function ingestCustomDemData(fileName, contentOrBuffer, sepStormActive = false, options = {}) {
  const t0 = performance.now();
  const formatKind = detectDemFormat(fileName, contentOrBuffer);

  let parsed;
  if (formatKind === 'asc') {
    parsed = parseEsriAscGrid(contentOrBuffer);
  } else if (formatKind === 'raw') {
    parsed = parseRaw16BitBuffer(contentOrBuffer, options);
  } else {
    parsed = parseCsvElevationTable(contentOrBuffer);
  }

  const { elevations, minElev, maxElev } = resampleBilinearToGrid(
    parsed.values,
    parsed.cols,
    parsed.rows,
    parsed.nodata
  );
  const sunLitMask = computeSunLitMask(elevations);
  const maxSlopeDeg = computeCellMaxSlopeDeg(elevations);
  const { thermalInertia, mineralConcentration } = deriveSurrogateGridsFromElevation(
    elevations,
    maxSlopeDeg,
    minElev,
    maxElev
  );
  const { horizonAnglesRad, skyViewFactor } = computeAllHorizonsAndSVF(elevations, GRID_N, CELL_M);
  const radDoseRate = new Float32Array(TOTAL_CELLS);
  const waypoints = pickSafeCustomWaypoints(maxSlopeDeg);

  const originLat = Number.isFinite(options.originLat)
    ? options.originLat
    : Number.isFinite(parsed.originLat)
      ? parsed.originLat
      : -13.91;
  const originLon = Number.isFinite(options.originLon)
    ? options.originLon
    : Number.isFinite(parsed.originLon)
      ? parsed.originLon
      : -58.42;

  const latTag = `${Math.abs(originLat).toFixed(2)}°${originLat >= 0 ? 'N' : 'S'}`;
  const lonTag = `${Math.abs(originLon).toFixed(2)}°${originLon >= 0 ? 'E' : 'W'}`;
  const ingestElapsedMs = Number((performance.now() - t0).toFixed(1));

  const dem = {
    id: 'CUSTOM_MISSION_DEM',
    isCustom: true,
    name: `Custom Ops DEM (${fileName})`,
    coordinatesLabel: `${latTag}, ${lonTag}`,
    originLat,
    originLon,
    minElev,
    maxElev,
    elevRangeLabel: `${Math.round(minElev)}m to ${Math.round(maxElev)}m`,
    description: `User-ingested ${parsed.format} (${parsed.cols}×${parsed.rows} -> 150×150 bilinear), solar shadow & SVF recomputed in ${ingestElapsedMs} ms.`,
    sourceFileName: fileName,
    sourceFormat: parsed.format,
    sourceDimensions: `${parsed.cols}×${parsed.rows}`,
    ingestElapsedMs,
    gridN: GRID_N,
    spanM: SPAN_M,
    cellM: CELL_M,
    baseGx: BASE_GX,
    baseGy: BASE_GY,
    baseIdx: BASE_IDX,
    defaultAstroGx: waypoints[0].gx,
    defaultAstroGy: waypoints[0].gy,
    elevations,
    thermalInertia,
    mineralConcentration,
    sunLitMask,
    maxSlopeDeg,
    horizonAnglesRad,
    skyViewFactor,
    radDoseRate,
    waypoints
  };

  updateRadDoseRate(dem, sepStormActive);
  siteCache.set('CUSTOM_MISSION_DEM', dem);
  return dem;
}
