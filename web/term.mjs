// term.mjs — the links into /term that History, Session and Device draw. Nothing here touches the document at load.

/** The terminal document's URL; every render mints a fresh 8-hex tab id, the key web-term.sh uses to find this browser tab's tmux client. */
export const termHref = (kind, name) => `/term/?arg=${kind}&arg=${encodeURIComponent(name)}&arg=${[...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('')}&v=3`;
/** a named window per session, in a desktop BROWSER only: the installed app has no second window, and a touch device has nowhere to put one */
export const namedWindows = () => matchMedia('(display-mode: browser)').matches && innerWidth >= 700 && matchMedia('(pointer:fine)').matches;
