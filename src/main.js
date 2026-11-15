/**
 * BioRadius — Main Application Entrypoint & 4-Act Story Choreographer
 * Connects NASA surface datasets, live DONKI/Mars Trek clients, Dual-Pass Dijkstra solver,
 * 36-azimuth Skyline TRN matcher, 3D WebGL2 stage, Wayfinder Chronometer, and 7-gate audit.
 */

import {
  GRID_N,
  CELL_M,
  BASE_GX,
  BASE_GY,
  getMarsSiteDataset,
  ingestCustomDemData,
  generateSampleAscGrid
} from './data/nasaMarsDatasets.js';
import { NasaMarsLiveClient } from './data/nasaMarsLiveClient.js';
import {
  createDefaultState,
  evaluateLocalBioTelemetry
} from './physics/bioEnergeticEngine.js';
import { RangeIsochroneSolver } from './physics/rangeIsochroneSolver.js';
import {
  SkylineTerrainMatcher,
  updateRadDoseRate
} from './physics/skylineTerrainMatcher.js';
import { computePowerProfile } from './physics/coinCellPowerProfiler.js';
import { runMathAuditSuite } from './physics/mathAuditGate.js';
import { ThreeNavigationMap } from './ui/ThreeNavigationMap.js';
import { AstronautChronometer } from './ui/AstronautChronometer.js';
import { iconSvg, LAYER_ICON_NAMES } from './ui/icons.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const BLACKBOX_STORAGE_KEY = 'bioradius-blackbox-v1';
const BLACKBOX_CAP = 3600;
const LIMITER_CODES = ['BIO', 'O2', 'BATT', 'RAD'];
const SITE_CODES = ['MOUNT_SHARP_BOXWORK', 'JEZERO_DELTA', 'CUSTOM_MISSION_DEM'];
const LAYER_COLOR_KEYS = {
  topo: 'HiRISE: Rust/Ochre Relief • Red = >33° Impassable Cliffs',
  themis: 'THEMIS: Gold = Loose Drift Sand • Cool Blue = Solid Rock & Frost',
  crism: 'CRISM: Dark Teal = Low • Green → Magenta = Hydrated Minerals',
  meda: 'MEDA: Ice Cyan = High Katabatic Wind • Dark = Sheltered Lee',
  rad: 'RAD: Deep Indigo = Canyon Shelter (SVF) • Magenta/Red = Exposed Plain'
};
const STORY_ACT1_LAYER_NOTES = {
  topo: 'Now Showing Layer 1/5: HiRISE Steep Cliffs — red slopes (>33°) are blocked so routes detour safely.',
  themis: 'Now Showing Layer 2/5: THEMIS Loose Sand — gold drift traps burn extra leg energy vs. cool blue bedrock.',
  crism: 'Now Showing Layer 3/5: CRISM Hydrated Clay — highlights clay science outcrops & surface dust drag.',
  meda: 'Now Showing Layer 4/5: MEDA Slope Wind — visualizes katabatic headwinds vs. calm canyon lee.',
  rad: 'Now Showing Layer 5/5: RAD Shielding — compares canyon wall radiation shelter vs. exposed plains.'
};
const STORY_LAYER_SHORT_LABELS = {
  topo: 'HiRISE Cliffs',
  themis: 'THEMIS Sand/Thermal',
  crism: 'CRISM Hydrated Clay',
  meda: 'MEDA Slope Wind',
  rad: 'RAD Shielding'
};

/**
 * Decodes standard Bluetooth GATT 0x2A37 Heart Rate Measurement characteristics.
 * @param {DataView} dataView
 * @returns {number | null}
 */
export function parseBleHeartRateMeasurement(dataView) {
  if (!dataView || dataView.byteLength < 2) return null;
  const flags = dataView.getUint8(0);
  const isUint16 = (flags & 0x01) !== 0;
  if (isUint16) {
    return dataView.byteLength >= 3 ? dataView.getUint16(1, true) : null;
  }
  return dataView.getUint8(1);
}

class BioRadiusApp {
  constructor() {
    this.datasetCache = new Map();
    this.activeSiteId = 'MOUNT_SHARP_BOXWORK';
    this.activeDem = this.getOrLoadSite(this.activeSiteId);

    this.state = createDefaultState();
    this.state.activeLayer = 'topo';

    this.solver = new RangeIsochroneSolver();
    this.matcher = new SkylineTerrainMatcher();
    this.liveClient = new NasaMarsLiveClient();
    this.chronometer = new AstronautChronometer();

    this.localTelemetryScratch = {};
    this.lastSkylineKey = '';
    this.lastSkylineResult = null;
    this.lastHeroMetrics = null;
    this.evaElapsedSec = 4462; // 01:14:22 nominal EVA clock start

    this._rafSolvePending = false;
    this._pendingSolveFlags = {
      forcePass1: true,
      refreshAttribution: true,
      skipSkyline: false
    };
    this._attributionTimer = null;
    this._storyTimers = [];
    this._storyRampInterval = null;
    this._storyRunning = false;

    // Live hardware telemetry & pre-allocated 1 Hz black-box ring buffer
    this._bleDevice = null;
    this._bleChar = null;
    this._bleStreaming = false;
    this._onBleValueChanged = null;
    this._onBleDisconnected = null;
    this._imuActive = false;
    this._imuHeadingDeg = null;
    this._geoWatchId = null;
    this._geoOrigin = null;
    this._lastImuSolveMs = 0;
    this._onDeviceOrientation = null;
    this._viewportDragDepth = 0;
    this.activeDockTab = 'controls';
    this._lastWorkspaceTab = 'controls';
    this.blackBox = {
      cap: BLACKBOX_CAP,
      head: 0,
      count: 0,
      epochSec: new Float64Array(BLACKBOX_CAP),
      evaSec: new Uint32Array(BLACKBOX_CAP),
      siteCode: new Uint8Array(BLACKBOX_CAP),
      gx: new Int16Array(BLACKBOX_CAP),
      gy: new Int16Array(BLACKBOX_CAP),
      hr: new Float32Array(BLACKBOX_CAP),
      kcal: new Float32Array(BLACKBOX_CAP),
      o2Kg: new Float32Array(BLACKBOX_CAP),
      battWh: new Float32Array(BLACKBOX_CAP),
      marginPct: new Float32Array(BLACKBOX_CAP),
      limiterCode: new Uint8Array(BLACKBOX_CAP)
    };

    this.dom = this.cacheDomElements();
    this._colorSchemeMq =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    this.state.lightMode = this.resolveIsLightScheme();

    this.map3d = new ThreeNavigationMap(this.dom.threeHost, {
      onAstroDrag: (gx, gy) => {
        this.interruptStory();
        if (this.state.astroGx === gx && this.state.astroGy === gy) return;
        this.state.astroGx = gx;
        this.state.astroGy = gy;
        this.scheduleSolve({ forcePass1: false, refreshAttribution: false, skipSkyline: false });
        this.scheduleDebouncedAttribution();
      },
      onWaypointClick: (wpIdx) => {
        this.interruptStory();
        const wp = this.activeDem.waypoints[wpIdx];
        if (wp) this.jumpToWaypoint(wp);
      }
    });

    this.matcher.buildIndex(this.activeDem);
    this.map3d.syncAlbedoCanvas(this.liveClient.albedoCanvas);
    this.map3d.setSiteDataset(this.activeDem);

    this.auditReport = runMathAuditSuite(this.activeDem, this.solver, this.matcher);
    this.renderAuditUi();

    this.bindUiEvents();
    this.applyThemeFromScheme(false);
    this.renderWaypointPills();
    this.syncLayerUi();
    this.syncControlsFromState();

    // Execute initial solve, contours, skyline TRN lock, and counterfactual attribution
    this.executeSolveNow({ forcePass1: true, refreshAttribution: true, skipSkyline: false });

    // Start 1 Hz watch clock ticker (honors Eco Mode without waking WebGL loop)
    this._clockTimer = setInterval(() => {
      this.evaElapsedSec += 1;
      if (this.lastHeroMetrics) {
        const powerProfile = computePowerProfile(this.state.ecoMode, this.state.ecoMode ? 1 : 60);
        this.chronometer.renderWayfinderWatch(
          this.lastHeroMetrics,
          this.localTelemetryScratch,
          powerProfile,
          this.state,
          this.evaElapsedSec
        );
        this.recordBlackBoxFrame();
      }
    }, 1000);

    // Record initial frame & reflect any prior opt-in black-box snapshot count
    this.recordBlackBoxFrame();
    this.updateOpsStatusUi();

    // Kick off non-blocking NASA WMTS + DONKI SEP fetch
    this.refreshLiveNasaFeeds(this.activeSiteId);
  }

