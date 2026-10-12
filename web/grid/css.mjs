// css.mjs — the grid view's rules, adopted through document.adoptedStyleSheets (the shell CSP allows no inline <style>; CSSOM is not
// governed by it). The geometry is the Figma "Mission Control Dashboard Redesign" frame (mows-control, node 52-2, 2026-10-12); the
// colours are tokens.css (the frame's greys were a palette of their own, 2026-10-12). Panes are a CSS grid whose columns come from the state's fractions.
export const CSS = `
/* full bleed: the shell's body is a 1024 px column with 48 px padding (tokens.css); here it is the viewport, edge to edge, header and footer gone */
body.gridv{max-width:none;padding:0;height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden}
body.gridv #app{flex:1;min-height:0;display:flex;flex-direction:column}
/* the shell header's row goes to the panes: its nav lives at the right end of the tab strip (.gnav), its New Session is the strip's + */
body.gridv .hdr,body.gridv .termfab,body.gridv .tabs,body.gridv footer{display:none}
/* sidebar (the card from before the 2026-10-12 facelift, kept at the owner's request) | 24 px gutter (the resize handle) | main */
#grid{display:grid;grid-template-columns:var(--gsb,256px) 24px minmax(0,1fr);flex:1;min-height:0;gap:0;padding:8px 0 0 8px;box-sizing:border-box}
#gsb{display:flex;flex-direction:column;min-width:0;overflow:hidden;margin-bottom:8px;background:var(--card);border:1px solid var(--bd);border-radius:12px}
#gsb .ghd{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--hair);font:600 11px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
#gsb .ghd button{min-height:0;padding:3px 8px;font:12px var(--mono);background:var(--card2);color:var(--fg2);border:1px solid var(--bd);border-radius:6px}
#gsb .glist{flex:1;overflow-y:auto;padding:4px 0}
#gsb details.gg>summary{cursor:pointer;list-style:none;padding:6px 12px;font:600 12px var(--mono);color:var(--mut)}
#gsb details.gg>summary::before{content:'▸ ';}#gsb details.gg[open]>summary::before{content:'▾ '}
#gsb .gr{display:grid;grid-template-columns:16px minmax(0,1fr) auto auto;grid-template-rows:auto auto;column-gap:8px;padding:7px 12px;cursor:pointer;border-left:2px solid transparent}
#gsb .gr:hover{background:var(--card2)}#gsb .gr[data-open="1"]{border-left-color:var(--ok)}
#gsb .gr .fli{grid-row:1/3;align-self:start;margin-top:2px}
#gsb .gr .lb{font:500 13px var(--sans);color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gsb .gr .grn{grid-column:2/5;display:flex;min-width:0}#gsb .gr .grn input{flex:1;min-width:0;min-height:0;height:20px;box-sizing:border-box;padding:0 6px;font:500 13px var(--sans);line-height:18px;background:var(--card2);color:var(--fg);border:1px solid var(--bd);border-radius:5px;outline-offset:-2px}
#gsb .gr .fst,#gsb .gr .fsnip{grid-column:2/5;font:11px var(--mono);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gsb .gr .gren{min-height:0;padding:1px 5px;font:12px var(--mono);background:transparent;color:var(--mut);border:1px solid transparent;border-radius:5px;opacity:0}#gsb .gr:hover .gren,#gsb .gr:focus-within .gren{opacity:1}#gsb .gr .gren:hover{border-color:var(--bd);color:var(--fg)}
#gsb .gr .gsplit{min-height:0;padding:1px 6px;font:11px var(--mono);background:transparent;color:var(--mut);border:1px solid var(--bd);border-radius:5px;opacity:0}
#gsb .gr:hover .gsplit,#gsb .gr:focus-within .gsplit{opacity:1}#gsb .gr .gsplit[data-full]{opacity:.3}
.gdot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
#gh-sb,.gh{cursor:col-resize;background:transparent;touch-action:none}.gw .gh{grid-row:1/-1}.gh:hover,#grid.drag .gh{background:var(--pop)}
#grid.nosb{grid-template-columns:minmax(0,1fr);padding-left:0}#grid.nosb #gsb,#grid.nosb #gh-sb{display:none} /* one column: the main is the only grid item then (a hidden item does not hold its column) */
#gmain{display:flex;flex-direction:column;min-width:0;min-height:0}
/* tab strip: 38 px, each tab a 16 px cell with a right hairline, the active one lifted to the card; then +, the notice, the cockpit nav */
#gtabs{display:flex;align-items:center;height:38px;flex-shrink:0;border-bottom:1px solid var(--hair)}
#gtabs .gts{display:flex;align-items:center;min-width:0;overflow-x:auto;scrollbar-width:none}#gtabs .gts::-webkit-scrollbar{display:none}
#gtabs .gt{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 16px;border-right:1px solid var(--hair);color:var(--mut);font:400 13px/19.5px var(--mono);cursor:pointer;user-select:none;white-space:nowrap;touch-action:none;flex-shrink:0}
#gtabs .gt.on{background:var(--card2);color:var(--fg)}#gtabs .gt:not(.on):hover{color:var(--fg2)}#gtabs .gt.dragging{opacity:.5}
#gtabs .gt .gdot{border:0;background:var(--bd3);box-shadow:none}#gtabs .gt .gdot[data-state=working]{background:var(--ok)}#gtabs .gt .gdot[data-state=needs-you],#gtabs .gt .gdot[data-state=paused]{background:var(--warn)}
#gtabs .gx{min-height:0;height:12px;width:20px;padding:0 0 0 8px;box-sizing:border-box;background:transparent;border:0;display:inline-flex;align-items:center;cursor:pointer}
#gtabs .gnew{display:inline-flex;align-items:center;height:38px;padding:0 16px;background:transparent;border:0;border-right:1px solid var(--hair);cursor:pointer;flex-shrink:0}
#gtabs .gsbt{min-height:0;height:38px;width:36px;padding:0;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:0;border-right:1px solid var(--hair);cursor:pointer;flex-shrink:0}
#gtabs .gsbt path{stroke:var(--mut)}#gtabs .gsbt:hover path{stroke:var(--fg)}
#gtabs .gx path,#gtabs .gnew path{stroke:var(--dimmer)}.gph button path{stroke:var(--mut)}#gtabs .gx:hover path,#gtabs .gnew:hover path,.gph button:hover path{stroke:var(--fg)}
#gnotice{font:11px/16.5px var(--mono);color:var(--warn);padding:0 16px;white-space:nowrap}
.gnav{margin-left:auto;display:flex;gap:16px;flex-shrink:0;padding:0 16px}.gnav a{color:var(--mut);font:400 11px/16.5px var(--mono);white-space:nowrap;text-decoration:none}.gnav a:hover{color:var(--fg)}.gnav .vsw a{padding:2px 8px;font:400 11px/16.5px var(--mono)}
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
