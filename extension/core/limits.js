export const MAX_LOCAL_BYTES = 5 * 1024 * 1024;
export const MAX_AI_BYTES = 100 * 1024;
export const AI_TIMEOUT_MS = 180_000;
export const byteLength = (text) => new TextEncoder().encode(text).byteLength;

export function checkSize(text, maximum = MAX_LOCAL_BYTES) {
  if (typeof text !== 'string') throw new Error('请输入文本。');
  if (byteLength(text) > maximum) {
    throw new Error(maximum === MAX_AI_BYTES
      ? 'AI 输入超过 100 KB，请缩小选中范围。内容没有发送。'
      : '文本超过 5 MB，请缩小输入范围。');
  }
}
