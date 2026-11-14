/**
 * BioRadius — CR2032 Coin-Cell Microwatt Power Profiler & 1 Hz WebGL Power-Gating
 * Models power draw across 60 Hz WebGL2 3D rendering vs. 1 Hz Always-On Watch Mode
 * powered by a single 3V, 220mAh CR2032 lithium coin cell.
 */

export const CR2032_VOLTAGE_V = 3.0;
export const CR2032_CAPACITY_MAH = 220.0;
export const CR2032_ENERGY_MWH = CR2032_VOLTAGE_V * CR2032_CAPACITY_MAH; // 660.0 mWh

/**
 * Computes instantaneous subsystem power draw (mW), current (mA), and coin-cell runtime (hrs).
 */
export function computePowerProfile(ecoModeEnabled, fps = 60) {
  if (ecoModeEnabled) {
    const gpuMw = 0.0;
    const cpuMw = 19.5;
    const displayMw = 22.8;
    const totalMw = gpuMw + cpuMw + displayMw; // 42.3 mW
    const currentMa = totalMw / CR2032_VOLTAGE_V; // 14.1 mA
    const batteryHours = CR2032_CAPACITY_MAH / currentMa; // 15.6028 hrs -> 15.6 HRS

    return {
      ecoMode: true,
      fps: 1,
      gpuMw,
      cpuMw,
      displayMw,
      totalMw,
      currentMa,
      batteryHours,
      modeLabel: 'CR2032 1Hz ECO',
      telemetryBadge: '0.0 mW GPU • 14.1 mA / 42.3 mW → 15.6 HRS'
    };
  }

  const clampedFps = Math.max(15, Math.min(120, fps));
  const scale = clampedFps / 60.0;
  const gpuMw = 148.5 * scale;
  const cpuMw = 38.4;
  const displayMw = 45.0;
  const totalMw = gpuMw + cpuMw + displayMw;
  const currentMa = totalMw / CR2032_VOLTAGE_V;
  const batteryHours = CR2032_CAPACITY_MAH / currentMa;

  return {
    ecoMode: false,
    fps: Math.round(clampedFps),
    gpuMw,
    cpuMw,
    displayMw,
    totalMw,
    currentMa,
    batteryHours,
    modeLabel: '60Hz WebGL2 3D',
    telemetryBadge: `${gpuMw.toFixed(1)} mW GPU • ${currentMa.toFixed(1)} mA / ${totalMw.toFixed(1)} mW → ${batteryHours.toFixed(1)} HRS`
  };
}

/**
 * Engages or disengages WebGL GPU power-gating via Three.js renderer.setAnimationLoop.
 */
export function applyEcoPowerGating(ecoModeEnabled, renderer, animateCallback = null) {
  if (renderer && typeof renderer.setAnimationLoop === 'function') {
    if (ecoModeEnabled) {
      renderer.setAnimationLoop(null);
    } else if (typeof animateCallback === 'function') {
      renderer.setAnimationLoop(animateCallback);
    }
  }
  return computePowerProfile(ecoModeEnabled, ecoModeEnabled ? 1 : 60);
}

