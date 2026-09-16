import { html } from '../ui.mjs';
// Stub. Task 7 replaces this file with the streaming chat view. Export name and props
// ({name, runs}) are the contract with AgentDetail and must not change.
export function Chat({ name, runs }) {
  const chatable = (runs || []).some(r => r.state === 'done');
  return html`<p class="muted">${chatable
    ? `Chat with ${name} lands in the next task.`
    : "Chat resumes a finished run's session. Run this agent once first."}</p>`;
}
