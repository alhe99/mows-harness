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
// TODO(scroll-restore gap, confirmed live in Task 4): unlike navigate(), this handler never
// saves scrollByPath for the page being left. Symptom: scroll here, then Back, then Forward,
// then Back again — you land back at the OLD scroll (from the last click-navigation), not the
// one you just set, because nothing captured it before this popstate fired. Fix, if taken: save
// scrollByPath.set(location.pathname, window.scrollY) for the outgoing path before dispatching
// 'route' — but note location.pathname has already changed to the new path by the time this
// fires, so the outgoing path must be tracked separately (e.g. remember the previous path in a
// closure variable) rather than read off `location` here.
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
