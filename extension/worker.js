import { parseJSON, formatJSON, minifyJSON } from './core/json.js';
import { extractCandidates } from './core/extract.js';
import { checkSize } from './core/limits.js';
import { verifyModelContent } from './core/llm.js';

self.onmessage = ({ data: { id, type, source, content } }) => {
  try {
    checkSize(source);
    let result;
    if (type === 'parse') result = parseJSON(source);
    else if (type === 'format') result = formatJSON(source);
    else if (type === 'minify') result = minifyJSON(source);
    else if (type === 'extract') result = extractCandidates(source);
    else if (type === 'verify') result = verifyModelContent(content, source);
    else throw new Error('未知的 JSON 操作。');
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: { message: error.message, line: error.line, column: error.column, position: error.position } });
  }
};
