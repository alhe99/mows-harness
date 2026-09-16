import { h, render } from 'preact';
import htm from 'htm';
const html = htm.bind(h);
render(html`<p>app shell ok</p>`, document.getElementById('app'));
