// css.mjs — the grid view's rules, adopted through document.adoptedStyleSheets (the shell CSP allows no inline <style>; CSSOM is not
// governed by it). The geometry is the Figma "Mission Control Dashboard Redesign" frame (mows-control, node 52-2, 2026-10-12); the
// colours are tokens.css (the frame's greys were a palette of their own, 2026-10-12). Panes are a CSS grid whose columns come from the state's fractions.
export const CSS = `
/* full bleed: the shell's body is a 1024 px column with 48 px padding (tokens.css); here it is the viewport, edge to edge, header and footer gone */
body.gridv{max-width:none;padding:0;height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden}
body.gridv #app{flex:1;min-height:0;display:flex;flex-direction:column}
/* the shell header's row goes to the panes: its nav lives at the right end of the tab strip (.gnav), its New Session is the strip's + */
body.gridv .hdr,body.gridv .termfab,body.gridv .tabs,body.gridv footer{display:none}
/* sidebar | 24 px gutter (the resize handle) | main */
#grid{display:grid;grid-template-columns:var(--gsb,256px) 24px minmax(0,1fr);flex:1;min-height:0;gap:0}
#gsb{display:flex;flex-direction:column;min-width:0;overflow:hidden;background:var(--bg);border-right:1px solid var(--hair)}
#gsb .ghd{display:flex;align-items:center;height:38px;flex-shrink:0;padding:0 16px}
#gsb .ghd button{min-height:0;padding:4px 8px;font:500 11px/16.5px var(--sans);background:var(--card2);color:var(--mut);border:1px solid var(--bd);border-radius:4px;cursor:pointer}#gsb .ghd button:hover{color:var(--fg);border-color:var(--bd2)}
#gsb .glist{flex:1;overflow-y:auto;padding:16px 16px 24px;scrollbar-width:thin}
#gsb details.gg{margin:0}#gsb details.gg+details.gg{margin-top:24px}
#gsb details.gg>summary{cursor:pointer;list-style:none;min-height:0;display:flex;align-items:center;gap:6px;padding:0 8px;font:700 10px/15px var(--sans);letter-spacing:1px;text-transform:uppercase;color:var(--dim);user-select:none}
#gsb details.gg>summary::-webkit-details-marker{display:none}
#gsb details.gg>summary svg{flex-shrink:0;transition:transform .15s}#gsb details.gg>summary path{stroke:var(--dim)}#gsb details.gg:not([open])>summary svg{transform:rotate(-90deg)}
#gsb summary+.gr{margin-top:12px}#gsb .gr+.gr{margin-top:2px}
/* a session row: dot, name, "idle 23m"; on hover the rename and split buttons take the meta's place (an overlay: the row never reflows);
   the needs-you snippet is a second line */
#gsb .gr{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:0 10px;padding:8px 12px;border-radius:12px;cursor:pointer;color:var(--mut)}
#gsb .gr:hover{background:var(--card)}#gsb .gr:focus-visible{outline:1px solid var(--bd3);outline-offset:-1px}
#gsb .gr[data-open="1"]{background:var(--card2);box-shadow:0 1px 3px rgba(0,0,0,.1),0 1px 2px rgba(0,0,0,.1);color:var(--fg)}
.gdot{width:6px;height:6px;border-radius:50%;box-sizing:border-box;border:1px solid var(--dimmer);flex-shrink:0}
.gdot[data-state=working]{background:var(--ok);border-color:var(--ok);box-shadow:0 0 8px rgba(0,212,146,.5)}
.gdot[data-state=needs-you],.gdot[data-state=paused]{background:var(--warn);border-color:var(--warn);box-shadow:0 0 8px rgba(255,185,0,.5)}
#gsb .gr .lb{flex:1;min-width:0;font:500 13px/19.5px var(--sans);letter-spacing:-.325px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gsb .gr .grn{flex:1;min-width:0;display:flex}#gsb .gr .grn input{flex:1;min-width:0;min-height:0;height:20px;box-sizing:border-box;padding:0 6px;font:500 13px var(--sans);line-height:18px;background:var(--card2);color:var(--fg);border:1px solid var(--bd2);border-radius:5px;outline-offset:-2px}
#gsb .gr .fst{font:400 10px/15px var(--mono);opacity:.6;white-space:nowrap}
#gsb .gr .fsnip{display:none;flex-basis:100%;padding-left:16px;font:10px/15px var(--mono);color:var(--warn);opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#gsb .gr[data-state=needs-you] .fsnip{display:block}
#gsb .gr .gact{position:absolute;right:12px;top:8px;z-index:1;height:19.5px;display:flex;align-items:center;gap:4px;opacity:0}
#gsb .gr .gren,#gsb .gr .gsplit{min-height:0;padding:0 4px;font:10px/15px var(--mono);background:transparent;color:var(--dim);border:0;border-radius:4px;cursor:pointer}
#gsb .gr:hover .gact,#gsb .gr:has(:focus-visible) .gact{opacity:1}#gsb .gr:hover .fst,#gsb .gr:has(:focus-visible) .fst{opacity:0;pointer-events:none}#gsb .gr .gren:hover,#gsb .gr .gsplit:hover{color:var(--fg)}#gsb .gr .gsplit[data-full]{opacity:.3}
#gh-sb,.gh{cursor:col-resize;background:transparent;touch-action:none}.gw .gh{grid-row:1/-1}.gh:hover,#grid.drag .gh{background:var(--pop)}
#gmain{display:flex;flex-direction:column;min-width:0;min-height:0}
/* tab strip: 38 px, each tab a 16 px cell with a right hairline, the active one lifted to the card; then +, the notice, the cockpit nav */
#gtabs{display:flex;align-items:center;height:38px;flex-shrink:0;border-bottom:1px solid var(--hair)}
#gtabs .gts{display:flex;align-items:center;min-width:0;overflow-x:auto;scrollbar-width:none}#gtabs .gts::-webkit-scrollbar{display:none}
#gtabs .gt{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 16px;border-right:1px solid var(--hair);color:var(--mut);font:400 13px/19.5px var(--mono);cursor:pointer;user-select:none;white-space:nowrap;touch-action:none;flex-shrink:0}
#gtabs .gt.on{background:var(--card2);color:var(--fg)}#gtabs .gt:not(.on):hover{color:var(--fg2)}#gtabs .gt.dragging{opacity:.5}
#gtabs .gt .gdot{border:0;background:var(--bd3);box-shadow:none}#gtabs .gt .gdot[data-state=working]{background:var(--ok)}#gtabs .gt .gdot[data-state=needs-you],#gtabs .gt .gdot[data-state=paused]{background:var(--warn)}
#gtabs .gx{min-height:0;height:12px;width:20px;padding:0 0 0 8px;box-sizing:border-box;background:transparent;border:0;display:inline-flex;align-items:center;cursor:pointer}
#gtabs .gnew{display:inline-flex;align-items:center;height:38px;padding:0 16px;border-right:1px solid var(--hair);flex-shrink:0}
#gtabs .gx path,#gtabs .gnew path{stroke:var(--dimmer)}.gph button path{stroke:var(--mut)}#gtabs .gx:hover path,#gtabs .gnew:hover path,.gph button:hover path{stroke:var(--fg)}
#gnotice{font:11px/16.5px var(--mono);color:var(--warn);padding:0 16px;white-space:nowrap}
.gnav{margin-left:auto;display:flex;gap:16px;flex-shrink:0;padding:0 16px}.gnav a{color:var(--mut);font:400 11px/16.5px var(--mono);white-space:nowrap;text-decoration:none}.gnav a:hover{color:var(--fg)}
.gw{flex:1;min-height:0;display:grid;grid-auto-rows:minmax(0,1fr);gap:0;overflow:hidden}
.gw[hidden]{display:none}
.gp{display:flex;flex-direction:column;min-width:0;min-height:0}
/* pane header: name, state, then the own-tab / zoom / close icons; the focused pane's name is the bright one */
.gph{display:flex;align-items:center;gap:12px;padding:8px 16px 7px;background:var(--card);border-bottom:1px solid var(--bd);font:400 13px/19.5px var(--mono);color:var(--mut);cursor:default;user-select:none;flex-shrink:0}
.gp.on .gph{background:var(--card2)}.gph b{font-weight:400;color:var(--mut)}.gp.on .gph b{color:var(--fg)}.gp.ended .gph{color:var(--warn)}
.gph .gsp{flex:1}
.gph button{min-height:0;height:14px;padding:0;background:transparent;border:0;display:inline-flex;align-items:center;cursor:pointer;color:var(--mut);font:13px/1 var(--mono)}.gph button:hover{color:var(--fg)}
.gp.needs .gph{animation:gpulse 1.6s ease-in-out infinite}
@keyframes gpulse{0%,100%{background:var(--card2)}50%{background:rgba(255,185,0,.14)}}
.gfr{flex:1;width:100%;border:0;background:var(--bg);min-height:0}
#grid.drag iframe{pointer-events:none}
#grid.tabdrag .gw:not([hidden]){outline:2px dashed var(--mut);outline-offset:-3px;cursor:copy}
.gpark,.gempty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--mut);font:13px var(--mono)}
[data-view=grid-phone]{padding:24px 8px;color:var(--mut);font:15px var(--sans)}
@media(prefers-reduced-motion:reduce){.gp.needs .gph{animation:none;background:rgba(255,185,0,.14)}}
`;
