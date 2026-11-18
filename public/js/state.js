// DeepLine web — application state (same JSON shape as the Android app, so backups are interchangeable).
import { dbGet, dbSet, dbAllMedia, uid, readFileAsDataUrl, prepareImage, makeZip, readZip, dataUrlToBytes, bytesToDataUrl, mimeFromName, download, setMediaResolver } from './lib.js';

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));

export const S = { data: null, media: new Map(), busy: false, error: '', toastText: '' };

const DEFAULTS = {
  personas: [], posts: [], groups: [], theme: '#0A84FF', myName: '我', myBio: '', myAvatar: '', momentsCover: '', background: '',
  backgroundAlpha: 0.0, backgroundBlur: 0, glassUi: true, glassOpacity: 0.34, soundEnabled: true, deepThinkingEnabled: false,
  conversationSummaryEnabled: false, longMemoryEnabled: true, autoAiEnabled: false, aiMomentsEnabled: true, multiReplyEnabled: false, multiReplyCount: 2,
  memoryLimit: 200, bubbleColor: '#FFFFFF', myBubbleColor: '#0A84FF', chatTheme: '自动', appTitle: '信息', inputHint: 'iMessage信息',
  aiTextColor: '#263247', myTextColor: '#243047', directMode: false, bubbleBackground: '',
};

export async function loadState() {
  const stored = await dbGet('kv', 'data');
  S.data = Object.assign({}, structuredClone(DEFAULTS), stored || {});
  for (const k of ['personas', 'posts', 'groups']) if (!Array.isArray(S.data[k])) S.data[k] = [];
  S.media = await dbAllMedia();
  setMediaResolver(mediaUrl);
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => dbSet('kv', 'data', JSON.parse(JSON.stringify(S.data))).catch(() => toast('保存失败：浏览器存储空间不足？')), 350);
}
export function flushSave() { clearTimeout(saveTimer); return dbSet('kv', 'data', JSON.parse(JSON.stringify(S.data))); }
/** Call after any change to the data object: persists and tells the UI to refresh. */
export function touch() { save(); emit('data'); }

export const get = (k) => (S.data[k] === undefined ? DEFAULTS[k] : S.data[k]);
export function set(k, v) { S.data[k] = v; touch(); }
export const personas = () => S.data.personas;
export const groups = () => S.data.groups;
export const posts = () => S.data.posts;
export const findPersona = (id) => S.data.personas.find((p) => p.id === id) || null;
export const findGroup = (id) => S.data.groups.find((g) => g.id === id) || null;
export const findPost = (id) => S.data.posts.find((p) => p.id === id) || null;
export const sound = () => !!get('soundEnabled');

export function setBusy(b) { S.busy = b; emit('busy'); }
export function setError(e) { S.error = e || ''; emit('error'); }
export function toast(text) { S.toastText = text; emit('toast', text); }

// ───────────── media ─────────────
export async function addMediaFromFile(file, maxEdge = 1280) {
  const dataUrl = await prepareImage(file, maxEdge);
  return addMediaDataUrl(dataUrl);
}
export async function addMediaDataUrl(dataUrl) {
  const id = uid();
  S.media.set(id, dataUrl);
  await dbSet('media', id, dataUrl);
  return 'media:' + id;
}
export function mediaUrl(ref) {
  if (!ref) return '';
  if (ref.startsWith('media:')) return S.media.get(ref.slice(6)) || '';
  if (ref.startsWith('data:') || ref.startsWith('http')) return ref;
  return '';
}

