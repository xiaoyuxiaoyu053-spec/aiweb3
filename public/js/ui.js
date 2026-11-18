// DeepLine web — entry point
import { loadState, flushSave, get } from './state.js';
import { initSfx, unlockAudio } from './lib.js';
import { persistRequest } from './lib.js';
import { initRouter, mount } from './core.js';
import './home.js';
import './chat.js';
import './forms.js';
import { syncAutoPost } from './logic.js';

async function boot() {
  await loadState();
  try { const r = await fetch('/api/announcement', { cache: 'no-store' }); const a = await r.json(); if (a.enabled && (a.title || a.body)) { const n = document.createElement('aside'); n.id = 'deepline-announcement'; n.innerHTML = `<b></b><span></span><button type="button" aria-label="关闭公告">×</button>`; n.querySelector('b').textContent = a.title || '网站公告'; n.querySelector('span').textContent = a.body || ''; n.querySelector('button').onclick = () => n.remove(); document.body.appendChild(n); } } catch {}
  initRouter();
  mount();
  syncAutoPost();
  persistRequest();
  initSfx();
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('pagehide', () => { flushSave(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
}
boot().catch((e) => { document.body.textContent = '启动失败：' + (e && e.message); console.error(e); });
