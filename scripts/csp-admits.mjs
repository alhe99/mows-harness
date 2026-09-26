// Does the served document actually SURVIVE the policy it was served with?
//
//   node scripts/csp-admits.mjs <url>        -> JSON on stdout, non-zero exit if anything is refused
//
// WHY THIS EXISTS. The five CSP assertions in scripts/e2e-infra.sh inspect the HEADER: that it is
// present, strict, nonced, and that its nonce is minted per response. None of them looks at the
// DOCUMENT. A Content-Security-Policy is a change that breaks an application silently — add one
// inline `style=""` attribute to a view, or a second inline <script>, and /ui renders unstyled or
// does not boot at all in production, with every one of those five green, preflight ALL CLEAN and
// both mutation sweeps clean, because nothing in this repo runs a browser (Task 9 review, F3).
//
// WHAT IT IS NOT. It is not a browser. It decides admissibility by CSP's own rules over the served
// markup; it cannot tell you the page rendered correctly, only that nothing in it would be refused.
// The browser proof of "the SPA boots under this policy" is in docs/qa/journeys/agent-chat.md and
// has to be run by hand. This closes the gap between "the header looks right" and "the page the
// header was sent with is admissible under it", which is where the silent break lives.
//
// Node stdlib only, so it runs in the same container as the rest of scripts/e2e-infra.sh.

const url = process.argv[2];
if (!url) { console.error('usage: csp-admits.mjs <url>'); process.exit(2); }

const res = await fetch(url, { redirect: 'manual' });
const policy = res.headers.get('content-security-policy') || '';
const html = await res.text();

// ---- the policy -----------------------------------------------------------------------------
const dirs = new Map();
for (const part of policy.split(';')) {
  const [name, ...vals] = part.trim().split(/\s+/);
  if (name) dirs.set(name.toLowerCase(), vals);
}
const src = k => dirs.get(k) || dirs.get(k.replace(/-(elem|attr)$/, '')) || dirs.get('default-src') || null;
const nonces = (src('script-src') || []).concat(src('style-src') || [])
  .map(v => /^'nonce-(.+)'$/.exec(v)).filter(Boolean).map(m => m[1]);
const headerNonce = nonces.length ? nonces[0] : null;
const allowsInline = k => (src(k) || []).includes("'unsafe-inline'");

// ---- the document ---------------------------------------------------------------------------
// The same tag/attribute scanner shape as scripts/chat-view-check.mjs's detector: it steps over
// TAGS and reads attributes out of the tag body, so the CONTENT between tags — the inline CSS, the
// import map's JSON — is never mistaken for markup. That matters here: a naive scan for `on…=`
// across the whole document would flag ordinary CSS.
const TAG = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
const ATTR = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const out = { url, policy, headerNonce, nonced: 0, wrongNonce: 0, styleAttrs: 0, eventAttrs: 0, offOrigin: 0, refused: [] };
let m;
TAG.lastIndex = 0;
while ((m = TAG.exec(html))) {
  const tag = m[1].toLowerCase(), body = m[2] || '';
  const attrs = new Map();
  ATTR.lastIndex = 0;
  let a;
  while ((a = ATTR.exec(body))) attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');

  const nonce = attrs.get('nonce');
  if (nonce != null) {
    if (headerNonce && nonce === headerNonce) out.nonced++;
    else { out.wrongNonce++; out.refused.push(`<${tag}> carries a nonce the header does not name`); }
  }
  // An inline style attribute is governed by style-src-attr, which falls back to style-src. With a
  // nonce present, CSP3 ignores 'unsafe-inline', so there is no way to permit one short of a hash.
  if (attrs.has('style')) {
    out.styleAttrs++;
    if (!allowsInline('style-src-attr')) out.refused.push(`<${tag} style="…"> — refused by style-src-attr`);
  }
  for (const k of attrs.keys()) {
    if (!/^on[a-z]+$/.test(k)) continue;
    out.eventAttrs++;
    if (!allowsInline('script-src-attr')) out.refused.push(`<${tag} ${k}="…"> — refused by script-src-attr`);
  }
  // Inline <script> / <style> ELEMENTS need the nonce (or 'unsafe-inline', which a nonce disables).
  const isInlineScript = tag === 'script' && !attrs.has('src');
  const isInlineStyle = tag === 'style';
  if ((isInlineScript || isInlineStyle) && !(nonce && nonce === headerNonce)
      && !allowsInline(isInlineScript ? 'script-src-elem' : 'style-src-elem')) {
    out.refused.push(`inline <${tag}> with no matching nonce — refused by ${isInlineScript ? 'script-src' : 'style-src'}`);
  }
  // Every subresource this document names must be same-origin, which is all `'self'` permits. A
  // relative URL is same-origin by construction; an absolute one has to be checked.
  for (const k of ['src', 'href']) {
    const v = attrs.get(k);
    if (!v || tag === 'a' || v.startsWith('#')) continue;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v) || v.startsWith('//')) {
      out.offOrigin++;
      out.refused.push(`<${tag} ${k}="${v.slice(0, 60)}"> is off-origin, and only 'self' is permitted`);
    }
  }
}

console.log(JSON.stringify(out, null, 2));
process.exit(out.refused.length ? 1 : 0);