  cacheDomElements() {
    return {
      threeHost: document.getElementById('three-canvas-host'),
      siteButtons: Array.from(document.querySelectorAll('#site-switcher .seg-btn')),
      provenancePill: document.getElementById('data-provenance-pill'),
      auditPill: document.getElementById('audit-pill'),
      themeToggleBtn: document.getElementById('theme-toggle-btn'),
      playStoryBtn: document.getElementById('play-story-btn'),
      storyBanner: document.getElementById('story-caption-banner'),
      storyKicker: document.getElementById('story-caption-kicker'),
      storyTitle: document.getElementById('story-caption-title'),
      storyBody: document.getElementById('story-caption-body'),
      storyLive: document.getElementById('story-caption-live'),
      storyProgress: document.getElementById('story-caption-progress'),
      storyCloseBtn: document.getElementById('story-caption-close'),
      storyActPills: Array.from(document.querySelectorAll('[data-story-act]')),
      hudPinCoords: document.getElementById('hud-pin-coords'),
      hudElevRad: document.getElementById('hud-elev-rad'),
      hudSolverMs: document.getElementById('hud-solver-ms'),
      hudTrnLock: document.getElementById('hud-trn-lock'),
      waypointPills: document.getElementById('waypoint-pills'),
      waypointPillsDock: document.getElementById('waypoint-pills-dock'),
      layerPills: Array.from(document.querySelectorAll('#layer-bar .layer-pill')),
      layerShaderBtns: Array.from(document.querySelectorAll('#layer-bar .layer-shader-btn')),
      layerPhysicsBoxes: Array.from(document.querySelectorAll('#layer-bar input[data-physics]')),
      activeLayerKey: document.getElementById('active-layer-key'),
      impactBadges: {
        topo: document.getElementById('impact-topo'),
        themis: document.getElementById('impact-themis'),
        crism: document.getElementById('impact-crism'),
        meda: document.getElementById('impact-meda'),
        rad: document.getElementById('impact-rad')
      },
      ecoOverlay: document.getElementById('eco-overlay'),
      ecoToggleBtn: document.getElementById('eco-toggle-btn'),
      ecoResumeBtn: document.getElementById('eco-resume-btn'),
      actIndicator: document.getElementById('act-indicator'),
      sliderHr: document.getElementById('slider-hr'),
      valHr: document.getElementById('val-hr'),
      sliderMass: document.getElementById('slider-mass'),
      valMass: document.getElementById('val-mass'),
      sliderKcal: document.getElementById('slider-kcal'),
      valKcal: document.getElementById('val-kcal'),
      collectSampleBtn: document.getElementById('btn-collect-sample'),
      dockTabBtns: Array.from(document.querySelectorAll('.dock-tab-btn')),
      dockTabPanels: Array.from(document.querySelectorAll('.dock-tab-panel')),
      dockQuickDialogBtns: Array.from(document.querySelectorAll('[data-open-dialog]')),
      drawerSkyline: document.getElementById('drawer-skyline'),
      drawerVitals: document.getElementById('drawer-vitals'),
      workspaceSplit: document.getElementById('workspace-split'),
      guideBackBtn: document.getElementById('btn-guide-back'),
      sarPill: document.getElementById('sar-pill'),
      provenanceDialog: document.getElementById('provenance-dialog'),
      provenanceDialogBody: document.getElementById('provenance-dialog-body'),
      auditDialog: document.getElementById('audit-dialog'),
      auditDialogBody: document.getElementById('audit-dialog-body'),
      sarDialog: document.getElementById('sar-dialog'),
      opsDialog: document.getElementById('ops-dialog'),
      guideDialog: document.getElementById('guide-dialog'),
      viewportStage: document.getElementById('viewport-stage'),
      viewportDropOverlay: document.getElementById('viewport-drop-overlay'),
      siteCustomBtn: document.getElementById('btn-site-custom'),
      dropzoneDem: document.getElementById('dropzone-dem'),
      inputCustomDem: document.getElementById('input-custom-dem'),
      btnChooseDem: document.getElementById('btn-choose-dem'),
      btnSampleDem: document.getElementById('btn-sample-dem'),
      demIngestStatus: document.getElementById('dem-ingest-status'),
      btnPairBle: document.getElementById('btn-pair-ble'),
      btnLinkImu: document.getElementById('btn-link-imu'),
      hwModeStatus: document.getElementById('hw-mode-status'),
      btnRestoreEva: document.getElementById('btn-restore-eva'),
      btnClearBlackbox: document.getElementById('btn-clear-blackbox'),
      blackboxStatus: document.getElementById('blackbox-status'),
      btnExportGeojson: document.getElementById('btn-export-geojson'),
      btnExportGpx: document.getElementById('btn-export-gpx'),
      btnExportCsv: document.getElementById('btn-export-csv'),
      exportStatus: document.getElementById('export-status'),
      globalUiTooltip: document.getElementById('global-ui-tooltip')
    };
  }

  getOrLoadSite(siteId) {
    if (!this.datasetCache.has(siteId)) {
      this.datasetCache.set(siteId, getMarsSiteDataset(siteId));
    }
    return this.datasetCache.get(siteId);
  }

