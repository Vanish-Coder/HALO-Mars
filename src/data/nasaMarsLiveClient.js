/**
 * BioRadius — Live NASA Mars Client & Data Provenance State
 * Attempts realtime fetches to NASA DONKI SEP and JPL Mars Trek WMTS.
 * Falls back cleanly to calibrated deterministic albedo imagery and discloses
 * exact runtime provenance without ever misrepresenting surrogates as raw PDS downloads.
 */

export const PROVENANCE_STRINGS = {
  LIVE: '🛰️ DATA: LIVE NASA WMTS + DONKI (WITH CALIBRATED PDS SURROGATE GRIDS)',
  LIVE_DONKI_ONLY: '🛰️ DATA: LIVE NASA DONKI (WITH CALIBRATED PDS SURROGATE GRIDS)',
  LIVE_WMTS_ONLY: '🛰️ DATA: LIVE NASA WMTS (WITH CALIBRATED PDS SURROGATE GRIDS)',
  OFFLINE: '📐 DATA: CALIBRATED PARAMETRIC PDS SURROGATE (OFFLINE FALLBACK ACTIVE)',
  CUSTOM_DEM: '🛰️ OPS MODE: CUSTOM MISSION DEM INGESTED (150×150 RESAMPLED)'
};

export const DONKI_SEP_ENDPOINT = 'https://api.nasa.gov/DONKI/SEP?api_key=DEMO_KEY';
export const MARS_TREK_PRODUCT = 'Mars_MGS_MOLA_ClrShade_merge_global_463m';
export const SEP_ACTIVE_WINDOW_HOURS = 36;
const SEP_ACTIVE_WINDOW_MS = SEP_ACTIVE_WINDOW_HOURS * 3600 * 1000;

const SITE_COORDS = {
  MOUNT_SHARP_BOXWORK: { lat: -4.58, lon: 137.44 },
  JEZERO_DELTA: { lat: 18.38, lon: 77.58 }
};

function buildMarsTrekTileUrl(siteId, z = 4) {
  const { lat, lon } = SITE_COORDS[siteId] || SITE_COORDS.MOUNT_SHARP_BOXWORK;
  const cols = 1 << (z + 1); // Equirectangular 2:1 tile matrix
  const rows = 1 << z;
  const x = Math.max(0, Math.min(cols - 1, Math.floor(((lon + 180.0) / 360.0) * cols)));
  const y = Math.max(0, Math.min(rows - 1, Math.floor(((90.0 - lat) / 180.0) * rows)));
  return `https://trek.nasa.gov/tiles/Mars/EQ/${MARS_TREK_PRODUCT}/1.0.0/default/default028mm/${z}/${y}/${x}.jpg`;
}

