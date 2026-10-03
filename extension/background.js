import { checkSize } from './core/limits.js';

const pending = new Map();
const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]);

function remember(payload, ownerTabId) {
  for (const [id, entry] of pending) if (Date.now() - entry.created > 60_000) pending.delete(id);
  const id = crypto.randomUUID();
  pending.set(id, { payload, ownerTabId, created: Date.now() });
  setTimeout(() => pending.delete(id), 60_000);
  return id;
}

export async function openSelection(info) {
  const mode = info.menuItemId === 'json-lens-ai' ? 'ai' : 'format';
  const text = info.selectionText || '';
  try {
    // The viewer checks the smaller AI limit and preserves editable source on failure.
    checkSize(text);
    const tab = await chrome.tabs.create({ url: 'about:blank' });
    const token = remember({ text, mode, page: false }, tab.id);
    await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL(`viewer.html?token=${token}`) });
  } catch (error) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?error=${encodeURIComponent(error.message)}`) });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await storageReady;
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'json-lens-format', title: '格式化 JSON', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'json-lens-ai', title: 'AI 提取 JSON', contexts: ['selection'] });
});
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') }));
chrome.contextMenus.onClicked.addListener(info => {
  if (['json-lens-format', 'json-lens-ai'].includes(info.menuItemId)) void openSelection(info);
});
chrome.tabs.onRemoved.addListener(tabId => {
  for (const [id, entry] of pending) if (entry.ownerTabId === tabId) pending.delete(id);
});

function isTrustedPage(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  const url = new URL(sender.url);
  return url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && ['/viewer.html', '/options.html'].includes(url.pathname);
}

async function handleMessage(message, sender) {
  await storageReady;
  if (!message || sender.id !== chrome.runtime.id) throw new Error('消息来源无效。');
  if (message.type === 'page-source') {
    if (!sender.tab?.id || sender.frameId !== 0 || !/^(https?:|file:)/.test(sender.url || '') ||
        !/^(?:application|text)\/(?:[\w.+-]+\+)?json$/i.test(message.mime || '')) {
      throw new Error('仅支持 JSON 文档。');
    }
    checkSize(message.text);
    return { token: remember({ text: message.text, mode: 'format', page: true }, sender.tab.id) };
  }
  if (!isTrustedPage(sender)) throw new Error('此操作仅允许在扩展页面中执行。');
  if (message.type === 'take-source') {
    const entry = pending.get(message.token);
    if (!entry || entry.ownerTabId !== sender.tab?.id || Date.now() - entry.created > 60_000) {
      throw new Error('这份临时内容已失效。请重新选择文字并打开，或在这里粘贴 JSON。');
    }
    pending.delete(message.token);
    return entry.payload;
  }
  if (message.type === 'open-settings') {
    await chrome.runtime.openOptionsPage();
    return {};
  }
  if (message.type === 'open-editor') {
    checkSize(message.text);
    const tab = await chrome.tabs.create({ url: 'about:blank' });
    const token = remember({ text: message.text, mode: 'format', page: false }, tab.id);
    await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL(`viewer.html?token=${token}`) });
    return {};
  }
  throw new Error('不支持的操作。');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(data => sendResponse({ ok: true, ...data }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
