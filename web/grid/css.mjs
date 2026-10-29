// css.mjs — the grid view's rules, adopted through document.adoptedStyleSheets (the shell CSP allows no inline <style>; CSSOM is not
// governed by it). The geometry is the Figma "Mission Control Dashboard Redesign" frame (mows-control, node 52-2, 2026-10-12); the
// colours are tokens.css (the frame's greys were a palette of their own, 2026-10-12). Panes are a CSS grid whose columns come from the state's fractions.
export const CSS = `
${/* full bleed: the shell's body is a 1024 px column with 48 px padding (tokens.css); here it is the viewport, edge to edge, header and footer gone */''}
body.gridv{max-width:none;padding:0;height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden}
body.gridv #app{flex:1;min-height:0;display:flex;flex-direction:column}
${/* the shell header's row goes to the panes: its nav lives at the right end of the tab strip (.gnav), its New Session is the strip's + */''}
body.gridv .hdr,body.gridv .termfab,body.gridv .tabs,body.gridv footer{display:none}
${/* sidebar (the card from before the 2026-10-12 facelift, kept at the owner's request) | 24 px gutter (the resize handle) | main */''}
#grid{display:grid;grid-template-columns:var(--gsb,256px) 24px minmax(0,1fr);flex:1;min-height:0;gap:0;padding:8px 0 0 8px;box-sizing:border-box}
#gsb{display:flex;flex-direction:column;min-width:0;overflow:hidden;margin-bottom:8px;background:var(--card);border:1px solid var(--bd);border-radius:12px}
#gsb .ghd{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--hair);font:600 11px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
#gsb .ghd button{min-height:0;padding:3px 8px;font:12px var(--mono);background:var(--card2);color:var(--fg2);border:1px solid var(--bd);border-radius:6px}
#gsb .glist{flex:1;overflow-y:auto;padding:4px 0}
#gsb details.gg>summary{cursor:pointer;list-style:none;padding:6px 12px;font:600 12px var(--mono);color:var(--mut)}
#gsb details.gg>summary::before{content:'▸ ';}#gsb details.gg[open]>summary::before{content:'▾ '}
#gsb .gr{display:grid;grid-template-columns:16px minmax(0,1fr) auto auto;grid-template-rows:auto auto;column-gap:8px;padding:7px 12px;cursor:pointer;border-left:2px solid transparent;user-select:none}
#gsb .gr:hover{background:var(--card2)}#gsb .gr[data-open="1"]{border-left-color:var(--ok)}
#gsb .gr .fli{grid-row:1/3;align-self:start;margin-top:2px}
#gsb .gr .lb{font:500 13px var(--sans);color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gsb .gr .grn{grid-column:2/5;display:flex;min-width:0}#gsb .gr .grn input{flex:1;min-width:0;min-height:0;height:20px;box-sizing:border-box;padding:0 6px;font:500 13px var(--sans);line-height:18px;background:var(--card2);color:var(--fg);border:1px solid var(--bd);border-radius:5px;outline-offset:-2px}
#gsb .gr .fst,#gsb .gr .fsnip{grid-column:2/5;font:11px var(--mono);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gsb .gr .gren{min-height:0;padding:1px 5px;font:12px var(--mono);background:transparent;color:var(--mut);border:1px solid transparent;border-radius:5px;opacity:0}#gsb .gr:hover .gren,#gsb .gr:focus-within .gren{opacity:1}#gsb .gr .gren:hover{border-color:var(--bd);color:var(--fg)}
#gsb .gr .gkill{display:inline-flex;align-items:center;min-height:0;padding:3px 5px;background:transparent;border:1px solid transparent;border-radius:5px;opacity:0;cursor:pointer}
#gsb .gr:hover .gkill,#gsb .gr:focus-within .gkill{opacity:1}#gsb .gr .gkill:hover{border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.1)}#gsb .gr .gkill path{stroke:var(--mut)}#gsb .gr .gkill:hover path{stroke:var(--bad)}
${/* service row: one line hanging off the agent above by an elbow drawn from the dot column (left 12 + 16/2); flat mode drops the elbow */''}
#gsb .gr.gsvc{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;position:relative;padding:2px 12px 6px 34px;min-height:22px}
#gsb .gr:has(+ .gsvc){position:relative}#gsb .gr:has(+ .gsvc)::after{content:'';position:absolute;left:19px;top:27px;bottom:0;border-left:1px solid var(--bd2)}
#gsb .gsvc:has(+ .gsvc)::after{top:50%}
#gsb .gsvc::before{content:'';position:absolute;left:19px;top:0;height:calc(50% - 2px);width:9px;border-left:1px solid var(--bd2);border-bottom:1px solid var(--bd2);border-bottom-left-radius:5px}
#gsb .glist>.gsvc{padding-left:12px}#gsb .glist>.gsvc::before,#gsb .glist>.gr:has(+ .gsvc)::after{display:none}
#gsb .gsvc .lb{font:11px var(--mono);color:var(--dim);flex-shrink:0}
#gsb .gwins{display:flex;gap:4px;min-width:0;flex:1;overflow:hidden;-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 14px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 14px),transparent)}#gsb .gwin{font:10.5px/16px var(--mono);color:var(--mut);padding:0 5px;border:1px solid var(--bd);border-radius:4px;white-space:nowrap}
#gsb .gr.gsvc{cursor:default}#gsb .gr.gsvc:hover{background:none}
#gsb .gwin[data-up="1"]::before{content:'';display:inline-block;width:5px;height:5px;margin:0 4px 1px 0;border-radius:50%;background:var(--ok);vertical-align:middle}#gsb .gwin[data-up="0"]{border-style:dashed;color:var(--dim)}
#gsb .gsvc[data-up="0"] .lb,#gsb .gsvc[data-up="0"] .gwins{opacity:.55}#gsb .gsst{font:11px var(--mono);color:var(--mut);flex-shrink:0}#gsb .gsst[data-close]{color:var(--warn)}#gsb .gsvc .gkill{margin-left:auto;padding:1px 4px}#gsb .gsvc .gkc{flex-basis:100%}
#gsb .gsvh{padding:10px 12px 4px;font:600 11px var(--mono);color:var(--dim);letter-spacing:.06em;text-transform:uppercase}
#gsb .gr .gkc{grid-column:2/5;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;margin-top:6px;cursor:default}#gsb .gr .gkq{flex-basis:100%;font:11px/1.4 var(--sans);color:var(--mut)}
#gsb .gr .gkc button{min-height:0;height:24px;padding:0 10px;border-radius:6px;font:500 11px var(--sans);cursor:pointer;border:1px solid var(--bd2);background:var(--card2);color:var(--fg2)}
#gsb .gr .gkc .gkyes{color:var(--bad)}#gsb .gr .gkc .gkyes:hover{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.35)}
.gdot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
#gh-sb,.gh{cursor:col-resize;background:transparent;touch-action:none}.gw .gh{grid-row:1/-1}.gh:hover,#grid.drag .gh{background:var(--pop)}
${/* the hidden sidebar and the grid's motion are in tokens.css (Grid motion and nav): this route sits at its 15 kB budget */''}
#gmain{display:flex;flex-direction:column;min-width:0;min-height:0}
${/* tab strip: 38 px, browser tabs: the tabs sit on the strip's bottom line (an inset shadow, so the focused tab's fill covers it) and the
   focused one, in the pane header's --card2 with a border and rounded top, joins the panes under it; the others are text with a hairline between */''}
#gtabs{display:flex;align-items:flex-end;gap:4px;height:38px;padding-left:8px;flex-shrink:0;box-shadow:inset 0 -1px var(--bd2)}
#gtabs .gts{display:flex;align-items:flex-end;height:100%;min-width:0;overflow-x:auto;scrollbar-width:none}#gtabs .gts::-webkit-scrollbar{display:none}
#gtabs .gt{position:relative;display:inline-flex;align-items:center;gap:8px;height:31px;box-sizing:border-box;padding:0 6px 0 14px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;color:var(--mut);font:500 12px var(--sans);cursor:pointer;user-select:none;white-space:nowrap;touch-action:none;flex-shrink:0}
#gtabs .gt.on{background:var(--card2);border-color:var(--bd2);color:var(--fg)}#gtabs .gt:not(.on):hover{color:var(--fg2)}#gtabs .gt.dragging{opacity:.5}
#gtabs .gt:not(.on)+.gt:not(.on)::before{content:'';position:absolute;left:-1px;top:9px;height:14px;border-left:1px solid var(--bd2)}
#gtabs .gt .gdot{background:var(--bd3)}#gtabs .gt .gdot[data-state=working]{background:var(--ok)}#gtabs .gt .gdot[data-state=needs-you],#gtabs .gt .gdot[data-state=paused]{background:var(--warn)}
#gtabs .gx{min-height:0;height:18px;width:18px;padding:0;border-radius:50%;background:transparent;border:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}#gtabs .gx:hover{background:var(--pop)}
#gtabs :is(.gnew,.gsbt){align-self:center;min-height:0;height:28px;width:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;background:0;border:0;border-radius:6px;cursor:pointer;flex-shrink:0}#gtabs :is(.gnew,.gsbt):hover{background:var(--card2)}
#gtabs .gsbt path{stroke:var(--mut)}#gtabs .gsbt:hover path{stroke:var(--fg)}
#gtabs .gx path,#gtabs .gnew path{stroke:var(--dimmer)}#gtabs .gx:hover path,#gtabs .gnew:hover path{stroke:var(--fg)}
#gnotice{font:11px/16.5px var(--mono);color:var(--warn);padding:0 16px;white-space:nowrap}
${/* the cockpit nav (.gnav) is styled in tokens.css (Grid motion and nav), for the budget */''}
.gw{flex:1;min-height:0;display:grid;grid-auto-rows:minmax(0,1fr);gap:0;overflow:hidden}
.gw[hidden]{display:none}
.gp{display:flex;flex-direction:column;min-width:0;min-height:0}
${/* the pane header (.gph) is styled in tokens.css (Grid chrome), for the budget */''}
.gfr{flex:1;width:100%;border:0;background:var(--bg);min-height:0}
#grid.drag iframe{pointer-events:none}
#grid.tabdrag .gw:not([hidden]),#grid.tabdrag .gempty{outline:2px dashed var(--mut);outline-offset:-3px;cursor:copy}#gsb .gr.dragging{opacity:.5}
#gsb .gdb{box-shadow:inset 0 2px 0 var(--ring)}#gsb .gda{box-shadow:inset 0 -2px 0 var(--ring)}
.gpark,.gempty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--mut);font:13px var(--mono)}
[data-view=grid-phone]{padding:24px 8px;color:var(--mut);font:15px var(--sans)}
`;