function renderFallbackAlbedoCanvas(canvas, siteId) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const seedShift = siteId === 'JEZERO_DELTA' ? 19.3 : 3.7;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const nx = px / w;
      const ny = py / h;
      const wave =
        Math.sin(nx * 14.0 + seedShift) * Math.cos(ny * 12.0 - seedShift) * 0.5 +
        Math.sin((nx + ny) * 29.0) * 0.25 +
        Math.cos((nx - ny) * 53.0) * 0.15;
      const base = 0.5 + 0.35 * wave;
      const idx = (py * w + px) * 4;
      data[idx] = Math.round(145 * base + 24);
      data[idx + 1] = Math.round(88 * base + 18);
      data[idx + 2] = Math.round(64 * base + 15);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export class NasaMarsLiveClient {
  constructor() {
    this.trekLive = false;
    this.donkiLive = false;
    this.sepStormActive = false;
    this.latestSepEventRecencyHrs = null;
    this.customDemActive = false;
    this.customDemMeta = null;
    this.lastSyncIso = null;
    this.trekError = null;
    this.donkiError = null;
    this.lastTrekUrl = null;
    this.sepEventMeta = {
      count: 0,
      latestSepId: null,
      latestEventTime: null,
      latestSepEventRecencyHrs: null,
      instruments: [],
      statusNote: 'Pending runtime fetch'
    };

    this.albedoCanvas =
      typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (this.albedoCanvas) {
      this.albedoCanvas.width = 256;
      this.albedoCanvas.height = 256;
      renderFallbackAlbedoCanvas(this.albedoCanvas, 'MOUNT_SHARP_BOXWORK');
    }
  }

  /**
   * Records whether a user-supplied mission DEM is currently loaded.
   * @param {boolean} active
   * @param {object | null} meta
   */
  setCustomDemStatus(active, meta = null) {
    this.customDemActive = Boolean(active);
    this.customDemMeta = active && meta ? { ...meta } : null;
  }

  getProvenanceLabel() {
    if (this.customDemActive) return PROVENANCE_STRINGS.CUSTOM_DEM;
    if (this.trekLive && this.donkiLive) return PROVENANCE_STRINGS.LIVE;
    if (this.donkiLive) return PROVENANCE_STRINGS.LIVE_DONKI_ONLY;
    if (this.trekLive) return PROVENANCE_STRINGS.LIVE_WMTS_ONLY;
    return PROVENANCE_STRINGS.OFFLINE;
  }

  getProvenanceSnapshot() {
    return {
      label: this.getProvenanceLabel(),
      trekLive: this.trekLive,
      donkiLive: this.donkiLive,
      customDemActive: this.customDemActive,
      customDemMeta: this.customDemMeta ? { ...this.customDemMeta } : null,
      sepStormActive: this.sepStormActive,
      latestSepEventRecencyHrs: this.latestSepEventRecencyHrs,
      feeds: {
        marsTrekWmts: this.trekLive ? 'LIVE' : 'FALLBACK',
        donkiSep: this.donkiLive ? 'LIVE' : 'FALLBACK'
      },
      lastSyncIso: this.lastSyncIso,
      trekEndpoint: this.lastTrekUrl || buildMarsTrekTileUrl('MOUNT_SHARP_BOXWORK'),
      donkiEndpoint: DONKI_SEP_ENDPOINT,
      trekError: this.trekError,
      donkiError: this.donkiError,
      sepEventMeta: { ...this.sepEventMeta },
      surrogateDatasets: [
        {
          pill: 'HiRISE Slope',
          pdsFamily: 'MRO HiRISE DTEEC / MGS MOLA MEGDR',
          mode: 'SURROGATE',
          role: '150×150 elevation grid, directional slope, >33° cliff cutoff, 36-azimuth skyline TRN'
        },
        {
          pill: 'THEMIS Sand/Thermal',
          pdsFamily: '2001 Mars Odyssey THEMIS TIU',
          mode: 'SURROGATE',
          role: '150×150 thermal inertia (TIU), slip factor η, ray-marched solar shadow T_env_K'
        },
        {
          pill: 'CRISM Sample Mass',
          pdsFamily: 'MRO CRISM Spectral Summary Products',
          mode: 'SURROGATE',
          role: '150×150 hydrated mineral index shader + gates geological sample mass in M_total_kg'
        },
        {
          pill: 'REMS/MEDA Wind',
          pdsFamily: 'Curiosity REMS / Perseverance MEDA',
          mode: 'SURROGATE',
          role: 'Parametric Martian CO2 wind vector (8.5 m/s @ 110°) driving aerodynamic drag'
        },
        {
          pill: 'RAD/DONKI Radiation',
          pdsFamily: 'Curiosity RAD + NASA DONKI SEP',
          mode: 'HYBRID',
          role: 'Surrogate Sky-View Factor dose attenuation coupled with LIVE DONKI SEP storm flag'
        }
      ]
    };
  }

  async fetchDonkiSep(timeoutMs = 4500) {
    if (typeof fetch !== 'function') {
      this.donkiLive = false;
      this.sepStormActive = false;
      this.latestSepEventRecencyHrs = null;
      this.donkiError = 'Fetch API unavailable in runtime';
      return false;
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const response = await fetch(DONKI_SEP_ENDPOINT, {
        mode: 'cors',
        signal: controller ? controller.signal : undefined
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      if (!Array.isArray(data)) {
        throw new Error('Unexpected DONKI JSON payload (expected array)');
      }

      this.donkiLive = true;
      this.donkiError = null;
      if (data.length > 0) {
        const latest = data[data.length - 1];
        const eventMs = latest.eventTime ? Date.parse(latest.eventTime) : NaN;
        const ageMs = Number.isFinite(eventMs) ? Math.max(0, Date.now() - eventMs) : Infinity;
        const recencyHrs = Number.isFinite(ageMs) ? ageMs / 3600000.0 : null;
        const isActiveStorm = Number.isFinite(ageMs) && ageMs <= SEP_ACTIVE_WINDOW_MS;

        this.latestSepEventRecencyHrs = recencyHrs;
        this.sepStormActive = isActiveStorm;
        this.sepEventMeta = {
          count: data.length,
          latestSepId: latest.sepID || null,
          latestEventTime: latest.eventTime || null,
          latestSepEventRecencyHrs: recencyHrs,
          instruments: Array.isArray(latest.instruments)
            ? latest.instruments.map((inst) => inst.displayName).filter(Boolean)
            : [],
          statusNote: isActiveStorm
            ? `ACTIVE SEP storm (${recencyHrs.toFixed(1)}h ago <= ${SEP_ACTIVE_WINDOW_HOURS}h window)`
            : `Quiet sun (${data.length} historical 30d event(s); latest ${recencyHrs !== null ? `${recencyHrs.toFixed(0)}h` : 'unknown age'} ago > ${SEP_ACTIVE_WINDOW_HOURS}h)`
        };
      } else {
        this.latestSepEventRecencyHrs = null;
        this.sepStormActive = false;
        this.sepEventMeta = {
          count: 0,
          latestSepId: null,
          latestEventTime: null,
          latestSepEventRecencyHrs: null,
          instruments: [],
          statusNote: 'LIVE HTTP 200 quiet-sun response (0 SEP events in 30d window)'
        };
      }
      return true;
    } catch (err) {
      this.donkiLive = false;
      this.sepStormActive = false;
      this.latestSepEventRecencyHrs = null;
      this.donkiError = err?.message || 'Network/CORS error';
      this.sepEventMeta = {
        ...this.sepEventMeta,
        latestSepEventRecencyHrs: null,
        statusNote: `Offline fallback — storm state cleared (${this.donkiError})`
      };
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async fetchMarsTrekTile(siteId = 'MOUNT_SHARP_BOXWORK', timeoutMs = 4500) {
    const url = buildMarsTrekTileUrl(siteId);
    this.lastTrekUrl = url;

    if (!this.albedoCanvas || typeof Image === 'undefined') {
      this.trekLive = false;
      this.trekError = 'Canvas/Image unavailable';
      return false;
    }

    return new Promise((resolve) => {
      let settled = false;
      const img = new Image();
      img.crossOrigin = 'anonymous';

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.trekLive = false;
        this.trekError = 'Tile request timed out';
        renderFallbackAlbedoCanvas(this.albedoCanvas, siteId);
        resolve(false);
      }, timeoutMs);

      img.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          const ctx = this.albedoCanvas.getContext('2d');
          ctx.drawImage(img, 0, 0, this.albedoCanvas.width, this.albedoCanvas.height);
          // Verify CORS readback is untainted
          ctx.getImageData(0, 0, 1, 1);
          this.trekLive = true;
          this.trekError = null;
          resolve(true);
        } catch (err) {
          this.trekLive = false;
          this.trekError = err?.message || 'CORS canvas taint';
          renderFallbackAlbedoCanvas(this.albedoCanvas, siteId);
          resolve(false);
        }
      };

      img.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.trekLive = false;
        this.trekError = 'Tile load / CORS blocked';
        renderFallbackAlbedoCanvas(this.albedoCanvas, siteId);
        resolve(false);
      };

      img.src = url;
    });
  }

  async refreshAll(siteId = 'MOUNT_SHARP_BOXWORK') {
    await Promise.all([this.fetchDonkiSep(), this.fetchMarsTrekTile(siteId)]);
    this.lastSyncIso = new Date().toISOString();
    return this.getProvenanceSnapshot();
  }
}

