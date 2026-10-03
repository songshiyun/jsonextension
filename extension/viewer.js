import { JSONWorker } from './worker-client.js';
import { JSONTree } from './tree.js';
import { extractWithLLM } from './core/llm.js';
import { normalizeSettings, permissionFor } from './core/settings.js';
import { byteLength, checkSize, MAX_AI_BYTES, MAX_LOCAL_BYTES } from './core/limits.js';

const $ = id => document.getElementById(id);
const source = $('source');
const worker = new JSONWorker();
const state = { revision: 0, validSource: null, results: [], activeResult: -1, original: '', busy: false, settings: {}, controller: null };
let validationTimer;
let toastTimer;
let searchTimer;
const tree = new JSONTree($('tree'), selected => {
  $('path').textContent = selected.path;
  $('path').title = selected.path;
  if (selected.highlight && state.validSource === source.value) source.setSelectionRange(selected.start, selected.end);
});

function notice(message = '', kind = '') {
  $('notice').textContent = message;
  $('notice').className = `notice ${kind}`;
  $('notice').hidden = !message;
}
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2200);
}
function displaySize(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`; }
function updateControls() {
  const valid = state.validSource === source.value && Boolean(source.value.trim());
  for (const id of ['copy', 'download', 'copyPath', 'expand', 'collapse']) $(id).disabled = !valid || state.busy;
  for (const id of ['format', 'minify', 'clear', 'ai', 'sample', 'resultSelect', 'original']) $(id).disabled = state.busy;
  source.readOnly = state.busy;
  $('cancel').hidden = !state.busy;
  $('ai').hidden = state.busy;
  $('sourceEmpty').hidden = Boolean(source.value);
  $('sourceSize').textContent = displaySize(byteLength(source.value));
  document.querySelector('.tree-panel').classList.toggle('stale', !valid && tree.records.length > 0);
}
function recordEdits() {
  if (state.activeResult >= 0) state.results[state.activeResult].edited = source.value;
}

async function validate() {
  clearTimeout(validationTimer);
  const revision = ++state.revision;
  const text = source.value;
  state.validSource = null;
  updateControls();
  if (!text.trim()) {
    $('editorStatus').textContent = '等待输入';
    $('editorStatus').className = '';
    $('documentStats').textContent = 'JSON 标准格式 · 本地最多 5 MB';
    return;
  }
  $('editorStatus').textContent = '正在解析…';
  try {
    const document = await worker.run('parse', text);
    if (revision !== state.revision || text !== source.value) return;
    state.validSource = text;
    tree.setDocument(text, document);
    $('editorStatus').textContent = '● 有效 JSON';
    $('editorStatus').className = 'valid';
    $('documentStats').textContent = `${document.nodeCount.toLocaleString()} 个节点 · ${document.duplicates.length ? `${document.duplicates.length} 个重复字段已保留 · 路径可能相同` : '原始字段与数值已保留'}`;
    $('searchCount').textContent = tree.query ? `${tree.matches.size} 项` : '';
  } catch (error) {
    if (revision !== state.revision || text !== source.value) return;
    $('editorStatus').textContent = error.message;
    $('editorStatus').title = $('editorStatus').textContent;
    $('editorStatus').className = 'invalid';
    $('documentStats').textContent = tree.records.length ? '编辑内容无效 · 右侧保留上一次有效结构' : '文本尚不是标准 JSON · 可使用 AI 提取';
  }
  updateControls();
}

function editChanged() {
  state.revision++;
  state.validSource = null;
  recordEdits();
  updateControls();
  clearTimeout(validationTimer);
  validationTimer = setTimeout(validate, 220);
}

async function transform(type) {
  const text = source.value;
  if (!text.trim()) { notice('请先粘贴 JSON，或载入示例。'); return; }
  try {
    const output = await worker.run(type, text);
    if (byteLength(output) > MAX_LOCAL_BYTES) throw new Error('缩进后的内容超过 5 MB，已保留原文。可以继续查看结构或使用压缩。');
    if (source.value !== text) return;
    source.value = output;
    recordEdits();
    notice();
    await validate();
  } catch (error) {
    if (source.value !== text) return;
    notice(error.message, 'error');
    // Valid compact JSON must still load when adding indentation exceeds limits.
    await validate();
    if (Number.isInteger(error.position)) { source.focus(); source.setSelectionRange(error.position, error.position + 1); }
  }
}

async function showResult(index) {
  recordEdits();
  state.activeResult = index;
  $('resultSelect').value = String(index);
  source.value = index < 0 ? state.original : (state.results[index].edited ?? state.results[index].raw);
  if (index >= 0 && state.results[index].edited === undefined) {
    const captured = source.value;
    let formatted = captured;
    try {
      const pretty = await worker.run('format', captured);
      checkSize(pretty);
      formatted = pretty;
    } catch { /* Keep valid raw input available when indentation would be too large. */ }
    if (state.activeResult !== index || source.value !== captured) return;
    source.value = formatted;
    state.results[index].edited = formatted;
  }
  await validate();
}

function renderResults() {
  const options = [new Option('原始文本', '-1')];
  state.results.forEach((result, index) => options.push(new Option(`${String(index + 1).padStart(2, '0')} · ${result.raw.trim().startsWith('[') ? '数组' : '对象'} · ${displaySize(byteLength(result.raw))}${result.decoded ? ' · 已还原转义' : ''}`, String(index))));
  $('resultSelect').replaceChildren(...options);
  $('resultsBar').hidden = !state.results.length;
}

async function requestAI(automatic = false) {
  if (state.busy) return;
  const text = source.value;
  const input = text;
  let settings;
  let permission;
  try {
    checkSize(input, MAX_AI_BYTES);
    if (!input.trim()) throw new Error('请先输入或选中要识别的文字。');
    settings = normalizeSettings(state.settings);
    // Request before the first await so a button click retains the user gesture.
    permission = automatic
      ? chrome.permissions.contains({ origins: [permissionFor(settings)] })
      : chrome.permissions.request({ origins: [permissionFor(settings)] });
  } catch (error) { notice(`${error.message}${!state.settings.model ? ' 点击右上角「接口设置」完成配置后重试。' : ''}`, 'error'); return; }
  try {
    if (!await permission) { notice('需要接口网站访问授权。请点击「接口设置」重新保存，或点击「AI 提取 JSON」授权。', 'error'); return; }
  } catch { notice('无法申请接口网站权限，请在接口设置中重新保存配置。', 'error'); return; }
  if (state.busy) return;
  if (source.value !== text) { notice('授权期间输入已改变，请重新点击 AI 提取。'); return; }
  state.busy = true;
  state.controller = new AbortController();
  updateControls();
  notice('正在提取 JSON… 只发送本次输入的文字，结果会与原文核对。', 'busy');
  try {
    const results = await extractWithLLM(input, settings, {
      signal: state.controller.signal,
      verifyContent: (content, original) => worker.run('verify', original, content),
    });
    state.original = text;
    state.results = results;
    state.activeResult = -1;
    renderResults();
    await showResult(0);
    notice(`已识别 ${results.length} 个 JSON，全部与原文核对通过。可切换查看或编辑。`);
  } catch (error) { notice(error.message, 'error'); }
  finally { state.busy = false; state.controller = null; updateControls(); }
}

source.addEventListener('input', editChanged);
source.addEventListener('keydown', event => {
  if (event.key === 'Tab' && !source.readOnly) {
    event.preventDefault();
    source.setRangeText('  ', source.selectionStart, source.selectionEnd, 'end');
    editChanged();
  }
});
$('format').addEventListener('click', () => void transform('format'));
$('minify').addEventListener('click', () => void transform('minify'));
$('ai').addEventListener('click', () => void requestAI());
$('cancel').addEventListener('click', () => state.controller?.abort());
$('settings').addEventListener('click', () => { void chrome.runtime.sendMessage({ type: 'open-settings' }); });
$('openStandalone').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'open-editor', text: source.value });
  if (!response.ok) notice(response.error, 'error');
});
$('resultSelect').addEventListener('change', event => void showResult(Number(event.target.value)));
$('original').addEventListener('click', () => void showResult(-1));
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(await worker.run('format', source.value)); toast('已复制格式化 JSON'); }
  catch { notice('复制失败，请手动选中文本复制。', 'error'); }
});
$('copyPath').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('path').textContent); toast('已复制路径'); }
  catch { notice('复制路径失败，请手动复制下方路径。', 'error'); }
});
$('download').addEventListener('click', async () => {
  try {
    const text = await worker.run('format', source.value);
    const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'json-lens.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notice(error.message, 'error'); }
});
$('expand').addEventListener('click', () => tree.expandAll());
$('collapse').addEventListener('click', () => tree.collapseAll());
$('search').addEventListener('input', event => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const count = tree.search(event.target.value);
    $('searchCount').textContent = event.target.value.trim() ? `${count} 项` : '';
  }, 120);
});
$('clear').addEventListener('click', () => {
  state.results = []; state.activeResult = -1; state.original = '';
  source.value = ''; renderResults(); notice();
  tree.records = []; tree.render(); $('path').textContent = '$';
  void validate(); source.focus();
});
$('sample').addEventListener('click', async () => {
  source.value = '{"project":"JSON Lens","status":"ready","request_id":9007199254740993,"features":["结构化展示","无损格式化","AI 提取"],"response":{"code":200,"data":{"name":"示例用户","active":true,"tags":["developer","curious"]}},"optional":null}';
  await transform('format');
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !state.busy) { event.preventDefault(); void transform('format'); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('search').focus(); }
  if (event.key === 'Escape' && state.busy) state.controller.abort();
});
window.addEventListener('pagehide', () => { state.controller?.abort(); worker.close(); });

async function initialize() {
  if (!globalThis.chrome?.runtime?.id) { notice('请在 Chrome 扩展中打开此页面。安装说明见项目 README。', 'error'); return; }
  const params = new URLSearchParams(location.search);
  const embedded = window.self !== window.top;
  if (embedded) document.body.classList.add('embedded');
  const settings = await chrome.storage.local.get('settings');
  state.settings = settings.settings || {};
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) state.settings = changes.settings.newValue || {};
  });
  let payload;
  if (params.has('token')) {
    const response = await chrome.runtime.sendMessage({ type: 'take-source', token: params.get('token') });
    if (response.ok) payload = response; else notice(response.error, 'error');
    // Consume the one-time token; never keep source text in URLs or history.
    history.replaceState(null, '', embedded ? 'viewer.html?embedded=1' : 'viewer.html');
  }
  if (embedded && !payload?.page) {
    document.body.replaceChildren(Object.assign(document.createElement('p'), { textContent: '请通过 JSON 页面或插件按钮打开 JSON Lens。' }));
    worker.close();
    return;
  }
  if (params.has('error')) notice(params.get('error'), 'error');
  if (payload) {
    source.value = payload.text;
    state.original = payload.text;
    $('openStandalone').hidden = !embedded;
    $('subtitle').textContent = payload.page ? '当前页面的 JSON 已就绪，可以直接查看与编辑。' : '选中的文字已带入，原文仅保留在当前页面。';
    if (payload.mode === 'ai') { updateControls(); await requestAI(true); }
    else await transform('format');
  }
  updateControls();
}
initialize().catch(error => notice(`初始化失败：${error.message}`, 'error'));
