import { h } from 'preact';
import htm from 'htm';
export const html = htm.bind(h);
export const usd = n => '$' + (+n || 0).toFixed(2);
export const rel = ms => {
  const s = (Date.now() - ms) / 1000;
  if (!ms || Number.isNaN(s)) return '';
  if (s < 60) return Math.max(0, Math.round(s)) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
export const Pill = ({ state }) => html`<span class="pill st-${state || 'never'}">${state || 'never'}</span>`;
