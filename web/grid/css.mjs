// css.mjs — the grid view's rules, adopted through document.adoptedStyleSheets (the shell CSP allows no inline <style>; CSSOM is not
// governed by it). Colours are the tokens.css custom properties. Panes are a CSS grid whose columns come from the state's fractions.
export const CSS = `
/* full bleed: the shell's body is a 1024 px column with 48 px padding (tokens.css), which boxed the grid into a third of a desktop screen;
   here the body is a column the height of the viewport, the header keeps its own height, the grid takes the rest, the footer goes */
body.gridv{max-width:none;padding:8px 14px 8px;height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden}
body.gridv #app{flex:1;min-height:0;display:flex;flex-direction:column}
/* the shell header's row goes to the panes: its nav lives at the right end of the tab strip (.gnav), its New Session is the strip's + */
body.gridv .hdr,body.gridv .termfab,body.gridv .tabs,body.gridv footer{display:none}
#grid{display:grid;grid-template-columns:var(--gsb,260px) 6px minmax(0,1fr);flex:1;min-height:0;gap:0}
#gsb{display:flex;flex-direction:column;min-width:0;overflow:hidden;background:var(--card);border:1px solid var(--bd);border-radius:12px}
#gsb .ghd{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--hair);font:600 11px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
#gsb .ghd input{flex:1;min-width:0;min-height:0;padding:3px 8px;font:13px var(--sans)}
#gsb .ghd select,#gsb .ghd button{min-height:0;padding:3px 8px;font:12px var(--mono);background:var(--card2);color:var(--fg2);border:1px solid var(--bd);border-radius:6px}
#gsb .glist{flex:1;overflow-y:auto;padding:4px 0}
#gsb details.gg>summary{cursor:pointer;list-style:none;padding:6px 12px;font:600 12px var(--mono);color:var(--mut)}
#gsb details.gg>summary::before{content:'▸ ';}#gsb details.gg[open]>summary::before{content:'▾ '}
#gsb .gr{display:grid;grid-template-columns:16px minmax(0,1fr) auto auto;grid-template-rows:auto auto;column-gap:8px;padding:7px 12px;cursor:pointer;border-left:2px solid transparent}
#gsb .gr:hover{background:var(--card2)}#gsb .gr[data-open="1"]{border-left-color:var(--ok)}
#gsb .gr .fli{grid-row:1/3;align-self:start;margin-top:2px}
#gsb .gr .lb{font:500 13px var(--sans);color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gsb .gr .grn{display:flex;min-width:0}#gsb .gr .grn input{flex:1;min-width:0;min-height:0;height:20px;box-sizing:border-box;padding:0 6px;font:500 13px var(--sans);line-height:18px;background:var(--card2);color:var(--fg);border:1px solid var(--bd);border-radius:5px;outline-offset:-2px}
#gsb .gr .fst,#gsb .gr .fsnip{grid-column:2/5;font:11px var(--mono);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gsb .gr .gren{min-height:0;padding:1px 5px;font:12px var(--mono);background:transparent;color:var(--mut);border:1px solid transparent;border-radius:5px;opacity:0}#gsb .gr:hover .gren,#gsb .gr:focus-within .gren{opacity:1}#gsb .gr .gren:hover{border-color:var(--bd);color:var(--fg)}
#gsb .gr .grn{grid-column:2/5}
#gsb .gr .gsplit{min-height:0;padding:1px 6px;font:11px var(--mono);background:transparent;color:var(--mut);border:1px solid var(--bd);border-radius:5px;opacity:0}
#gsb .gr:hover .gsplit,#gsb .gr:focus-within .gsplit{opacity:1}#gsb .gr .gsplit[data-full]{opacity:.3}
#gh-sb,.gh{cursor:col-resize;background:transparent;touch-action:none}.gw .gh{grid-row:1/-1}#gh-sb:hover,.gh:hover,#grid.drag #gh-sb,#grid.drag .gh{background:var(--bd)}
#gmain{display:flex;flex-direction:column;min-width:0;min-height:0}
#gtabs{display:flex;align-items:center;gap:4px;height:34px;flex-shrink:0;padding:0 4px;overflow-x:auto}
#gtabs .gt{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 6px 0 10px;border:1px solid var(--bd);border-radius:8px 8px 0 0;background:var(--card);color:var(--mut);font:13px var(--mono);cursor:pointer;user-select:none;white-space:nowrap;touch-action:none}
#gtabs .gt.on{background:var(--card2);color:var(--fg)}#gtabs .gt.dragging{opacity:.5}
#gtabs .gdot{width:8px;height:8px;border-radius:50%;background:var(--dim)}#gtabs .gdot[data-state=working]{background:var(--ok)}#gtabs .gdot[data-state=needs-you],#gtabs .gdot[data-state=paused]{background:var(--warn)}
#gtabs .gx,#gtabs .gnew{min-height:0;height:22px;padding:0 6px;background:transparent;color:var(--mut);border:none;font:13px var(--mono);cursor:pointer}#gtabs .gx:hover,#gtabs .gnew:hover{color:var(--fg)}
#gnotice{font:12px var(--mono);color:var(--warn);padding:0 8px}
.gnav{margin-left:auto;display:flex;gap:2px;flex-shrink:0;padding-left:8px}.gnav a{padding:4px 10px;border-radius:999px;color:var(--mut);font:500 12.5px var(--sans);white-space:nowrap;text-decoration:none}.gnav a:hover{color:var(--fg2);background:var(--card2)}
.gw{flex:1;min-height:0;display:grid;grid-auto-rows:minmax(0,1fr);gap:0;border:1px solid var(--bd);border-radius:0 12px 12px 12px;overflow:hidden}
.gw[hidden]{display:none}
.gp{display:flex;flex-direction:column;min-width:0;min-height:0;border:1px solid transparent;outline:1px solid var(--hair);outline-offset:-1px}
.gp.on{border-color:var(--pop)}.gp.needs .gph{animation:gpulse 1.6s ease-in-out infinite}.gp.ended .gph{color:var(--warn)}
@keyframes gpulse{0%,100%{background:var(--card)}50%{background:var(--warn-bg,rgba(250,204,21,.18))}}
.gph{display:flex;align-items:center;gap:8px;height:26px;padding:0 8px;background:var(--card);font:12px var(--mono);color:var(--mut);cursor:default;user-select:none;flex-shrink:0}
.gph b{color:var(--fg);font-weight:600}.gph .gsp{flex:1}.gph button{min-height:0;height:20px;padding:0 6px;background:transparent;color:var(--mut);border:1px solid transparent;border-radius:4px;font:12px var(--mono);cursor:pointer}.gph button:hover{border-color:var(--bd);color:var(--fg)}
.gfr{flex:1;width:100%;border:0;background:#2b2b2b;min-height:0}
#grid.drag iframe{pointer-events:none}
.gpark{display:flex;align-items:center;justify-content:center;color:var(--mut);font:13px var(--mono)}
.gempty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--mut);font:14px var(--sans)}
[data-view=grid-phone]{padding:24px 8px;color:var(--mut);font:15px var(--sans)}
@media(prefers-reduced-motion:reduce){.gp.needs .gph{animation:none;background:var(--warn-bg,rgba(250,204,21,.18))}}
`;