  bindUiEvents() {
    // Landing Site Switcher
    this.dom.siteButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.interruptStory();
        this.state.sepStormActive = Boolean(
          this.liveClient.donkiLive && this.liveClient.sepStormActive
        );
        this.switchSite(btn.dataset.site);
      });
    });

    // NASA Layer Shader Buttons & Physics Toggle Checkboxes
    this.dom.layerShaderBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.interruptStory();
        this.setActiveLayer(btn.dataset.shader);
      });
    });

    this.dom.layerPhysicsBoxes.forEach((box) => {
      box.addEventListener('change', () => {
        this.interruptStory();
        const key = box.dataset.physics;
        this.state.layers[key] = box.checked;
        this.state.activeLayer = key;
        this.syncLayerUi();
        this.scheduleSolve({ forcePass1: true, refreshAttribution: true, skipSkyline: true });
      });
    });

    // Primary Biometric & Reserve Sliders
    this.dom.sliderHr.addEventListener('input', () => {
      this.interruptStory();
      this.state.hrBpm = Number(this.dom.sliderHr.value);
      this.dom.valHr.textContent = `${Math.round(this.state.hrBpm)} BPM`;
      this.scheduleSolve({ forcePass1: true, refreshAttribution: false, skipSkyline: true });
      this.scheduleDebouncedAttribution();
    });

    this.dom.sliderMass.addEventListener('input', () => {
      this.interruptStory();
      const totalCarry = Number(this.dom.sliderMass.value);
      this.state.suitAndSampleMassKg = totalCarry;
      this.state.sampleMassKg = Math.max(0, totalCarry - this.state.suitMassKg);
      this.dom.valMass.textContent = `${Math.round(totalCarry)} kg`;
      this.scheduleSolve({ forcePass1: true, refreshAttribution: false, skipSkyline: true });
      this.scheduleDebouncedAttribution();
    });

    this.dom.sliderKcal.addEventListener('input', () => {
      this.interruptStory();
      this.state.calorieReserveKcal = Number(this.dom.sliderKcal.value);
      this.dom.valKcal.textContent = `${Math.round(this.state.calorieReserveKcal)} kcal`;
      this.scheduleSolve({ forcePass1: true, refreshAttribution: false, skipSkyline: true });
      this.scheduleDebouncedAttribution();
    });

    // +15 kg Boxwork Core Sample Collection Action
    this.dom.collectSampleBtn.addEventListener('click', () => {
      this.interruptStory();
      this.state.layers.crism = true;
      this.state.suitAndSampleMassKg = Math.min(120, this.state.suitAndSampleMassKg + 15);
      this.state.sampleMassKg = Math.max(0, this.state.suitAndSampleMassKg - this.state.suitMassKg);
      this.syncControlsFromState();
      this.syncLayerUi();
      this.scheduleSolve({ forcePass1: true, refreshAttribution: true, skipSkyline: true });
    });

    // CR2032 1Hz Eco Mode Toggles
    this.dom.ecoToggleBtn.addEventListener('click', () => {
      this.interruptStory();
      this.setEcoMode(!this.state.ecoMode);
    });
    this.dom.ecoResumeBtn.addEventListener('click', () => {
      this.interruptStory();
      this.setEcoMode(false);
    });

    // Lite / Dark UI Theme Toggle + OS & Storage Listeners
    if (this.dom.themeToggleBtn) {
      this.dom.themeToggleBtn.addEventListener('click', () => this.toggleColorScheme());
    }
    if (this._colorSchemeMq) {
      this._colorSchemeMq.addEventListener('change', () => this.applyThemeFromScheme(true));
    }
    window.addEventListener('storage', (ev) => {
      if (ev.key !== 'color-scheme') return;
      const meta = document.querySelector('meta[name="color-scheme"]');
      if (meta) {
        meta.content = ev.newValue === 'dark' ? 'dark' : 'light';
      }
      this.applyThemeFromScheme(true);
    });

    // Story Mode Play Button, Interactive Story Chapters & Hotkeys 1–4
    this.dom.playStoryBtn.addEventListener('click', () => {
      if (this._storyRunning) {
        this.interruptStory();
      } else {
        this.play30sStory();
      }
    });
    if (this.dom.storyCloseBtn) {
      this.dom.storyCloseBtn.addEventListener('click', () => this.interruptStory());
    }
    this.dom.storyActPills.forEach((btn) => {
      btn.addEventListener('click', () => {
        const actNum = Number(btn.dataset.storyAct);
        this.interruptStory();
        this.runStoryAct(actNum, { animateRamp: true });
      });
    });

    window.addEventListener('keydown', (ev) => {
      if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) {
        if (ev.key !== '1' && ev.key !== '2' && ev.key !== '3' && ev.key !== '4') return;
      }
      if (ev.key === '1') {
        this.interruptStory();
        this.runStoryAct(1);
      } else if (ev.key === '2') {
        this.interruptStory();
        this.runStoryAct(2);
      } else if (ev.key === '3') {
        this.interruptStory();
        this.runStoryAct(3);
      } else if (ev.key === '4') {
        this.interruptStory();
        this.runStoryAct(4);
      } else if (ev.key === '?') {
        const nextTab =
          this.activeDockTab === 'guide' ? this._lastWorkspaceTab || 'controls' : 'guide';
        this.setActiveDockTab(nextTab);
      } else if (ev.key === 'Escape') {
        if (this.activeDockTab === 'guide') {
          this.setActiveDockTab(this._lastWorkspaceTab || 'controls');
        }
        if (this.dom.provenanceDialog.open) this.dom.provenanceDialog.close();
        if (this.dom.auditDialog.open) this.dom.auditDialog.close();
        if (this.dom.sarDialog.open) this.dom.sarDialog.close();
        if (this.dom.opsDialog?.open) this.dom.opsDialog.close();
      }
    });

    // Modal Open / Close Triggers
    this.dom.provenancePill.addEventListener('click', () => this.openModalById('provenance-dialog'));
    this.dom.auditPill.addEventListener('click', () => this.openModalById('audit-dialog'));
    this.dom.sarPill.addEventListener('click', () => this.openModalById('sar-dialog'));

    // Single Top Navigation Bar & Dedicated Guide Page Switching
    this.dom.dockTabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setActiveDockTab(btn.dataset.dockTab);
      });
    });

    this.dom.guideBackBtn?.addEventListener('click', () => {
      this.setActiveDockTab(this._lastWorkspaceTab || 'controls');
    });

    if (this.dom.hudTrnLock) {
      const openHorizonTab = () => this.setActiveDockTab('horizon');
      this.dom.hudTrnLock.addEventListener('click', openHorizonTab);
      this.dom.hudTrnLock.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openHorizonTab();
        }
      });
    }
    this.dom.dockQuickDialogBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.openModalById(btn.dataset.openDialog);
      });
    });

    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dlg = document.getElementById(btn.dataset.close);
        if (dlg && dlg.open) dlg.close();
      });
    });

    [
      this.dom.provenanceDialog,
      this.dom.auditDialog,
      this.dom.sarDialog,
      this.dom.opsDialog
    ].forEach((dlg) => {
      if (!dlg) return;
      dlg.addEventListener('click', (ev) => {
        if (ev.target === dlg) dlg.close();
      });
    });

    this.bindOpsEvents();
  }

  bindOpsEvents() {
    this.dom.btnChooseDem?.addEventListener('click', () => {
      this.dom.inputCustomDem?.click();
    });

    this.dom.inputCustomDem?.addEventListener('change', (ev) => {
      const file = ev.target?.files?.[0];
      if (file) {
        this.handleCustomDemFile(file);
        ev.target.value = '';
      }
    });

    this.dom.btnSampleDem?.addEventListener('click', () => {
      this.interruptStory();
      this.ingestAndSwitchCustomDem('VallesMarineris_Sample160.asc', generateSampleAscGrid());
    });

    // Full-viewport & dialog dropzone drag-and-drop ingestion
    const attachDropTarget = (el, onState) => {
      if (!el) return;
      el.addEventListener('dragenter', (ev) => {
        ev.preventDefault();
        onState(true);
      });
      el.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
      });
      el.addEventListener('dragleave', (ev) => {
        if (!ev.relatedTarget || !el.contains(ev.relatedTarget)) {
          onState(false);
        }
      });
      el.addEventListener('drop', (ev) => {
        ev.preventDefault();
        onState(false);
        const file = ev.dataTransfer?.files?.[0];
        if (file) this.handleCustomDemFile(file);
      });
    };

    attachDropTarget(this.dom.dropzoneDem, (active) => {
      this.dom.dropzoneDem?.classList.toggle('is-dragover', active);
    });
    attachDropTarget(this.dom.viewportStage, (active) => {
      if (this.dom.viewportDropOverlay) {
        this.dom.viewportDropOverlay.hidden = !active;
      }
    });

    // Live Hardware Telemetry vs Planner Sim
    this.dom.btnPairBle?.addEventListener('click', () => {
      this.pairBleHeartRate();
    });
    this.dom.btnLinkImu?.addEventListener('click', () => {
      this.toggleImuGpsLink();
    });

    // Black-box Recorder (opt-in restore + clear)
    this.dom.btnRestoreEva?.addEventListener('click', () => {
      this.restoreLastEvaSession();
    });
    this.dom.btnClearBlackbox?.addEventListener('click', () => {
      this.clearBlackBoxLog();
    });

    // Interoperable Ops Exports
    this.dom.btnExportGeojson?.addEventListener('click', () => {
      this.downloadGeoJsonPerimeter();
    });
    this.dom.btnExportGpx?.addEventListener('click', () => {
      this.downloadGpxReturnCorridor();
    });
    this.dom.btnExportCsv?.addEventListener('click', () => {
      this.downloadBlackBoxCsv();
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.persistBlackBoxToStorage();
      });
    }

    this.initGlobalTooltips();
  }

  /**
   * Initializes viewport-clamped floating tooltips (`#global-ui-tooltip`) for every `.layer-info` badge.
   * Re-hosts inside an open `<dialog>` Top Layer so tooltips are never clipped by scroll containers.
   */
  initGlobalTooltips() {
    const portal = this.dom.globalUiTooltip;
    if (typeof document === 'undefined' || !portal) return;

    document.body.classList.add('ui-tooltips-ready');
    this._activeTooltipTrigger = null;
    this._pinnedTooltipTrigger = null;

    const showFor = (trigger) => {
      const tpl = trigger?.querySelector('.layer-tooltip');
      if (!tpl) return;

      if (this._activeTooltipTrigger && this._activeTooltipTrigger !== trigger) {
        this._activeTooltipTrigger.removeAttribute('aria-expanded');
      }
      this._activeTooltipTrigger = trigger;
      trigger.setAttribute('aria-expanded', 'true');

      const mountHost = trigger.closest('dialog[open]') || document.body;
      if (portal.parentNode !== mountHost) {
        mountHost.appendChild(portal);
      }

      portal.innerHTML = tpl.innerHTML;
      portal.setAttribute('aria-hidden', 'false');
      portal.style.left = '0px';
      portal.style.top = '0px';
      portal.classList.add('is-visible');

      // Measure `refRect` at `(0, 0)` to auto-compensate for any ancestor containing block
      // (such as `backdrop-filter` on `<dialog class="glass-dialog">`).
      const refRect = portal.getBoundingClientRect();
      const rect = trigger.getBoundingClientRect();
      const margin = 10;

      const minLeft = margin;
      const maxLeft = Math.max(minLeft, window.innerWidth - refRect.width - margin);
      let left = rect.left + rect.width / 2 - refRect.width / 2;
      left = Math.max(minLeft, Math.min(maxLeft, left));

      const minTop = margin;
      const maxTop = Math.max(minTop, window.innerHeight - refRect.height - margin);
      let top = rect.top - refRect.height - 9;
      if (top < minTop) {
        top = Math.min(maxTop, rect.bottom + 9);
      }
      top = Math.max(minTop, Math.min(maxTop, top));

      portal.style.left = `${Math.round(left - refRect.left)}px`;
      portal.style.top = `${Math.round(top - refRect.top)}px`;
    };

    const hide = (clearPin = false) => {
      if (clearPin) this._pinnedTooltipTrigger = null;
      if (this._activeTooltipTrigger) {
        this._activeTooltipTrigger.removeAttribute('aria-expanded');
        this._activeTooltipTrigger = null;
      }
      portal.classList.remove('is-visible');
      portal.setAttribute('aria-hidden', 'true');
    };

    this._hideGlobalTooltip = hide;

    document.addEventListener('pointerover', (ev) => {
      const trigger = ev.target?.closest?.('.layer-info');
      if (trigger) showFor(trigger);
    });

    document.addEventListener('pointerout', (ev) => {
      const trigger = ev.target?.closest?.('.layer-info');
      if (!trigger) return;
      if (ev.relatedTarget?.closest?.('.layer-info') === trigger) return;
      if (this._pinnedTooltipTrigger !== trigger) {
        hide(false);
      }
    });

    document.addEventListener('focusin', (ev) => {
      const trigger = ev.target?.closest?.('.layer-info');
      if (trigger) showFor(trigger);
    });

    document.addEventListener('focusout', (ev) => {
      const trigger = ev.target?.closest?.('.layer-info');
      if (!trigger) return;
      if (this._pinnedTooltipTrigger !== trigger) {
        hide(false);
      }
    });

    document.addEventListener('click', (ev) => {
      const trigger = ev.target?.closest?.('.layer-info');
      if (trigger) {
        ev.preventDefault();
        ev.stopPropagation();
        if (this._pinnedTooltipTrigger === trigger) {
          hide(true);
        } else {
          this._pinnedTooltipTrigger = trigger;
          showFor(trigger);
        }
        return;
      }
      if (this._pinnedTooltipTrigger) hide(true);
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') hide(true);
    });

    document.addEventListener(
      'scroll',
      () => {
        if (this._activeTooltipTrigger) hide(true);
      },
      { passive: true, capture: true }
    );
  }

  openModalById(dialogId) {
    if (!dialogId) return;
    this._hideGlobalTooltip?.(true);
    if (dialogId === 'provenance-dialog') {
      this.renderProvenanceDialog();
      this.dom.provenanceDialog?.showModal();
    } else if (dialogId === 'ops-dialog') {
      this.updateOpsStatusUi();
      this.dom.opsDialog?.showModal();
    } else if (dialogId === 'audit-dialog') {
      this.dom.auditDialog?.showModal();
    } else if (dialogId === 'sar-dialog') {
      this.dom.sarDialog?.showModal();
    } else if (dialogId === 'guide-dialog') {
      this.setActiveDockTab('guide');
    }
  }

  /**
   * Switches the Top Navigation view between workspace dock tabs and the full-page EVA Guide.
   * @param {'controls' | 'vitals' | 'horizon' | 'guide'} tabName
   */
  setActiveDockTab(tabName) {
    if (!tabName) return;
    this._hideGlobalTooltip?.(true);
    const resolvedTab = tabName === 'vitals' ? 'controls' : tabName;
    const wasGuide = this.activeDockTab === 'guide' || Boolean(this.dom.workspaceSplit?.hidden);
    this.activeDockTab = resolvedTab;

    this.dom.dockTabBtns.forEach((btn) => {
      const isMatch = btn.dataset.dockTab === resolvedTab;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    if (resolvedTab === 'guide') {
      if (this.dom.workspaceSplit) this.dom.workspaceSplit.hidden = true;
      if (this.dom.guideDialog) this.dom.guideDialog.hidden = false;
      return;
    }

    this._lastWorkspaceTab = resolvedTab;
    if (this.dom.guideDialog) this.dom.guideDialog.hidden = true;
    if (this.dom.workspaceSplit) this.dom.workspaceSplit.hidden = false;

    this.dom.dockTabPanels.forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== resolvedTab;
    });

    if (wasGuide && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('resize'));
    }

    if (resolvedTab === 'controls' && this.lastHeroMetrics) {
      const powerProfile = computePowerProfile(this.state.ecoMode, this.state.ecoMode ? 1 : 60);
      this.chronometer.renderWayfinderWatch(
        this.lastHeroMetrics,
        this.localTelemetryScratch,
        powerProfile,
        this.state,
        this.evaElapsedSec
      );
      this.chronometer.renderVitalsAndSparkline(
        this.localTelemetryScratch,
        this.lastHeroMetrics,
        this.state
      );
    } else if (resolvedTab === 'horizon' && this.lastSkylineResult) {
      this.chronometer.renderSkylinePlot(this.lastSkylineResult, this.state);
    }
  }

  updateProvenancePillUi() {
    if (!this.dom.provenancePill) return;
    const lc = this.liveClient;
    let shortLabel = 'Data: Mars Sim (Offline)';
    if (lc.customDemActive) {
      shortLabel = 'Data: Custom DEM';
    } else if (lc.trekLive && lc.donkiLive) {
      shortLabel = 'Data: Live NASA (WMTS + DONKI)';
    } else if (lc.donkiLive) {
      shortLabel = 'Data: Live NASA DONKI';
    } else if (lc.trekLive) {
      shortLabel = 'Data: Live Mars Trek';
    }

    this.dom.provenancePill.innerHTML = `${iconSvg('radio', 'ui-icon ui-icon-sm')} ${escapeHtml(shortLabel)}`;
    this.dom.provenancePill.title = `${lc.getProvenanceLabel()} (Click for details)`;
    this.dom.provenancePill.classList.toggle(
      'is-live',
      Boolean(lc.customDemActive || lc.trekLive || lc.donkiLive)
    );
  }

  async refreshLiveNasaFeeds(siteId) {
    const snap = await this.liveClient.refreshAll(siteId);
    if (this.activeSiteId !== siteId) return;

    this.updateProvenancePillUi();

    this.map3d.syncAlbedoCanvas(this.liveClient.albedoCanvas);

    // Always synchronize storm state with live DONKI status outside story playback
    // (clears prior live or Act 3 storm state if DONKI goes offline or reports quiet sun)
    if (!this._storyRunning) {
      const nextStorm = Boolean(snap.donkiLive && snap.sepStormActive);
      const stormChanged = this.state.sepStormActive !== nextStorm;
      this.state.sepStormActive = nextStorm;
      updateRadDoseRate(this.activeDem, nextStorm);
      if (stormChanged) {
        this.executeSolveNow({ forcePass1: true, refreshAttribution: true, skipSkyline: true });
      } else {
        this.map3d.updateNavigationState(this.activeDem, this.state, this.solver, this.lastHeroMetrics);
      }
    } else {
      this.map3d.updateNavigationState(this.activeDem, this.state, this.solver, this.lastHeroMetrics);
    }
  }

  switchSite(siteId, { skipSolve = false } = {}) {
    const allowed =
      siteId === 'MOUNT_SHARP_BOXWORK' ||
      siteId === 'JEZERO_DELTA' ||
      (siteId === 'CUSTOM_MISSION_DEM' && this.datasetCache.has('CUSTOM_MISSION_DEM'));
    if (!siteId || !allowed) return;

    this.activeSiteId = siteId;
    this.activeDem = this.getOrLoadSite(siteId);
    const isCustom = siteId === 'CUSTOM_MISSION_DEM';
    this.liveClient.setCustomDemStatus(
      isCustom,
      isCustom
        ? {
            fileName: this.activeDem.sourceFileName,
            format: this.activeDem.sourceFormat,
            dimensions: this.activeDem.sourceDimensions,
            ingestElapsedMs: this.activeDem.ingestElapsedMs
          }
        : null
    );
    this.updateProvenancePillUi();

    updateRadDoseRate(this.activeDem, this.state.sepStormActive);
    this.matcher.buildIndex(this.activeDem);

    this.state.astroGx = this.activeDem.defaultAstroGx;
    this.state.astroGy = this.activeDem.defaultAstroGy;
    this.lastSkylineKey = '';

    this.dom.siteButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.site === siteId);
    });

    this.map3d.setSiteDataset(this.activeDem);
    this.renderWaypointPills();
    if (!skipSolve) {
      this.executeSolveNow({ forcePass1: true, refreshAttribution: true, skipSkyline: false });
    }

    if (!isCustom) {
      this.liveClient.fetchMarsTrekTile(siteId).then(() => {
        if (this.activeSiteId !== siteId) return;
        this.map3d.syncAlbedoCanvas(this.liveClient.albedoCanvas);
        this.map3d.updateNavigationState(this.activeDem, this.state, this.solver, this.lastHeroMetrics);
        this.updateProvenancePillUi();
      });
    } else {
      this.map3d.syncAlbedoCanvas(null);
      this.map3d.updateNavigationState(this.activeDem, this.state, this.solver, this.lastHeroMetrics);
    }
  }

  setActiveLayer(layerKey) {
    if (!layerKey) return;
    this.state.activeLayer = layerKey;
    this.syncLayerUi();
    this.map3d.updateNavigationState(this.activeDem, this.state, this.solver, this.lastHeroMetrics);
  }

  syncLayerUi() {
    this.dom.layerPills.forEach((pill) => {
      const key = pill.dataset.layer;
      pill.classList.toggle('active', this.state.activeLayer === key);
      pill.classList.toggle('is-disabled', !this.state.layers[key]);
    });
    this.dom.layerPhysicsBoxes.forEach((box) => {
      box.checked = !!this.state.layers[box.dataset.physics];
    });
    if (this.dom.activeLayerKey) {
      const key = this.state.activeLayer || 'topo';
      const isEnabled = this.state.layers[key] !== false;
      const baseDesc = LAYER_COLOR_KEYS[key] || LAYER_COLOR_KEYS.topo;
      const iconName = LAYER_ICON_NAMES[key] || 'mountain';
      const desc = isEnabled ? baseDesc : `${baseDesc} (Bypassed in Route)`;
      this.dom.activeLayerKey.innerHTML = `${iconSvg(iconName, 'ui-icon ui-icon-sm')} ${escapeHtml(desc)}`;
      this.dom.activeLayerKey.classList.toggle('is-bypassed', !isEnabled);
    }
  }

  syncControlsFromState() {
    this.dom.sliderHr.value = String(Math.round(this.state.hrBpm));
    this.dom.valHr.textContent = `${Math.round(this.state.hrBpm)} BPM`;

    this.dom.sliderMass.value = String(Math.round(this.state.suitAndSampleMassKg));
    this.dom.valMass.textContent = `${Math.round(this.state.suitAndSampleMassKg)} kg`;

    this.dom.sliderKcal.value = String(Math.round(this.state.calorieReserveKcal));
    this.dom.valKcal.textContent = `${Math.round(this.state.calorieReserveKcal)} kcal`;
  }

  renderWaypointPills() {
    const hosts = [this.dom.waypointPills, this.dom.waypointPillsDock].filter(Boolean);
    if (!hosts.length) return;
    hosts.forEach((host) => {
      host.innerHTML = '';
      this.activeDem.waypoints.forEach((wp) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wp-jump-btn mono-num';
        btn.textContent = `${wp.id} (${wp.distanceLabel})`;
        btn.title = `${wp.name} — ${wp.scienceNote}`;
        btn.addEventListener('click', () => {
          this.interruptStory();
          this.jumpToWaypoint(wp);
        });
        host.appendChild(btn);
      });
    });
  }

  jumpToWaypoint(wp) {
    this.state.astroGx = wp.gx;
    this.state.astroGy = wp.gy;
    this.executeSolveNow({ forcePass1: false, refreshAttribution: false, skipSkyline: false });
    this.scheduleDebouncedAttribution();
  }

  setEcoMode(enabled) {
    this.state.ecoMode = !!enabled;
    const powerProfile = this.map3d.setEcoMode(this.state.ecoMode);

    document.body.classList.toggle('eco-active', this.state.ecoMode);
    if (this.dom.ecoOverlay) {
      this.dom.ecoOverlay.classList.toggle('hidden', !this.state.ecoMode);
      this.dom.ecoOverlay.setAttribute('aria-hidden', this.state.ecoMode ? 'false' : 'true');
    }
    if (this.dom.ecoToggleBtn) {
      this.dom.ecoToggleBtn.setAttribute('aria-pressed', this.state.ecoMode ? 'true' : 'false');
    }

    if (this.lastHeroMetrics) {
      this.chronometer.renderWayfinderWatch(
        this.lastHeroMetrics,
        this.localTelemetryScratch,
        powerProfile,
        this.state,
        this.evaElapsedSec
      );
      if (this.lastSkylineResult) {
        this.chronometer.renderSkylinePlot(this.lastSkylineResult, this.state);
      }
      this.chronometer.renderVitalsAndSparkline(this.localTelemetryScratch, this.lastHeroMetrics, this.state);
    }
    this.map3d.updateNavigationState(this.activeDem, this.state, this.solver, this.lastHeroMetrics);
  }

  getSystemPrefersDark() {
    return this._colorSchemeMq ? this._colorSchemeMq.matches : true;
  }

  resolveIsLightScheme() {
    const meta =
      typeof document !== 'undefined' ? document.querySelector('meta[name="color-scheme"]') : null;
    const content = meta ? meta.content.trim() : 'light';
    return content !== 'dark';
  }

  toggleColorScheme() {
    const nextLight = !this.resolveIsLightScheme();
    const targetScheme = nextLight ? 'light' : 'dark';
    const meta = document.querySelector('meta[name="color-scheme"]');

    try {
      localStorage.setItem('color-scheme', targetScheme);
    } catch (_) {}
    if (meta) meta.content = targetScheme;

    this.applyThemeFromScheme(true);
  }

  applyThemeFromScheme(rerenderCanvases = true) {
    const isLight = this.resolveIsLightScheme();
    this.state.lightMode = isLight;
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('light-mode', isLight);
    }
    if (this.dom.themeToggleBtn) {
      const nextModeLabel = isLight ? 'Switch to Dark Mode' : 'Switch to Lite Mode';
      const iconName = isLight ? 'moon' : 'sun';
      this.dom.themeToggleBtn.innerHTML = iconSvg(iconName, 'ui-icon');
      this.dom.themeToggleBtn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
      this.dom.themeToggleBtn.setAttribute('aria-label', nextModeLabel);
      this.dom.themeToggleBtn.title = nextModeLabel;
    }
    if (this.map3d) {
      this.map3d.setTheme(isLight);
    }
    if (rerenderCanvases && this.lastHeroMetrics) {
      const powerProfile = computePowerProfile(this.state.ecoMode, this.state.ecoMode ? 1 : 60);
      this.chronometer.renderWayfinderWatch(
        this.lastHeroMetrics,
        this.localTelemetryScratch,
        powerProfile,
        this.state,
        this.evaElapsedSec
      );
      if (this.lastSkylineResult) {
        this.chronometer.renderSkylinePlot(this.lastSkylineResult, this.state);
      }
      this.chronometer.renderVitalsAndSparkline(this.localTelemetryScratch, this.lastHeroMetrics, this.state);
    }
  }

  scheduleSolve({ forcePass1 = false, refreshAttribution = false, skipSkyline = false } = {}) {
    if (forcePass1) this._pendingSolveFlags.forcePass1 = true;
    if (refreshAttribution) this._pendingSolveFlags.refreshAttribution = true;
    if (!skipSkyline) this._pendingSolveFlags.skipSkyline = false;

    if (this._rafSolvePending) return;
    this._rafSolvePending = true;
    requestAnimationFrame(() => {
      this._rafSolvePending = false;
      const flags = { ...this._pendingSolveFlags };
      this._pendingSolveFlags = { forcePass1: false, refreshAttribution: false, skipSkyline: true };
      this.executeSolveNow(flags);
    });
  }

  scheduleDebouncedAttribution() {
    if (this._attributionTimer) clearTimeout(this._attributionTimer);
    this._attributionTimer = setTimeout(() => {
      this._attributionTimer = null;
      this.updateLayerAttributions();
    }, 180);
  }

  executeSolveNow({ forcePass1 = false, refreshAttribution = false, skipSkyline = false } = {}) {
    const dem = this.activeDem;
    this.solver.solve(dem, this.state, true, forcePass1);
    const heroMetrics = this.solver.computeHeroMetrics(this.state);
    this.lastHeroMetrics = heroMetrics;

    const astroIdx = this.state.astroGy * GRID_N + this.state.astroGx;
    const nextIdx =
      this.solver.returnPathLength > 1 ? this.solver.returnPathIndices[1] : dem.baseIdx;
    const localTel = evaluateLocalBioTelemetry(
      astroIdx,
      nextIdx,
      dem,
      this.state,
      this.localTelemetryScratch
    );

    this.map3d.updateNavigationState(dem, this.state, this.solver, heroMetrics);

    // Floating Viewport HUD telemetry
    const distKm =
      (Math.hypot(this.state.astroGx - BASE_GX, this.state.astroGy - BASE_GY) * CELL_M) / 1000.0;
    if (this.dom.hudPinCoords) {
      this.dom.hudPinCoords.textContent = `GX ${this.state.astroGx}, GY ${this.state.astroGy} • ${distKm.toFixed(2)} km`;
    }
    if (this.dom.hudElevRad) {
      const elev = dem.elevations[astroIdx];
      const rad = dem.radDoseRate[astroIdx];
      this.dom.hudElevRad.textContent = `${Math.round(elev)} m • ${rad.toFixed(1)} µSv/hr`;
    }
    if (this.dom.hudSolverMs) {
      this.dom.hudSolverMs.textContent = `${this.solver.lastSolveMs.toFixed(1)} ms`;
    }

    // Push sparkline ring sample & render UI cards
    this.chronometer.pushSparklineSample(
      localTel.hr_effective,
      this.state.calorieReserveKcal,
      heroMetrics.turnaroundDistKm
    );
    this.chronometer.renderHeroStatusCard(heroMetrics, localTel, this.state);

    const powerProfile = computePowerProfile(this.state.ecoMode, this.state.ecoMode ? 1 : 60);
    this.chronometer.renderWayfinderWatch(
      heroMetrics,
      localTel,
      powerProfile,
      this.state,
      this.evaElapsedSec
    );
    this.chronometer.renderVitalsAndSparkline(localTel, heroMetrics, this.state);

    // Skyline 360° DEM Horizon TRN lock (re-runs on coordinate, IMU yaw, or site change)
    const imuYawTag = this._imuHeadingDeg !== null ? Math.round(this._imuHeadingDeg / 10) : 'auto';
    const skyKey = `${dem.id}:${this.state.astroGx},${this.state.astroGy}:${imuYawTag}`;
    if (!skipSkyline && skyKey !== this.lastSkylineKey) {
      this.lastSkylineKey = skyKey;
      const yawShiftBins =
        this._imuHeadingDeg !== null
          ? Math.round((((this._imuHeadingDeg % 360) + 360) % 360) / 10) % 36
          : (this.state.astroGx * 3 + this.state.astroGy) % 9;
      const query = this.matcher.extractVisorProfile(
        dem,
        this.state.astroGx,
        this.state.astroGy,
        yawShiftBins,
        0.0012
      );
      this.lastSkylineResult = this.matcher.matchSkyline(
        dem,
        query,
        this.state.astroGx,
        this.state.astroGy
      );
      this.chronometer.renderSkylinePlot(this.lastSkylineResult, this.state);
    }

    if (this.dom.hudTrnLock && this.lastSkylineResult) {
      const nccPct = (this.lastSkylineResult.ncc * 100).toFixed(1);
      const yawSign = this.lastSkylineResult.yawOffsetDeg >= 0 ? '+' : '';
      this.dom.hudTrnLock.textContent = `${nccPct}% • Yaw ${yawSign}${this.lastSkylineResult.yawOffsetDeg.toFixed(0)}°`;
    }

    if (refreshAttribution) {
      this.updateLayerAttributions();
    }
  }

  updateLayerAttributions() {
    const badges = this.solver.computeLayerAttributions(this.activeDem, this.state);
    if (this.dom.impactBadges.topo) this.dom.impactBadges.topo.textContent = badges.topo;
    if (this.dom.impactBadges.themis) this.dom.impactBadges.themis.textContent = badges.themis;
    if (this.dom.impactBadges.crism) this.dom.impactBadges.crism.textContent = badges.crism;
    if (this.dom.impactBadges.meda) this.dom.impactBadges.meda.textContent = badges.meda;
    if (this.dom.impactBadges.rad) this.dom.impactBadges.rad.textContent = badges.rad;
  }

  renderAuditUi() {
    const rep = this.auditReport;
    if (this.dom.auditPill) {
      const iconName = rep.allPassed ? 'check-circle' : 'alert-triangle';
      const label = rep.allPassed
        ? 'System Check'
        : `System Check (${rep.passedCount}/${rep.totalCount})`;
      this.dom.auditPill.innerHTML = `${iconSvg(iconName, 'ui-icon ui-icon-sm')} ${escapeHtml(label)}`;
      this.dom.auditPill.classList.toggle('is-fail', !rep.allPassed);
    }

    if (this.dom.auditDialogBody) {
      const rows = rep.gates
        .map(
          (g) => `
          <tr>
            <td class="mono-num">G${g.id}</td>
            <td><strong>${escapeHtml(g.name)}</strong></td>
            <td class="${g.passed ? 'tag-live' : 'tag-surrogate'}">${g.passed ? 'PASS' : 'FAIL'}</td>
            <td class="mono-num">${escapeHtml(g.detail)}</td>
          </tr>`
        )
        .join('');

      this.dom.auditDialogBody.innerHTML = `
        <p class="dialog-lead">
          Executed live on <strong>${escapeHtml(this.activeDem.name)}</strong> at startup (${rep.passedCount}/${rep.totalCount} gates passed).
        </p>
        <table class="spec-table">
          <thead>
            <tr>
              <th>Gate</th>
              <th>Mathematical Invariant</th>
              <th>Status</th>
              <th>Observed Runtime Evidence</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }
  }

  renderProvenanceDialog() {
    if (!this.dom.provenanceDialogBody) return;
    const snap = this.liveClient.getProvenanceSnapshot();
    const friendlyModeNote = snap.customDemActive
      ? 'Using your uploaded terrain map with BioRadius physics'
      : snap.trekLive && snap.donkiLive
        ? 'Connected to live NASA orbital map + live solar-storm feed, paired with built-in Mars terrain layers'
        : snap.donkiLive
          ? 'Connected to live NASA solar-storm feed, paired with built-in Mars terrain layers'
          : snap.trekLive
            ? 'Connected to live NASA orbital map, paired with built-in Mars terrain layers'
            : 'Running 100% offline with built-in NASA-calibrated Mars terrain models';

    const rows = snap.surrogateDatasets
      .map((ds) => {
        const isHybrid = ds.mode === 'HYBRID';
        const tagClass = isHybrid ? (snap.donkiLive ? 'tag-live' : 'tag-hybrid') : 'tag-surrogate';
        const friendlyType = isHybrid ? 'Live + Sim' : 'Built-In Sim';
        return `
          <tr>
            <td><strong>${escapeHtml(ds.pill)}</strong></td>
            <td>${escapeHtml(ds.pdsFamily)}</td>
            <td class="${tagClass}">${friendlyType}</td>
            <td>${escapeHtml(ds.role)}</td>
          </tr>`;
      })
      .join('');

    this.dom.provenanceDialogBody.innerHTML = `
      <p class="dialog-lead">
        <strong>Active Mode:</strong> ${escapeHtml(friendlyModeNote)}
      </p>
      ${
        snap.customDemActive && snap.customDemMeta
          ? `<p class="ops-status mono-num">
              Custom Map: <strong>${escapeHtml(snap.customDemMeta.fileName)}</strong> (${escapeHtml(
                snap.customDemMeta.format
              )}, ${escapeHtml(snap.customDemMeta.dimensions)} fit to 150×150 in ${snap.customDemMeta.ingestElapsedMs} ms)
            </p>`
          : ''
      }
      <table class="spec-table">
        <thead>
          <tr>
            <th>NASA Live Feed</th>
            <th>
              Connection
              <span class="layer-info" tabindex="0" role="button" aria-label="Explain Live Connected vs Offline Backup">
                i
                <span class="layer-tooltip" role="tooltip">
                  <strong>Live Internet Connection:</strong><br>
                  • <strong>Live Connected:</strong> Your browser just downloaded fresh orbital imagery or solar-storm telemetry directly from NASA/JPL servers (browser image/data access permitted).<br>
                  • <strong>Offline Backup:</strong> NASA servers were unreachable or offline, so BioRadius switched smoothly to its built-in fallback.
                </span>
              </span>
            </th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>JPL Mars Trek Orbital Map</td>
            <td class="${snap.trekLive ? 'tag-live' : 'tag-surrogate'}">${snap.trekLive ? 'Live Connected' : 'Offline Backup'}</td>
            <td class="mono-num">${escapeHtml(snap.trekLive ? snap.trekEndpoint : snap.trekError || 'Using built-in orbital surface texture')}</td>
          </tr>
          <tr>
            <td>NASA DONKI Solar Storm Alert</td>
            <td class="${snap.donkiLive ? 'tag-live' : 'tag-surrogate'}">${snap.donkiLive ? 'Live Connected' : 'Offline Backup'}</td>
            <td class="mono-num">${escapeHtml(snap.sepEventMeta.statusNote)}</td>
          </tr>
        </tbody>
      </table>
      <table class="spec-table">
        <thead>
          <tr>
            <th>Map Layer</th>
            <th>NASA Instrument Source</th>
            <th>
              Data Type
              <span class="layer-info" tabindex="0" role="button" aria-label="Explain Built-In Sim vs Live + Sim">
                i
                <span class="layer-tooltip" role="tooltip">
                  <strong>Plain-Language Guide:</strong><br>
                  • <strong>Built-In Sim:</strong> Pre-packaged Mars terrain/weather model calibrated to real NASA mission data (<code>HiRISE/MOLA</code>, <code>THEMIS</code>, <code>CRISM</code>, <code>MEDA</code>) so everything runs instantly without huge file downloads.<br>
                  • <strong>Live + Sim:</strong> Combines live NASA solar-storm alerts from the internet with local canyon shielding computed from the terrain map.
                </span>
              </span>
            </th>
            <th>What It Models</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="ops-status">
        <strong>Quick Guide:</strong>
        <span class="tag-live">Live Connected</span> = real NASA/JPL data fetched live over internet •
        <span class="tag-hybrid">Live + Sim</span> = live NASA storm alert + local terrain shielding •
        <span class="tag-surrogate">Built-In Sim</span> = instant pre-built Mars model (no large downloads needed).
      </div>`;
  }

  updateStoryBanner({ actNum, kicker, title, body, liveText, tone = 'safe', progressPct = 25 }) {
    if (!this.dom.storyBanner) return;
    this.dom.storyBanner.hidden = false;
    this.dom.storyBanner.dataset.storyTone = tone;
    if (this.dom.storyKicker) this.dom.storyKicker.textContent = kicker;
    if (this.dom.storyTitle) this.dom.storyTitle.textContent = title;
    if (this.dom.storyBody) this.dom.storyBody.textContent = body;
    if (this.dom.storyLive) this.dom.storyLive.textContent = liveText;
    if (this.dom.storyProgress) {
      const clamped = Math.max(0, Math.min(100, progressPct));
      this.dom.storyProgress.style.width = `${clamped}%`;
    }
    this.dom.storyActPills.forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.storyAct) === actNum);
    });
  }

  hideStoryBanner() {
    if (this.dom.storyBanner) {
      this.dom.storyBanner.hidden = true;
    }
  }

  interruptStory() {
    this._storyTimers.forEach((id) => clearTimeout(id));
    this._storyTimers = [];
    if (this._storyRampInterval) {
      clearInterval(this._storyRampInterval);
      this._storyRampInterval = null;
    }
    if (this._storyRunning) {
      this._storyRunning = false;
      if (this.dom.playStoryBtn) {
        this.dom.playStoryBtn.innerHTML = `${iconSvg('play', 'ui-icon ui-icon-sm')} Play 30s Story`;
      }
      if (this.dom.actIndicator) {
        this.dom.actIndicator.textContent = 'EVA & ROUTE TELEMETRY';
      }
    }
    this.hideStoryBanner();
  }

  play30sStory() {
    this.interruptStory();
    this._storyRunning = true;
    if (this.dom.playStoryBtn) {
      this.dom.playStoryBtn.innerHTML = `${iconSvg('stop', 'ui-icon ui-icon-sm')} Stop Story`;
    }

    this.runStoryAct(1, { animateRamp: true });
    this._storyTimers.push(setTimeout(() => this.runStoryAct(2, { animateRamp: true }), 7000));
    this._storyTimers.push(setTimeout(() => this.runStoryAct(3, { animateRamp: true }), 16000));
    this._storyTimers.push(setTimeout(() => this.runStoryAct(4, { animateRamp: true }), 23000));
    this._storyTimers.push(
      setTimeout(() => {
        this._storyRunning = false;
        if (this.dom.playStoryBtn) this.dom.playStoryBtn.innerHTML = `${iconSvg('play', 'ui-icon ui-icon-sm')} Play 30s Story`;
        if (this.dom.actIndicator) this.dom.actIndicator.textContent = 'STORY COMPLETE • LIVE';
        this.updateStoryBanner({
          actNum: 0,
          kicker: '30S MISSION STORY COMPLETE',
          title: 'All 4 Acts Demonstrated — Interactive Mars Sandbox Ready',
          body: 'You can replay any story chapter above, toggle NASA layers at the bottom, switch between Mount Sharp and Jezero, or drag the astronaut pin on the 3D terrain.',
          liveText: 'Click Act 1–4 above to inspect a chapter, drag the astronaut pin, or click × to dismiss.',
          tone: 'jezero',
          progressPct: 100
        });
      }, 30000)
    );
  }

  runStoryAct(actNum, { animateRamp = false } = {}) {
    if (this._storyRampInterval) {
      clearInterval(this._storyRampInterval);
      this._storyRampInterval = null;
    }
    const shouldAnimateRamp = Boolean(animateRamp && this._storyRunning);

    if (actNum === 1) {
      // Act 1 (0:00–0:07): Mount Sharp Layered NASA Mars Map + Safe Return Envelope (WP-1..3)
      if (this.activeSiteId !== 'MOUNT_SHARP_BOXWORK') {
        this.switchSite('MOUNT_SHARP_BOXWORK', { skipSolve: true });
      }
      this.state.sepStormActive = false;
      updateRadDoseRate(this.activeDem, false);
      this.state.layers = { topo: true, themis: true, crism: true, meda: true, rad: true };
      this.state.activeLayer = 'topo';
      this.state.astroGx = 85;
      this.state.astroGy = 65;
      this.state.hrBpm = 88;
      this.state.sampleMassKg = 15.0;
      this.state.suitAndSampleMassKg = 65.0;
      this.state.calorieReserveKcal = 1150;
      this.state.o2ReserveKg = 0.52;
      this.state.batteryWh = 780;
      this.state.spo2Pct = 98.0;
      this.state.coreTempC = 37.1;
      this.state.ppCo2MmHg = 1.8;
      this.setEcoMode(false);
      this.syncLayerUi();
      this.syncControlsFromState();

      if (this.dom.drawerSkyline) this.dom.drawerSkyline.open = true;
      if (this.dom.drawerVitals) this.dom.drawerVitals.open = true;
      this.setActiveDockTab('controls');
      if (this.dom.actIndicator) this.dom.actIndicator.textContent = 'ACT 1/4 • LAYERED MARS MAP & SAFE RETURN';

      this.lastSkylineKey = '';
      this.executeSolveNow({ forcePass1: true, refreshAttribution: true, skipSkyline: false });
      this.updateStoryBanner({
        actNum: 1,
        kicker: '30S MISSION STORY • ACT 1 OF 4 (0:00–0:07)',
        title: 'Act 1 · 5 Layered NASA Mars Maps & Live Safe Return Zone',
        body: 'BioRadius fuses 5 NASA datasets on Mount Sharp to draw the green Safe Zone (<75% reserve), amber Caution zone, and blue energy-optimal Return Route back to Base.',
        liveText: STORY_ACT1_LAYER_NOTES.topo,
        tone: 'safe',
        progressPct: 12
      });

      if (shouldAnimateRamp) {
        const storyLayers = ['topo', 'themis', 'crism', 'meda', 'rad'];
        let layerIdx = 0;
        this._storyRampInterval = setInterval(() => {
          layerIdx++;
          if (layerIdx >= storyLayers.length || !this._storyRunning) {
            clearInterval(this._storyRampInterval);
            this._storyRampInterval = null;
            return;
          }
          const layerKey = storyLayers[layerIdx];
          this.setActiveLayer(layerKey);
          if (this.dom.storyLive) {
            this.dom.storyLive.textContent = STORY_ACT1_LAYER_NOTES[layerKey] || '';
          }
          if (this.dom.storyProgress) {
            this.dom.storyProgress.style.width = `${5 + layerIdx * 5}%`;
          }
        }, 1300);
      }
    } else if (actNum === 2) {
      // Act 2 (0:07–0:16): WP-3 Core Sampling & Beyond-Turnaround Crisis (~545 kcal/hr)
      if (this.activeSiteId !== 'MOUNT_SHARP_BOXWORK') {
        this.switchSite('MOUNT_SHARP_BOXWORK', { skipSolve: true });
      }
      this.state.sepStormActive = false;
      updateRadDoseRate(this.activeDem, false);
      this.state.layers = { topo: true, themis: true, crism: true, meda: true, rad: true };
      this.state.activeLayer = 'themis';
      this.state.astroGx = 109;
      this.state.astroGy = 51; // WP-3 Upper Gediz Vallis Scarp (2.80 km)
      this.state.hrBpm = 168;
      this.state.sampleMassKg = 40.0;
      this.state.suitAndSampleMassKg = 90.0; // +25 kg core sample load over 65 kg baseline
      this.state.calorieReserveKcal = 670;
      this.state.o2ReserveKg = 0.325;
      this.state.batteryWh = 530;
      this.state.spo2Pct = 84.8;
      this.state.coreTempC = 38.85;
      this.state.ppCo2MmHg = 4.65;
      this.setEcoMode(false);
      this.syncLayerUi();
      this.syncControlsFromState();

      if (this.dom.drawerVitals) this.dom.drawerVitals.open = true;
      this.setActiveDockTab('controls');
      if (this.dom.actIndicator) this.dom.actIndicator.textContent = 'ACT 2/4 • WP-3 EXCEEDED';

      this.lastSkylineKey = '';
      this.executeSolveNow({ forcePass1: true, refreshAttribution: true, skipSkyline: false });
      this.updateStoryBanner({
        actNum: 2,
        kicker: '30S MISSION STORY • ACT 2 OF 4 (0:07–0:16)',
        title: 'Act 2 · Beyond Safe Turnaround (Heavy Sample Overload)',
        body: 'At WP-3 Upper Gediz Vallis Scarp (2.8 km out), collecting +25 kg of rock samples pushes suit mass to 90 kg and heart rate to 168 BPM across loose drift sand.',
        liveText: 'TURN BACK Alert: Return energy now exceeds remaining calories & O₂ (>100% red zone) — drop core weight or abort immediately.',
        tone: 'exceeded',
        progressPct: 50
      });
    } else if (actNum === 3) {
      // Act 3 (0:16–0:23): DONKI SEP Radiation Storm + CR2032 1Hz Eco Survival
      if (this.activeSiteId !== 'MOUNT_SHARP_BOXWORK') {
        this.switchSite('MOUNT_SHARP_BOXWORK', { skipSolve: true });
      }
      this.state.layers = { topo: true, themis: true, crism: true, meda: true, rad: true };
      this.state.sepStormActive = true;
      updateRadDoseRate(this.activeDem, true);
      this.state.activeLayer = 'rad';
      this.state.astroGx = 98;
      this.state.astroGy = 60; // WP-2 pulling back under shelter
      this.state.hrBpm = 134;
      this.state.sampleMassKg = 25.0;
      this.state.suitAndSampleMassKg = 75.0;
      this.state.calorieReserveKcal = 680;
      this.state.o2ReserveKg = 0.34;
      this.state.batteryWh = 510;
      this.state.spo2Pct = 96.5;
      this.state.coreTempC = 37.5;
      this.state.ppCo2MmHg = 2.3;
      this.syncLayerUi();
      this.syncControlsFromState();

      if (this.dom.drawerVitals) this.dom.drawerVitals.open = true;
      this.setActiveDockTab('controls');
      if (this.dom.actIndicator) this.dom.actIndicator.textContent = 'ACT 3/4 • SEP + 1Hz ECO';

      this.lastSkylineKey = '';
      this.executeSolveNow({ forcePass1: true, refreshAttribution: true, skipSkyline: false });
      this.setEcoMode(true);
      this.updateStoryBanner({
        actNum: 3,
        kicker: '30S MISSION STORY • ACT 3 OF 4 (0:16–0:23)',
        title: 'Act 3 · Solar Radiation Storm Shelter & 1 Hz Watch Battery Saver',
        body: 'NASA DONKI SEP storm alert triggers a pullback toward WP-2 canyon shelter while BioRadius pauses the 60 Hz 3D GPU to run the wrist Watchfinder at 1 Hz.',
        liveText: 'Power Gated: 0.0 mW 3D GPU • 42.3 mW total draw extends emergency navigation to 15.6 hrs on one CR2032 coin cell.',
        tone: 'caution',
        progressPct: 75
      });
    } else if (actNum === 4) {
      // Act 4 (0:23–0:30): Exit Eco Mode -> Jezero Delta Multi-Layer Counterfactuals & Exertion Ramp
      this.setEcoMode(false);
      this.state.sepStormActive = false;
      if (this.activeSiteId !== 'JEZERO_DELTA') {
        this.switchSite('JEZERO_DELTA', { skipSolve: true });
      }
      updateRadDoseRate(this.activeDem, false);
      this.state.layers = { topo: true, themis: true, crism: true, meda: true, rad: true };
      this.state.activeLayer = 'crism';
      this.state.astroGx = 91;
      this.state.astroGy = 62;
      this.state.sampleMassKg = 25.0;
      this.state.suitAndSampleMassKg = 75.0;
      this.state.calorieReserveKcal = 1050;
      this.state.o2ReserveKg = 0.48;
      this.state.batteryWh = 720;
      this.state.spo2Pct = 97.5;
      this.state.coreTempC = 37.2;
      this.state.ppCo2MmHg = 2.0;
      this.state.hrBpm = shouldAnimateRamp ? 80 : 158;
      this.syncLayerUi();
      this.syncControlsFromState();

      if (this.dom.drawerVitals) this.dom.drawerVitals.open = true;
      this.setActiveDockTab('controls');
      if (this.dom.actIndicator) this.dom.actIndicator.textContent = 'ACT 4/4 • JEZERO DELTA';

      this.lastSkylineKey = '';
      this.executeSolveNow({ forcePass1: true, refreshAttribution: true, skipSkyline: false });
      const initialKmLeft = this.lastHeroMetrics
        ? `${this.lastHeroMetrics.turnaroundDistKm.toFixed(2)} km to turnaround`
        : 'live contour updating';
      this.updateStoryBanner({
        actNum: 4,
        kicker: '30S MISSION STORY • ACT 4 OF 4 (0:23–0:30)',
        title: "Act 4 · Jezero Crater Delta: Live Heart-Rate vs. Safe Return Shrinkage",
        body: "Switching to Perseverance's Jezero River Delta shows how spiking astronaut heart rate immediately contracts the green Safe Return envelope across clay and sand layers.",
        liveText: `Live Stress Sweep: Heart Rate ${this.state.hrBpm} BPM • Layer: ${STORY_LAYER_SHORT_LABELS[this.state.activeLayer]} • ${initialKmLeft}`,
        tone: 'jezero',
        progressPct: 90
      });

      if (shouldAnimateRamp) {
        let step = 0;
        const rampLayers = ['crism', 'themis', 'meda', 'topo'];
        this._storyRampInterval = setInterval(() => {
          step++;
          if (step > 10 || !this._storyRunning) {
            clearInterval(this._storyRampInterval);
            this._storyRampInterval = null;
            return;
          }
          this.state.hrBpm = Math.round(80 + (92 * step) / 10); // 80 -> 172 BPM
          this.state.activeLayer = rampLayers[step % rampLayers.length];
          this.syncLayerUi();
          this.syncControlsFromState();
          this.executeSolveNow({
            forcePass1: true,
            refreshAttribution: step === 10,
            skipSkyline: true
          });
          if (this.dom.storyLive) {
            const kmLeft = this.lastHeroMetrics
              ? `${this.lastHeroMetrics.turnaroundDistKm.toFixed(2)} km to turnaround`
              : 're-solving';
            this.dom.storyLive.textContent = `Live Stress Sweep: Heart Rate ${this.state.hrBpm} BPM • Layer: ${STORY_LAYER_SHORT_LABELS[this.state.activeLayer] || this.state.activeLayer} • ${kmLeft}`;
          }
          if (this.dom.storyProgress) {
            this.dom.storyProgress.style.width = `${Math.round(78 + step * 2.2)}%`;
          }
        }, 550);
      }
    }
  }

  /**
   * Reads a user-dropped or file-selected DEM (.asc/.csv/.raw) and ingests it into the 150x150 solver.
   * @param {File} file
   */
  async handleCustomDemFile(file) {
    try {
      const lower = String(file.name || '').toLowerCase();
      const isBinary =
        lower.endsWith('.raw') || lower.endsWith('.bin') || lower.endsWith('.img');
      const payload = isBinary ? await file.arrayBuffer() : await file.text();
      this.ingestAndSwitchCustomDem(file.name, payload);
    } catch (err) {
      if (this.dom.demIngestStatus) {
        this.dom.demIngestStatus.innerHTML = `${iconSvg('x', 'ui-icon ui-icon-sm')} DEM ingest failed: ${escapeHtml(err?.message || err)}`;
      }
    }
  }

  /**
   * Synchronously parses/resamples custom DEM bytes/text, switches active site, and updates UI.
   * @param {string} fileName
   * @param {string | ArrayBuffer | ArrayBufferView} payload
   * @param {object} [options]
   */
  ingestAndSwitchCustomDem(fileName, payload, options = {}) {
    const dem = ingestCustomDemData(fileName, payload, this.state.sepStormActive, options);
    this.datasetCache.set('CUSTOM_MISSION_DEM', dem);
    if (this.dom.siteCustomBtn) {
      this.dom.siteCustomBtn.hidden = false;
    }
    this.switchSite('CUSTOM_MISSION_DEM', { skipSolve: false });
    if (this.dom.demIngestStatus) {
      this.dom.demIngestStatus.innerHTML = `${iconSvg('check', 'ui-icon ui-icon-sm')} Loaded ${escapeHtml(dem.sourceFileName)} (${escapeHtml(dem.sourceFormat)}, ${escapeHtml(dem.sourceDimensions)} fit to 150×150) in ${dem.ingestElapsedMs} ms | Elev ${escapeHtml(dem.elevRangeLabel)}`;
    }
    return dem;
  }

  /**
   * Connects or disconnects a Web Bluetooth GATT 0x180D Heart Rate Monitor (0x2A37).
   */
  async pairBleHeartRate() {
    if (this._bleStreaming) {
      this.disconnectBle();
      return;
    }
    if (
      typeof navigator === 'undefined' ||
      !navigator.bluetooth ||
      typeof navigator.bluetooth.requestDevice !== 'function'
    ) {
      this.updateHwStatusUi(
        'Bluetooth heart-rate access is unavailable in this browser — staying in Simulation Mode.'
      );
      return;
    }

    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }]
      });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService('heart_rate');
      const char = await service.getCharacteristic('heart_rate_measurement');

      this._onBleValueChanged = (ev) => {
        const bpm = parseBleHeartRateMeasurement(ev.target.value);
        if (bpm !== null && bpm >= 30 && bpm <= 230) {
          this.state.hrBpm = bpm;
          this.syncControlsFromState();
          this.scheduleSolve({ forcePass1: true, refreshAttribution: false, skipSkyline: true });
        }
      };
      this._onBleDisconnected = () => {
        this.disconnectBle();
      };

      char.addEventListener('characteristicvaluechanged', this._onBleValueChanged);
      device.addEventListener('gattserverdisconnected', this._onBleDisconnected);
      await char.startNotifications();

      this._bleDevice = device;
      this._bleChar = char;
      this._bleStreaming = true;
      if (this.dom.sliderHr) this.dom.sliderHr.disabled = true;
      this.updateHwStatusUi();
    } catch (err) {
      this.disconnectBle();
      this.updateHwStatusUi(`BLE pairing cancelled or failed (${err?.message || 'unsupported'}).`);
    }
  }

  disconnectBle() {
    try {
      if (this._bleChar && this._onBleValueChanged) {
        this._bleChar.removeEventListener('characteristicvaluechanged', this._onBleValueChanged);
      }
      if (this._bleDevice && this._onBleDisconnected) {
        this._bleDevice.removeEventListener('gattserverdisconnected', this._onBleDisconnected);
      }
      if (this._bleDevice?.gatt?.connected) {
        this._bleDevice.gatt.disconnect();
      }
    } catch {
      // Ignore GATT teardown errors
    }
    this._bleDevice = null;
    this._bleChar = null;
    this._onBleValueChanged = null;
    this._onBleDisconnected = null;
    this._bleStreaming = false;
    if (this.dom.sliderHr) this.dom.sliderHr.disabled = false;
    this.updateHwStatusUi();
  }

  /**
   * Toggles live DeviceOrientation IMU heading + Geolocation field displacement tracking.
   */
  async toggleImuGpsLink() {
    if (this._imuActive) {
      this.disconnectImuGps();
      return;
    }

    const hasOrientation = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
    const hasGeo = typeof navigator !== 'undefined' && 'geolocation' in navigator;
    if (!hasOrientation && !hasGeo) {
      this.updateHwStatusUi('Device IMU & Geolocation APIs unavailable in this browser.');
      return;
    }

    if (
      hasOrientation &&
      typeof window.DeviceOrientationEvent.requestPermission === 'function'
    ) {
      try {
        const perm = await window.DeviceOrientationEvent.requestPermission();
        if (perm !== 'granted') {
          this.updateHwStatusUi('IMU orientation permission declined by operator.');
          return;
        }
      } catch (err) {
        this.updateHwStatusUi(`IMU permission error: ${err?.message || err}`);
        return;
      }
    }

    this._imuActive = true;
    this._geoOrigin = null;

    if (hasOrientation) {
      this._onDeviceOrientation = (ev) => {
        const heading = Number.isFinite(ev.webkitCompassHeading)
          ? ev.webkitCompassHeading
          : Number.isFinite(ev.alpha)
            ? (360 - ev.alpha) % 360
            : null;
        if (heading === null) return;
        this._imuHeadingDeg = heading;
        const now = performance.now();
        if (now - this._lastImuSolveMs >= 160) {
          this._lastImuSolveMs = now;
          this.scheduleSolve({ forcePass1: false, refreshAttribution: false, skipSkyline: false });
          this.updateHwStatusUi();
        }
      };
      window.addEventListener('deviceorientation', this._onDeviceOrientation);
    }

    if (hasGeo) {
      const anchorGx = this.state.astroGx;
      const anchorGy = this.state.astroGy;
      this._geoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          if (!this._geoOrigin) {
            this._geoOrigin = { lat: latitude, lon: longitude, anchorGx, anchorGy };
            return;
          }
          const dNorthM = (latitude - this._geoOrigin.lat) * 111132.0;
          const dEastM =
            (longitude - this._geoOrigin.lon) *
            111320.0 *
            Math.max(0.1, Math.cos((this._geoOrigin.lat * Math.PI) / 180));
          const nextGx = Math.max(
            1,
            Math.min(GRID_N - 2, Math.round(this._geoOrigin.anchorGx + dEastM / CELL_M))
          );
          const nextGy = Math.max(
            1,
            Math.min(GRID_N - 2, Math.round(this._geoOrigin.anchorGy - dNorthM / CELL_M))
          );
          if (nextGx !== this.state.astroGx || nextGy !== this.state.astroGy) {
            this.state.astroGx = nextGx;
            this.state.astroGy = nextGy;
            this.scheduleSolve({ forcePass1: false, refreshAttribution: false, skipSkyline: false });
          }
        },
        () => {
          // Non-fatal: keep IMU heading active even if GPS fix is denied/unavailable
        },
        { enableHighAccuracy: true, maximumAge: 2000 }
      );
    }

    this.updateHwStatusUi();
  }

  disconnectImuGps() {
    if (typeof window !== 'undefined' && this._onDeviceOrientation) {
      window.removeEventListener('deviceorientation', this._onDeviceOrientation);
    }
    if (
      typeof navigator !== 'undefined' &&
      navigator.geolocation &&
      this._geoWatchId !== null
    ) {
      navigator.geolocation.clearWatch(this._geoWatchId);
    }
    this._onDeviceOrientation = null;
    this._geoWatchId = null;
    this._geoOrigin = null;
    this._imuActive = false;
    this._imuHeadingDeg = null;
    this.updateHwStatusUi();
  }

  updateHwStatusUi(overrideMsg = null) {
    if (this.dom.btnPairBle) {
      this.dom.btnPairBle.innerHTML = this._bleStreaming
        ? `${iconSvg('x', 'ui-icon ui-icon-sm')} Disconnect Heart Rate`
        : `${iconSvg('heart', 'ui-icon ui-icon-sm')} Connect Heart Rate (Bluetooth)`;
      this.dom.btnPairBle.classList.toggle('is-live-ops', this._bleStreaming);
    }
    if (this.dom.btnLinkImu) {
      this.dom.btnLinkImu.innerHTML = this._imuActive
        ? `${iconSvg('x', 'ui-icon ui-icon-sm')} Disconnect Compass & GPS`
        : `${iconSvg('compass', 'ui-icon ui-icon-sm')} Connect Compass & GPS`;
      this.dom.btnLinkImu.classList.toggle('is-live-ops', this._imuActive);
    }
    if (!this.dom.hwModeStatus) return;
    if (overrideMsg) {
      this.dom.hwModeStatus.innerHTML = escapeHtml(overrideMsg);
      return;
    }
    const parts = [];
    if (this._bleStreaming) parts.push(`${iconSvg('check-circle', 'ui-icon ui-icon-sm')} Bluetooth Heart Rate Connected (HR slider locked)`);
    if (this._imuActive) {
      const hdg =
        this._imuHeadingDeg !== null ? `${Math.round(this._imuHeadingDeg)}°` : 'waiting orientation';
      parts.push(`${iconSvg('compass', 'ui-icon ui-icon-sm')} Compass & GPS Connected (${hdg})`);
    }
    this.dom.hwModeStatus.innerHTML =
      parts.length > 0
        ? parts.join(' • ')
        : `${iconSvg('sliders', 'ui-icon ui-icon-sm')} Simulation Mode Active (Manual sliders unlocked)`;
  }

  recordBlackBoxFrame() {
    if (!this.lastHeroMetrics) return;
    const bb = this.blackBox;
    const slot = bb.head;
    const limiterIdx = Math.max(0, LIMITER_CODES.indexOf(this.lastHeroMetrics.limitingFactor));
    const siteIdx = Math.max(0, SITE_CODES.indexOf(this.activeSiteId));

    bb.epochSec[slot] = Math.floor(Date.now() / 1000);
    bb.evaSec[slot] = this.evaElapsedSec;
    bb.siteCode[slot] = siteIdx;
    bb.gx[slot] = this.state.astroGx;
    bb.gy[slot] = this.state.astroGy;
    bb.hr[slot] = this.state.hrBpm;
    bb.kcal[slot] = this.lastHeroMetrics.kcalRemaining ?? this.state.calorieReserveKcal;
    bb.o2Kg[slot] = this.lastHeroMetrics.o2RemainingKg ?? this.state.o2ReserveKg;
    bb.battWh[slot] = this.lastHeroMetrics.battRemainingWh ?? this.state.batteryWh;
    bb.marginPct[slot] = this.lastHeroMetrics.marginPct ?? 0;
    bb.limiterCode[slot] = limiterIdx;

    bb.head = (slot + 1) % bb.cap;
    if (bb.count < bb.cap) bb.count++;

    if (bb.count === 1 || bb.count % 5 === 0) {
      this.persistBlackBoxToStorage();
    }
    if (this.dom.opsDialog?.open) {
      this.updateOpsStatusUi();
    }
  }

  persistBlackBoxToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      const snap = {
        savedAtUtc: new Date().toISOString(),
        siteId: this.activeSiteId,
        astroGx: this.state.astroGx,
        astroGy: this.state.astroGy,
        hrBpm: this.state.hrBpm,
        suitAndSampleMassKg: this.state.suitAndSampleMassKg,
        calorieReserveKcal: this.state.calorieReserveKcal,
        evaElapsedSec: this.evaElapsedSec,
        sepStormActive: this.state.sepStormActive,
        frameCount: this.blackBox.count
      };
      localStorage.setItem(BLACKBOX_STORAGE_KEY, JSON.stringify(snap));
    } catch {
      // Ignore storage quota or sandbox restrictions
    }
  }

  restoreLastEvaSession() {
    try {
      if (typeof localStorage === 'undefined') {
        this.updateOpsStatusUi('localStorage unavailable in this runtime.');
        return;
      }
      const raw = localStorage.getItem(BLACKBOX_STORAGE_KEY);
      if (!raw) {
        this.updateOpsStatusUi('No saved EVA snapshot found in localStorage.');
        return;
      }
      const snap = JSON.parse(raw);
      if (
        snap.siteId &&
        (snap.siteId === 'MOUNT_SHARP_BOXWORK' ||
          snap.siteId === 'JEZERO_DELTA' ||
          (snap.siteId === 'CUSTOM_MISSION_DEM' && this.datasetCache.has('CUSTOM_MISSION_DEM')))
      ) {
        if (this.activeSiteId !== snap.siteId) {
          this.switchSite(snap.siteId, { skipSolve: true });
        }
      }
      if (Number.isFinite(snap.astroGx)) this.state.astroGx = snap.astroGx;
      if (Number.isFinite(snap.astroGy)) this.state.astroGy = snap.astroGy;
      if (Number.isFinite(snap.hrBpm)) this.state.hrBpm = snap.hrBpm;
      if (Number.isFinite(snap.suitAndSampleMassKg)) {
        this.state.suitAndSampleMassKg = snap.suitAndSampleMassKg;
        this.state.sampleMassKg = Math.max(0, snap.suitAndSampleMassKg - this.state.suitMassKg);
      }
      if (Number.isFinite(snap.calorieReserveKcal)) {
        this.state.calorieReserveKcal = snap.calorieReserveKcal;
      }
      if (Number.isFinite(snap.evaElapsedSec)) this.evaElapsedSec = snap.evaElapsedSec;

      this.syncControlsFromState();
      this.lastSkylineKey = '';
      this.executeSolveNow({ forcePass1: true, refreshAttribution: true, skipSkyline: false });
      this.updateOpsStatusUi(`${iconSvg('check', 'ui-icon ui-icon-sm')} Restored session from ${escapeHtml(snap.savedAtUtc)}`);
    } catch (err) {
      this.updateOpsStatusUi(`${iconSvg('x', 'ui-icon ui-icon-sm')} Restore failed: ${escapeHtml(err?.message || err)}`);
    }
  }

  clearBlackBoxLog() {
    this.blackBox.head = 0;
    this.blackBox.count = 0;
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(BLACKBOX_STORAGE_KEY);
    } catch {
      // Ignore
    }
    this.updateOpsStatusUi(`${iconSvg('trash', 'ui-icon ui-icon-sm')} Saved mission history cleared.`);
  }

  updateOpsStatusUi(blackBoxOverride = null) {
    if (!this.dom.blackboxStatus) return;
    if (blackBoxOverride) {
      this.dom.blackboxStatus.innerHTML = blackBoxOverride;
      return;
    }
    let savedNote = 'none saved yet';
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(BLACKBOX_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          savedNote = `saved @ ${parsed.savedAtUtc?.slice(11, 19) ?? 'saved'} UTC`;
        }
      }
    } catch {
      // Ignore
    }
    this.dom.blackboxStatus.innerHTML = `${this.blackBox.count}s / ${this.blackBox.cap}s recorded • ${escapeHtml(savedNote)}`;
  }

  /**
   * Serializes the pre-allocated 1 Hz black-box ring buffer into a standard Flight Surgeon CSV log.
   * @returns {string}
   */
  exportBlackBoxCsv() {
    const bb = this.blackBox;
    const header =
      'timestamp_utc,eva_elapsed_s,site_id,gx,gy,hr_bpm,kcal_rem,o2_rem_kg,batt_rem_wh,posr_margin_pct,limiting_factor';
    const rows = [header];
    const startIdx = bb.count === bb.cap ? bb.head : 0;

    for (let i = 0; i < bb.count; i++) {
      const slot = (startIdx + i) % bb.cap;
      const iso = new Date(bb.epochSec[slot] * 1000).toISOString();
      const siteId = SITE_CODES[bb.siteCode[slot]] ?? 'UNKNOWN';
      const limiter = LIMITER_CODES[bb.limiterCode[slot]] ?? 'BIO';
      rows.push(
        [
          iso,
          bb.evaSec[slot],
          siteId,
          bb.gx[slot],
          bb.gy[slot],
          bb.hr[slot].toFixed(1),
          bb.kcal[slot].toFixed(1),
          bb.o2Kg[slot].toFixed(3),
          bb.battWh[slot].toFixed(1),
          bb.marginPct[slot].toFixed(2),
          limiter
        ].join(',')
      );
    }
    return rows.join('\n');
  }

  downloadGeoJsonPerimeter() {
    const json = this.solver.exportSafeReturnGeoJson(
      this.activeDem,
      this.state,
      this.lastHeroMetrics
    );
    const filename = `bioradius_${this.activeSiteId.toLowerCase()}_perimeter.geojson`;
    this.downloadTextFile(filename, json, 'application/geo+json');
    if (this.dom.exportStatus) {
      this.dom.exportStatus.innerHTML = `${iconSvg('download', 'ui-icon ui-icon-sm')} Downloaded ${escapeHtml(filename)} (Safe Zone Map)`;
    }
    return json;
  }

  downloadGpxReturnCorridor() {
    const gpx = this.solver.exportReturnCorridorGpx(this.activeDem, this.state);
    const filename = `bioradius_${this.activeSiteId.toLowerCase()}_return.gpx`;
    this.downloadTextFile(filename, gpx, 'application/gpx+xml');
    if (this.dom.exportStatus) {
      this.dom.exportStatus.innerHTML = `${iconSvg('download', 'ui-icon ui-icon-sm')} Downloaded ${escapeHtml(filename)} (Return Route GPX)`;
    }
    return gpx;
  }

  downloadBlackBoxCsv() {
    const csv = this.exportBlackBoxCsv();
    const filename = `bioradius_${this.activeSiteId.toLowerCase()}_flight_surgeon.csv`;
    this.downloadTextFile(filename, csv, 'text/csv');
    if (this.dom.exportStatus) {
      this.dom.exportStatus.innerHTML = `${iconSvg('download', 'ui-icon ui-icon-sm')} Downloaded ${escapeHtml(filename)} (${this.blackBox.count}s log)`;
    }
    return csv;
  }

  downloadTextFile(filename, content, mimeType) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || !URL?.createObjectURL) {
      return;
    }
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.bioRadiusApp = new BioRadiusApp();
}
