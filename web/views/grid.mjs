// grid.mjs — the /grid view (spec docs/superpowers/specs/2026-10-11-grid-view-design.md). Placeholder until Task 4.
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
// The no-op effect is deliberate: a view that imports preact but not preact/hooks makes esbuild split hooks into its own chunk,
// which adds one file (and its gzip header) to every other route's closure and pushes the system route over its 15 kB budget.
export default function Grid() {
  useEffect(() => {}, []);
  return h('h1', { 'data-view': 'grid' }, 'grid');
}
