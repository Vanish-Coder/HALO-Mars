/**
 * BioRadius — 3D Martian Terrain & Dynamic Isochrone WebGL2 Stage (Three.js v0.170.0)
 * Renders the 150x150 DEM mesh, 5 interactive NASA layer shaders, translucent isochrone
 * interior fill, Marching Squares contours, #0A84FF optimal return path, O(1) pin drag,
 * and CR2032 GPU power-gating.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  GRID_N,
  TOTAL_CELLS,
  SPAN_M,
  CELL_M,
  BASE_GX,
  BASE_GY,
  BASE_IDX,
  OVERLAY_Y_OFFSET,
  gridToWorld,
  worldToGrid
} from '../data/nasaMarsDatasets.js';
import { applyEcoPowerGating } from '../physics/coinCellPowerProfiler.js';

const MAX_CONTOUR_VERTS = (GRID_N - 1) * (GRID_N - 1) * 4;
const MAX_PATH_VERTS = 501;

// Precomputed RGB semantic colors [0..1]
const COL_SAFE = [0x30 / 255, 0xd1 / 255, 0x58 / 255];
const COL_CAUTION = [0xff / 255, 0x9f / 255, 0x0a / 255];
const COL_CRITICAL = [0xff / 255, 0x45 / 255, 0x3a / 255];

export class ThreeNavigationMap {
  constructor(containerEl, { onAstroDrag, onWaypointClick } = {}) {
    this.container = containerEl;
    this.onAstroDrag = onAstroDrag || null;
    this.onWaypointClick = onWaypointClick || null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07090e);
    this.scene.fog = new THREE.FogExp2(0x07090e, 0.000045);

    const w = Math.max(1, containerEl.clientWidth);
    const h = Math.max(1, containerEl.clientHeight);
    this.camera = new THREE.PerspectiveCamera(46, w / h, 20, 45000);
    this.camera.position.set(1600, 4400, 5600);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    containerEl.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 1200;
    this.controls.maxDistance = 15000;
    this.controls.target.set(0, -2150, 0);
    this.controls.update();

    // Lighting
    const hemi = new THREE.HemisphereLight(0xffeedd, 0x1a1e2e, 0.9);
    this.scene.add(hemi);
    const sunAz = (118.0 * Math.PI) / 180.0;
    const sunEl = (22.5 * Math.PI) / 180.0;
    const sunDir = new THREE.Vector3(
      Math.sin(sunAz) * Math.cos(sunEl),
      Math.sin(sunEl),
      -Math.cos(sunAz) * Math.cos(sunEl)
    );
    const sunLight = new THREE.DirectionalLight(0xfff1dc, 1.45);
    sunLight.position.copy(sunDir.multiplyScalar(12000));
    this.scene.add(sunLight);

    // Preallocate 150x150 Terrain Mesh & Vertex Colors
    this.terrainGeo = new THREE.PlaneGeometry(SPAN_M, SPAN_M, GRID_N - 1, GRID_N - 1);
    this.terrainGeo.rotateX(-Math.PI / 2);
    this.vertexColors = new Float32Array(TOTAL_CELLS * 3);
    this.terrainGeo.setAttribute('color', new THREE.BufferAttribute(this.vertexColors, 3));

    this.albedoRgb = new Float32Array(TOTAL_CELLS * 3);
    this.albedoRgb.fill(1.0);

    this.terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.04,
      flatShading: false
    });
    this.terrainMesh = new THREE.Mesh(this.terrainGeo, this.terrainMat);
    this.scene.add(this.terrainMesh);

    // Preallocate Marching Squares T=0.75 (Amber) & T=1.0 (PSR Safe/Critical) Contours
    this.contour075Buffer = new Float32Array(MAX_CONTOUR_VERTS * 3);
    this.contour075Geo = new THREE.BufferGeometry();
    this.contour075Geo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.contour075Buffer, 3)
    );
    this.contour075Mat = new THREE.LineBasicMaterial({ color: 0xff9f0a, transparent: true, opacity: 0.92 });
    this.contour075Lines = new THREE.LineSegments(this.contour075Geo, this.contour075Mat);
    this.contour075Lines.frustumCulled = false;
    this.scene.add(this.contour075Lines);

    this.contour100Buffer = new Float32Array(MAX_CONTOUR_VERTS * 3);
    this.contour100Geo = new THREE.BufferGeometry();
    this.contour100Geo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.contour100Buffer, 3)
    );
    this.contour100Mat = new THREE.LineBasicMaterial({ color: 0x30d158, transparent: true, opacity: 1.0 });
    this.contour100Lines = new THREE.LineSegments(this.contour100Geo, this.contour100Mat);
    this.contour100Lines.frustumCulled = false;
    this.scene.add(this.contour100Lines);

    // Preallocate Optimal Minimum-Energy Return Path (#0A84FF)
    this.returnPathBuffer = new Float32Array(MAX_PATH_VERTS * 3);
    this.returnPathGeo = new THREE.BufferGeometry();
    this.returnPathGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.returnPathBuffer, 3)
    );
    this.returnPathMat = new THREE.LineBasicMaterial({ color: 0x0a84ff, linewidth: 2 });
    this.returnPathLine = new THREE.Line(this.returnPathGeo, this.returnPathMat);
    this.returnPathLine.frustumCulled = false;
    this.scene.add(this.returnPathLine);

    // Base Habitat Marker
    this.baseGroup = new THREE.Group();
    const baseBody = new THREE.Mesh(
      new THREE.CylinderGeometry(58, 74, 95, 16),
      new THREE.MeshStandardMaterial({ color: 0xe6ecf5, emissive: 0x103558, roughness: 0.35 })
    );
    baseBody.position.y = 48;
    const baseRing = new THREE.Mesh(
      new THREE.RingGeometry(95, 125, 32),
      new THREE.MeshBasicMaterial({ color: 0x64b5ff, side: THREE.DoubleSide })
    );
    baseRing.rotation.x = -Math.PI / 2;
    baseRing.position.y = 4;
    this.baseGroup.add(baseBody, baseRing);
    this.scene.add(this.baseGroup);

    // Astronaut EVA Pin + Invisible Drag Hit Sphere
    this.astroGroup = new THREE.Group();
    this.astroCoreMat = new THREE.MeshStandardMaterial({
      color: 0x30d158,
      emissive: 0x1e8f3c,
      emissiveIntensity: 0.75,
      roughness: 0.25
    });
    const astroOrb = new THREE.Mesh(new THREE.SphereGeometry(68, 20, 20), this.astroCoreMat);
    astroOrb.position.y = 95;
    const astroStem = new THREE.Mesh(
      new THREE.CylinderGeometry(12, 12, 95, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    astroStem.position.y = 47;
    this.astroHaloMat = new THREE.MeshBasicMaterial({
      color: 0x30d158,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.72
    });
    const astroHalo = new THREE.Mesh(new THREE.RingGeometry(90, 132, 32), this.astroHaloMat);
    astroHalo.rotation.x = -Math.PI / 2;
    astroHalo.position.y = 4;
    this.astroHitMesh = new THREE.Mesh(
      new THREE.SphereGeometry(240, 12, 12),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.astroHitMesh.position.y = 70;
    this.astroGroup.add(astroOrb, astroStem, astroHalo, this.astroHitMesh);
    this.scene.add(this.astroGroup);

    // 3 Science Waypoint Beacons
    this.waypointMeshes = [];
    for (let i = 0; i < 3; i++) {
      const wpGroup = new THREE.Group();
      const beacon = new THREE.Mesh(
        new THREE.OctahedronGeometry(52, 0),
        new THREE.MeshStandardMaterial({
          color: 0xffd166,
          emissive: 0x775210,
          roughness: 0.3
        })
      );
      beacon.position.y = 115;
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(6, 6, 110, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.75 })
      );
      stem.position.y = 55;
      wpGroup.add(beacon, stem);
      wpGroup.userData.wpIndex = i;
      this.scene.add(wpGroup);
      this.waypointMeshes.push(wpGroup);
    }

    // O(1) Raycaster Drag State (zero per-frame allocations)
    this.raycaster = new THREE.Raycaster();
    this.pointerNdc = new THREE.Vector2();
    this.groundDragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.dragHitPoint = new THREE.Vector3();
    this.isDraggingAstro = false;
    this.activeDem = null;
    this.ecoMode = false;

    this._bindEvents();
    this._animateBound = this._animate.bind(this);
    this.renderer.setAnimationLoop(this._animateBound);
  }

  _bindEvents() {
    const dom = this.renderer.domElement;

    const updateNdc = (ev) => {
      const rect = dom.getBoundingClientRect();
      this.pointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    };

    dom.addEventListener('pointerdown', (ev) => {
      if (!this.activeDem) return;
      updateNdc(ev);
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);

      const astroHits = this.raycaster.intersectObject(this.astroHitMesh, false);
      if (astroHits.length > 0) {
        this.isDraggingAstro = true;
        this.controls.enabled = false;
        this.groundDragPlane.constant = -this.astroGroup.position.y;
        dom.style.cursor = 'grabbing';
        dom.setPointerCapture(ev.pointerId);
        return;
      }

      const wpHits = this.raycaster.intersectObjects(this.waypointMeshes, true);
      if (wpHits.length > 0 && this.onWaypointClick) {
        let obj = wpHits[0].object;
        while (obj && obj.userData.wpIndex === undefined) {
          obj = obj.parent;
        }
        if (obj && obj.userData.wpIndex !== undefined) {
          this.onWaypointClick(obj.userData.wpIndex);
        }
      }
    });

    dom.addEventListener('pointermove', (ev) => {
      if (!this.activeDem) return;
      updateNdc(ev);
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);

      if (this.isDraggingAstro) {
        if (this.raycaster.ray.intersectPlane(this.groundDragPlane, this.dragHitPoint)) {
          const { gx, gy, idx } = worldToGrid(this.dragHitPoint.x, this.dragHitPoint.z);
          const wx = (gx - BASE_GX) * CELL_M;
          const wz = (gy - BASE_GY) * CELL_M;
          const wy = this.activeDem.elevations[idx] + OVERLAY_Y_OFFSET;
          this.astroGroup.position.set(wx, wy, wz);
          if (this.onAstroDrag) {
            this.onAstroDrag(gx, gy);
          }
        }
        return;
      }

      const hoverHits = this.raycaster.intersectObject(this.astroHitMesh, false);
      dom.style.cursor = hoverHits.length > 0 ? 'grab' : 'default';
    });

    const endDrag = (ev) => {
      if (this.isDraggingAstro) {
        this.isDraggingAstro = false;
        this.controls.enabled = true;
        dom.style.cursor = 'default';
        if (dom.hasPointerCapture(ev.pointerId)) {
          dom.releasePointerCapture(ev.pointerId);
        }
      }
    };

    dom.addEventListener('pointerup', endDrag);
    dom.addEventListener('pointercancel', endDrag);

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(this.container);
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /**
   * Samples Mars Trek WMTS / fallback albedo offscreen canvas into the 150x150 vertex albedo cache.
   */
  syncAlbedoCanvas(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h).data;

    for (let gy = 0; gy < GRID_N; gy++) {
      const py = Math.min(h - 1, Math.floor((gy / (GRID_N - 1)) * (h - 1)));
      for (let gx = 0; gx < GRID_N; gx++) {
        const px = Math.min(w - 1, Math.floor((gx / (GRID_N - 1)) * (w - 1)));
        const pIdx = (py * w + px) * 4;
        const vIdx = (gy * GRID_N + gx) * 3;
        this.albedoRgb[vIdx] = imgData[pIdx] / 255.0;
        this.albedoRgb[vIdx + 1] = imgData[pIdx + 1] / 255.0;
        this.albedoRgb[vIdx + 2] = imgData[pIdx + 2] / 255.0;
      }
    }
  }

  /**
   * Loads a new Martian landing site DEM into the 3D vertex buffers and updates markers.
   */
  setSiteDataset(dem) {
    this.activeDem = dem;
    const posAttr = this.terrainGeo.attributes.position;
    const elevs = dem.elevations;

    let elevSum = 0.0;
    for (let gy = 0; gy < GRID_N; gy++) {
      for (let gx = 0; gx < GRID_N; gx++) {
        const idx = gy * GRID_N + gx;
        const elev = elevs[idx];
        elevSum += elev;
        posAttr.setXYZ(idx, (gx - BASE_GX) * CELL_M, elev, (gy - BASE_GY) * CELL_M);
      }
    }
    posAttr.needsUpdate = true;
    this.terrainGeo.computeVertexNormals();

    const meanElev = elevSum / TOTAL_CELLS;
    this.controls.target.set(0, meanElev, 0);
    this.controls.update();

    const baseWorld = gridToWorld(BASE_GX, BASE_GY, elevs[BASE_IDX], OVERLAY_Y_OFFSET);
    this.baseGroup.position.set(baseWorld.x, baseWorld.y, baseWorld.z);

    dem.waypoints.forEach((wp, i) => {
      if (this.waypointMeshes[i]) {
        const wpIdx = wp.gy * GRID_N + wp.gx;
        const pos = gridToWorld(wp.gx, wp.gy, elevs[wpIdx], OVERLAY_Y_OFFSET);
        this.waypointMeshes[i].position.set(pos.x, pos.y, pos.z);
      }
    });
  }

  /**
   * Updates vertex colors (5 NASA shaders + 3D translucent contour fill), Marching Squares lines,
   * #0A84FF optimal return path, and Astronaut pin position without heap allocations.
   */
  updateNavigationState(dem, state, solver, heroMetrics) {
    if (!dem) return;
    if (this.activeDem !== dem) {
      this.setSiteDataset(dem);
    }

    const elevs = dem.elevations;
    const tiu = dem.thermalInertia;
    const crism = dem.mineralConcentration;
    const lit = dem.sunLitMask;
    const svf = dem.skyViewFactor;
    const slopes = dem.maxSlopeDeg;
    const totalField = solver.totalField;
    const returnCost = solver.returnCostMap;
    const isExceeded = !!(heroMetrics && heroMetrics.status === 'EXCEEDED');
    const activeLayer = state.activeLayer || 'topo';
    const colors = this.vertexColors;
    const albedo = this.albedoRgb;

    const minElev = Number.isFinite(dem.minElev)
      ? dem.minElev
      : dem.id === 'JEZERO_DELTA'
        ? -2580.0
        : -2450.0;
    const maxElev = Number.isFinite(dem.maxElev)
      ? dem.maxElev
      : dem.id === 'JEZERO_DELTA'
        ? -2080.0
        : -1720.0;
    const spanElev = Math.max(1.0, maxElev - minElev);
    const windAz = state.windAzRad ?? 1.92;
    const windDirX = Math.sin(windAz);
    const windDirY = -Math.cos(windAz);
    const windSpeedNorm = Math.max(0.0, Math.min(1.0, (state.windSpeedMs ?? 8.5) / 18.0));

    for (let i = 0; i < TOTAL_CELLS; i++) {
      const cIdx = i * 3;
      let r = 0.55;
      let g = 0.34;
      let b = 0.25;

      // 1. Base NASA Layer Dataset Shader
      if (activeLayer === 'topo') {
        const h = Math.max(0.0, Math.min(1.0, (elevs[i] - minElev) / spanElev));
        r = 0.42 + h * 0.48;
        g = 0.24 + h * 0.28;
        b = 0.17 + h * 0.18;
        if (lit[i] === 0) {
          r *= 0.62;
          g *= 0.62;
          b *= 0.72;
        }
      } else if (activeLayer === 'themis') {
        const tNorm = Math.max(0.0, Math.min(1.0, (tiu[i] - 55.0) / 360.0));
        // Loose sand (<100 TIU) warm orange-ochre; consolidated rock cool slate
        r = 0.92 * (1.0 - tNorm) + 0.32 * tNorm;
        g = 0.56 * (1.0 - tNorm) + 0.40 * tNorm;
        b = 0.22 * (1.0 - tNorm) + 0.52 * tNorm;
        if (lit[i] === 0) {
          r *= 0.58;
          g *= 0.64;
          b *= 0.88;
        }
      } else if (activeLayer === 'crism') {
        const m = crism[i];
        r = 0.28 + m * 0.62;
        g = 0.25 + (1.0 - Math.abs(m - 0.55) * 1.4) * 0.52;
        b = 0.32 + m * 0.48;
      } else if (activeLayer === 'meda') {
        const gx = i % GRID_N;
        const gy = (i / GRID_N) | 0;
        const iL = gx > 0 ? i - 1 : i;
        const iR = gx < GRID_N - 1 ? i + 1 : i;
        const iU = gy > 0 ? i - GRID_N : i;
        const iD = gy < GRID_N - 1 ? i + GRID_N : i;
        const spanX = (gx > 0 && gx < GRID_N - 1 ? 2.0 : 1.0) * CELL_M;
        const spanY = (gy > 0 && gy < GRID_N - 1 ? 2.0 : 1.0) * CELL_M;
        const gradX = (elevs[iR] - elevs[iL]) / spanX;
        const gradY = (elevs[iD] - elevs[iU]) / spanY;
        const windwardProj = Math.max(-0.5, Math.min(0.5, gradX * windDirX + gradY * windDirY));
        const exposure = Math.max(
          0.0,
          Math.min(1.0, (0.35 + 0.65 * svf[i]) * (0.55 + windwardProj * 0.9) * (0.45 + 0.55 * windSpeedNorm))
        );
        // High windward/katabatic chill: icy cyan (#38BDF8); sheltered leeward troughs: deep slate
        r = 0.14 + exposure * 0.14;
        g = 0.24 + exposure * 0.54;
        b = 0.36 + exposure * 0.60;
      } else if (activeLayer === 'rad') {
        const exp = svf[i];
        if (state.sepStormActive) {
          r = 0.25 + exp * 0.75;
          g = 0.16 + (1.0 - exp) * 0.45;
          b = 0.42 + (1.0 - exp) * 0.48;
        } else {
          r = 0.22 + exp * 0.42;
          g = 0.36 + exp * 0.32;
          b = 0.58 + (1.0 - exp) * 0.30;
        }
      }

      // Subtle 22% blend with Mars Trek / fallback orbital albedo
      r = r * 0.78 + albedo[cIdx] * 0.22;
      g = g * 0.78 + albedo[cIdx + 1] * 0.22;
      b = b * 0.78 + albedo[cIdx + 2] * 0.22;

      // 2. Dynamic 3D Translucent Isochrone Contour Surface Fill (§2.6 + Red Zone Projection)
      const fVal = isExceeded ? returnCost[i] : totalField[i];
      if (fVal <= 0.75) {
        // Safe Return Interior: 22% emerald blend
        r = r * 0.78 + COL_SAFE[0] * 0.22;
        g = g * 0.78 + COL_SAFE[1] * 0.22;
        b = b * 0.78 + COL_SAFE[2] * 0.22;
      } else if (fVal <= 1.0) {
        // Caution Zone: 20% amber blend
        r = r * 0.80 + COL_CAUTION[0] * 0.20;
        g = g * 0.80 + COL_CAUTION[1] * 0.20;
        b = b * 0.80 + COL_CAUTION[2] * 0.20;
      } else {
        // Exceeded / No-Return Red Zone: project visible crimson #FF453A tint onto exterior terrain
        const redBlend = isExceeded ? 0.28 : 0.18;
        r = r * 0.55 * (1.0 - redBlend) + COL_CRITICAL[0] * redBlend;
        g = g * 0.55 * (1.0 - redBlend) + COL_CRITICAL[1] * redBlend;
        b = b * 0.55 * (1.0 - redBlend) + COL_CRITICAL[2] * redBlend;
        if (state.layers.topo && slopes[i] > 33.0) {
          r = r * 0.28 + COL_CRITICAL[0] * 0.72;
          g = g * 0.28 + COL_CRITICAL[1] * 0.72;
          b = b * 0.28 + COL_CRITICAL[2] * 0.72;
        }
      }

      colors[cIdx] = r;
      colors[cIdx + 1] = g;
      colors[cIdx + 2] = b;
    }
    this.terrainGeo.attributes.color.needsUpdate = true;

    // 3. Marching Squares Contour Geometries (T=0.75 Amber & T=1.0 Green/Red)
    const count075 = solver.contour075FloatCount;
    if (count075 > 0) {
      this.contour075Buffer.set(solver.contour075Segments.subarray(0, count075));
      this.contour075Geo.attributes.position.needsUpdate = true;
    }
    this.contour075Geo.setDrawRange(0, (count075 / 3) | 0);

    const count100 = solver.contour100FloatCount;
    if (count100 > 0) {
      this.contour100Buffer.set(solver.contour100Segments.subarray(0, count100));
      this.contour100Geo.attributes.position.needsUpdate = true;
    }
    this.contour100Geo.setDrawRange(0, (count100 / 3) | 0);
    this.contour100Mat.color.setHex(heroMetrics.status === 'EXCEEDED' ? 0xff453a : 0x30d158);

    // 4. Optimal Minimum-Energy Return Path (#0A84FF)
    const pathLen = solver.returnPathLength;
    const pathIndices = solver.returnPathIndices;
    for (let i = 0; i < pathLen; i++) {
      const idx = pathIndices[i];
      const gx = idx % GRID_N;
      const gy = (idx / GRID_N) | 0;
      const pOff = i * 3;
      this.returnPathBuffer[pOff] = (gx - BASE_GX) * CELL_M;
      this.returnPathBuffer[pOff + 1] = elevs[idx] + OVERLAY_Y_OFFSET + 2.0;
      this.returnPathBuffer[pOff + 2] = (gy - BASE_GY) * CELL_M;
    }
    this.returnPathGeo.attributes.position.needsUpdate = true;
    this.returnPathGeo.setDrawRange(0, pathLen);

    // 5. Update Astronaut EVA Pin Position & Semantic Glow
    const astroIdx = state.astroGy * GRID_N + state.astroGx;
    const astroWorld = gridToWorld(state.astroGx, state.astroGy, elevs[astroIdx], OVERLAY_Y_OFFSET);
    this.astroGroup.position.set(astroWorld.x, astroWorld.y, astroWorld.z);

    const statusHex =
      heroMetrics.status === 'EXCEEDED'
        ? 0xff453a
        : heroMetrics.status === 'CAUTION'
          ? 0xff9f0a
          : 0x30d158;
    this.astroCoreMat.color.setHex(statusHex);
    this.astroCoreMat.emissive.setHex(statusHex);
    this.astroHaloMat.color.setHex(statusHex);

    if (this.ecoMode) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Switches 3D sky/fog backdrop between Lite (Daylight) and Dark themes.
   */
  setTheme(isLight) {
    const hex = isLight ? 0xdbe2ef : 0x07090e;
    this.scene.background.setHex(hex);
    if (this.scene.fog) {
      this.scene.fog.color.setHex(hex);
    }
    if (this.ecoMode) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Engages CR2032 GPU power-gating (0.0 mW) via renderer.setAnimationLoop(null).
   */
  setEcoMode(enabled) {
    this.ecoMode = !!enabled;
    return applyEcoPowerGating(this.ecoMode, this.renderer, this._animateBound);
  }

  _animate() {
    this.controls.update();
    const t = performance.now() * 0.002;
    for (let i = 0; i < this.waypointMeshes.length; i++) {
      const beacon = this.waypointMeshes[i].children[0];
      if (beacon) beacon.rotation.y = t + i;
    }
    this.renderer.render(this.scene, this.camera);
  }
}