// ───────────── backup (compatible with the Android BackupStore ZIP: data.json + media/…) ─────────────
const MEDIA_RE = /media:[A-Za-z0-9-]+/g;
const ZIPMEDIA_RE = /zipmedia:[A-Za-z0-9._-]+/g;
function rewriteStrings(node, fn) {
  if (Array.isArray(node)) node.forEach((v, i) => { if (typeof v === 'string') node[i] = fn(v); else if (v && typeof v === 'object') rewriteStrings(v, fn); });
  else if (node && typeof node === 'object') for (const k of Object.keys(node)) { const v = node[k]; if (typeof v === 'string') node[k] = fn(v); else if (v && typeof v === 'object') rewriteStrings(v, fn); }
}
export async function exportBackup() {
  const copy = JSON.parse(JSON.stringify(S.data));
  const files = [], seen = new Map();
  rewriteStrings(copy, (s) => s.replace(MEDIA_RE, (m) => {
    if (seen.has(m)) return seen.get(m);
    const url = S.media.get(m.slice(6));
    const parsed = url && dataUrlToBytes(url);
    if (!parsed) return m;
    const ext = { 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[parsed.mime] || '.jpg';
    const name = uid() + ext;
    files.push({ name: 'media/' + name, data: parsed.bytes });
    seen.set(m, 'zipmedia:' + name);
    return 'zipmedia:' + name;
  }));
  const enc = new TextEncoder();
  const all = [{ name: 'data.json', data: enc.encode(JSON.stringify(copy, null, 2)) }, ...files,
    { name: 'README.txt', data: enc.encode('DeepLine local backup. Includes AI API keys and chat history. Keep this file private.') }];
  download(makeZip(all), 'DeepLine-backup.zip');
}
/** mode: 'full' replaces everything; 'personas' adds the AI characters from the backup. */
export async function importBackup(file, mode) {
  const entries = await readZip(await file.arrayBuffer());
  const dj = entries.get('data.json');
  if (!dj) throw new Error('ZIP 中没有 data.json，不是 DeepLine 备份文件');
  const json = JSON.parse(new TextDecoder().decode(dj));
  const mediaMap = new Map();
  for (const [name, bytes] of entries) {
    if (!name.startsWith('media/')) continue;
    const base = name.slice(6).split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_');
    const ref = await addMediaDataUrl(bytesToDataUrl(bytes, mimeFromName(base)));
    mediaMap.set(base, ref);
  }
  rewriteStrings(json, (s) => s.replace(ZIPMEDIA_RE, (m) => mediaMap.get(m.slice(9).replace(/[^A-Za-z0-9._-]/g, '_')) || m));
  if (mode === 'full') {
    S.data = Object.assign({}, structuredClone(DEFAULTS), json);
    for (const k of ['personas', 'posts', 'groups']) if (!Array.isArray(S.data[k])) S.data[k] = [];
    touch();
    return `已恢复完整备份：${S.data.personas.length} 个 AI。`;
  }
  const incoming = Array.isArray(json.personas) ? json.personas : [];
  let added = 0;
  for (const p of incoming) {
    const clone = JSON.parse(JSON.stringify(p));
    clone.id = String(Date.now() + added);
    S.data.personas.push(clone); added++;
  }
  touch();
  return added ? `已导入 ${added} 个 AI。` : '备份里没有可导入的 AI。';
}

/** Import a DeepSeek V3 export ZIP additively; original session/message metadata is retained. */
export async function importDeepSeekZip(file) {
  const entries = await readZip(await file.arrayBuffer());
  const names = [...entries.keys()].filter((n) => /^chat_sessions\/[^/]+\.json$/i.test(n));
  if (!names.length) throw new Error('ZIP 中没有 chat_sessions/*.json，无法识别 DeepSeek 导出文件');
  let added = 0, skipped = 0, importedMessages = 0;
  for (const name of names) {
    let session; try { session = JSON.parse(new TextDecoder().decode(entries.get(name))); } catch { continue; }
    if (!session || !Array.isArray(session.messages)) continue;
    if (S.data.personas.some((p) => p.sourceSessionId === String(session.id))) { skipped++; continue; }
    const msgs = session.messages.map((m) => {
      const fragments = Array.isArray(m.fragments) ? m.fragments : [];
      const getParts = (types) => fragments.filter((f) => types.includes(f.type)).map((f) => String(f.content || '')).filter(Boolean);
      const role = String(m.role || '').toUpperCase() === 'USER' ? 'user' : 'assistant';
      const primary = role === 'user' ? getParts(['REQUEST']) : getParts(['RESPONSE','TEMPLATE_RESPONSE']);
      const tools = getParts(['TOOL_SEARCH','TOOL_OPEN','CONTENT_RISK']);
      const content = [...primary, ...tools.map((x) => '[DeepSeek 记录] ' + x)].join('\n\n').trim();
      const time = Date.parse(m.inserted_at || session.inserted_at || '') || Date.now();
      const out = { id: 'ds-' + session.id + '-' + m.id, sourceId: m.id, parentId: m.parent_id ?? null, time, role, content, sourceStatus: m.status || '', sourceTokenUsage: Number(m.accumulated_token_usage || 0), sourceFragments: fragments };
      const think = getParts(['THINK']); if (think.length) out.reasoning = think.join('\n\n');
      return out;
    }).filter((m) => m.content || m.reasoning || m.sourceFragments.length);
    const title = String(session.title || 'DeepSeek 导入会话').trim().slice(0,100);
    S.data.personas.push({ id: uid(), name: title || 'DeepSeek 导入会话', bio: '从 DeepSeek 导出的历史会话', persona: '这是从 DeepSeek 导入的历史聊天。请在设置 API 后继续对话，并尊重已有聊天上下文。', provider: 'DeepSeek', model: 'deepseek-chat', apiKey: '', useFreeApi: false, sourceSessionId: String(session.id), sourceUpdatedAt: session.updated_at || '', sourceInsertedAt: session.inserted_at || '', sourceCurrentMessageId: session.current_message_id ?? null, sourcePinned: !!session.pinned, messages: msgs });
    added++; importedMessages += msgs.length;
  }
  if (!added) throw new Error(skipped ? `这些会话已导入过（跳过 ${skipped} 个），没有新增内容` : '没有找到可导入的有效会话');
  touch();
  return `已追加导入 ${added} 个会话、${importedMessages} 条消息；重复跳过 ${skipped} 个。原有数据未覆盖。`;
}

export { readFileAsDataUrl };
