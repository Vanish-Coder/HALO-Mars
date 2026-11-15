/**
 * BioRadius — Shared inline SVG icon helpers.
 * Icons are defined once as hidden <symbol> elements in index.html and referenced
 * with <svg><use href="#icon-name"/></svg> so they inherit currentColor.
 */

export function iconSvg(name, className = 'ui-icon') {
  const safe = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#icon-${safe}"/></svg>`;
}

export const LAYER_ICON_NAMES = {
  topo: 'mountain',
  themis: 'thermometer',
  crism: 'package',
  meda: 'wind',
  rad: 'sun'
};
