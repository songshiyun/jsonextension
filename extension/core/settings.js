export const DEFAULT_SETTINGS = Object.freeze({ baseUrl: '', apiKey: '', model: '' });

export function normalizeSettings(input = {}) {
  const baseUrl = String(input.baseUrl ?? '').trim();
  const apiKey = String(input.apiKey ?? '').trim();
  const model = String(input.model ?? '').trim();
  if (!baseUrl) throw new Error('请填写接口 Base URL。');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('Base URL 不是有效的网址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 需为 HTTP(S) 地址，不含账号、查询参数或片段。');
  }
  if (!model) throw new Error('请填写模型名称。');
  if (model.length > 200 || apiKey.length > 4096 || baseUrl.length > 2048) throw new Error('接口配置过长。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { baseUrl: url.href.replace(/\/+$/, ''), apiKey, model };
}

export function endpointFor(settings) {
  const { baseUrl } = normalizeSettings(settings);
  return baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
}

export function permissionFor(settings) {
  const url = new URL(endpointFor(settings));
  // Chrome match patterns do not include port numbers.
  return `${url.protocol}//${url.hostname}/*`;
}
