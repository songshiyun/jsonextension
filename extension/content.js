(() => {
  const mime = document.contentType.split(';')[0].trim();
  if (!/^(?:application|text)\/(?:[\w.+-]+\+)?json$/i.test(mime) || document.getElementById('json-lens-frame')) return;
  const pre = document.querySelector('body > pre') || document.querySelector('pre');
  if (!pre) return;
  const source = pre.textContent;
  if (!source?.trim() || new TextEncoder().encode(source).byteLength > 5 * 1024 * 1024) {
    if (source?.trim()) {
      const notice = document.createElement('p');
      notice.textContent = 'JSON Lens：此文档超过 5 MB，已保留原始页面。';
      document.body.prepend(notice);
    }
    return;
  }
  void chrome.runtime.sendMessage({ type: 'page-source', text: source, mime }).then(response => {
    if (!response?.ok) return;
    const frame = document.createElement('iframe');
    frame.id = 'json-lens-frame';
    frame.title = 'JSON Lens 结构化编辑器';
    frame.src = chrome.runtime.getURL(`viewer.html?embedded=1&token=${response.token}`);
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483646;background:#f6f7f9;color-scheme:light dark';
    const originalOverflow = document.documentElement.style.overflow;
    const restore = document.createElement('button');
    restore.id = 'json-lens-restore';
    restore.textContent = '查看原始页面';
    restore.title = '关闭 JSON Lens，恢复页面原始内容';
    restore.style.cssText = 'position:fixed;right:22px;bottom:12px;z-index:2147483647;border:1px solid #85909a;border-radius:6px;padding:5px 10px;background:Canvas;color:CanvasText;font:12px system-ui;cursor:pointer';
    restore.addEventListener('click', () => {
      frame.remove(); restore.remove(); document.documentElement.style.overflow = originalOverflow;
    });
    document.documentElement.style.overflow = 'hidden';
    document.body.append(frame, restore);
  }).catch(() => { /* Extension reload/navigation: leave the original document available. */ });
})();
