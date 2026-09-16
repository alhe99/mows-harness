import { h, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { html } from './ui.mjs';
import { AgentsList, AgentDetail } from './views/agents.mjs';
import { RunView } from './views/runs.mjs';

// Same-document View Transitions replace the cross-document ones the server-rendered pages use,
// so the pinned tab bar and crossfade survive the move to an SPA (spec §2).
const scrollByPath = new Map();
function navigate(to, replace = false) {
  scrollByPath.set(location.pathname, window.scrollY);
  const go = () => { history[replace ? 'replaceState' : 'pushState']({}, '', to); window.dispatchEvent(new Event('route')); };
  if (document.startViewTransition) document.startViewTransition(go); else go();
}
window.addEventListener('click', e => {
  const a = e.target.closest?.('a[href^="/ui"]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  e.preventDefault(); navigate(a.getAttribute('href'));
});
// bfcache is gone (spec §2), so back/forward scroll restoration is ours now.
window.addEventListener('popstate', () => window.dispatchEvent(new Event('route')));

function route(path) {
  let m;
  if ((m = path.match(/^\/ui\/agents\/([^/]+)\/([^/]+)$/))) return html`<${RunView} name=${m[1]} run=${m[2]} />`;
  if ((m = path.match(/^\/ui\/agents\/([^/]+)$/))) return html`<${AgentDetail} name=${m[1]} />`;
  return html`<${AgentsList} />`;
}
function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => { setPath(location.pathname); requestAnimationFrame(() => window.scrollTo(0, scrollByPath.get(location.pathname) || 0)); };
    window.addEventListener('route', on);
    return () => window.removeEventListener('route', on);
  }, []);
  return route(path);
}
render(html`<${App} />`, document.getElementById('app'));
export { navigate };
