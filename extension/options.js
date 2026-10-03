import { normalizeSettings, permissionFor } from './core/settings.js';
import { extractWithLLM } from './core/llm.js';
import { JSONWorker } from './worker-client.js';

const $ = id => document.getElementById(id);
let controller;
const worker = new JSONWorker();
function status(message, error = false) {
  $('settingsNotice').textContent = message;
  $('settingsNotice').hidden = !message;
  $('settingsNotice').className = `notice${error ? ' error' : ''}`;
}
function values() { return normalizeSettings({ baseUrl: $('baseUrl').value, apiKey: $('apiKey').value, model: $('model').value }); }
function render(settings = {}) {
  for (const id of ['baseUrl', 'apiKey', 'model']) $(id).value = settings[id] || '';
}
async function authorize(settings) {
  const granted = await chrome.permissions.request({ origins: [permissionFor(settings)] });
  if (!granted) throw new Error('未获得接口网站访问权限，配置没有保存。');
}
$('settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const settings = values();
    const authorization = authorize(settings);
    $('save').disabled = true;
    await authorization;
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.storage.local.set({ settings });
    status('配置已保存。返回编辑器即可使用 AI 提取。');
  } catch (error) { status(error.message, true); }
  finally { $('save').disabled = false; }
});
$('showKey').addEventListener('click', () => {
  const visible = $('apiKey').type === 'password';
  $('apiKey').type = visible ? 'text' : 'password';
  $('showKey').textContent = visible ? '隐藏' : '显示';
  $('showKey').setAttribute('aria-pressed', String(visible));
});
$('clearSettings').addEventListener('click', async () => {
  controller?.abort();
  await chrome.storage.local.remove('settings');
  render();
  status('本机配置已清除。');
});
$('test').addEventListener('click', async () => {
  if (controller) return;
  try {
    const settings = values();
    const authorization = authorize(settings);
    $('test').disabled = true;
    await authorization;
    controller = new AbortController();
    $('cancelTest').hidden = false;
    status('正在测试连接…');
    await extractWithLLM('{"connection":"ok"}', settings, {
      signal: controller.signal,
      verifyContent: (content, source) => worker.run('verify', source, content),
    });
    status('连接成功，模型已返回可验证的 JSON。请保存配置后使用。');
  } catch (error) { status(error.message, true); }
  finally { controller = null; $('test').disabled = false; $('cancelTest').hidden = true; }
});
$('cancelTest').addEventListener('click', () => controller?.abort());
window.addEventListener('pagehide', () => { controller?.abort(); worker.close(); });
chrome.storage.local.get('settings').then(({ settings }) => render(settings)).catch(() => status('读取配置失败，请重新加载扩展。', true));
