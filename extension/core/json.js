export const MAX_LOCAL_BYTES = 5 * 1024 * 1024;
export const MAX_AI_BYTES = 100 * 1024;
export const MAX_JSON_DEPTH = 256;
export const MAX_FORMATTED_CHARS = 20 * 1024 * 1024;

const isDigit = character => character >= '0' && character <= '9';
const isHexDigit = character =>
  isDigit(character) || (character >= 'a' && character <= 'f') ||
  (character >= 'A' && character <= 'F');

/**
 * Parse strict JSON without materializing its numeric values. All offsets are
 * zero-based UTF-16 offsets into source; end offsets are exclusive. Object
 * children are the value nodes, in source order, with their key metadata added.
 * Duplicate entries point to the repeated key's opening quote.
 */
export function parseJSON(source) {
  if (typeof source !== 'string') throw new TypeError('JSON 输入必须是字符串。');
  let position = 0;
  let nodeCount = 0;
  const duplicates = [];

  function fail(message, at = position, code) {
    let line = 1;
    let column = 1;
    for (let index = 0; index < at; index += 1) {
      if (source[index] === '\r') {
        line += 1;
        column = 1;
        if (source[index + 1] === '\n' && index + 1 < at) index += 1;
      } else if (source[index] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    const error = new SyntaxError(`${message}（第 ${line} 行，第 ${column} 列）`);
    Object.assign(error, { position: at, line, column });
    if (code) error.code = code;
    throw error;
  }

  function whitespace() {
    while (position < source.length) {
      const character = source[position];
      if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n') break;
      position += 1;
    }
  }

  function stringEnd() {
    position += 1; // The caller has already checked the opening quote.
    while (position < source.length) {
      const character = source[position];
      if (character === '"') {
        position += 1;
        return;
      }
      if (source.charCodeAt(position) < 0x20) fail('字符串中存在未转义的控制字符');
      if (character === '\\') {
        position += 1;
        if (position >= source.length) fail('字符串转义不完整');
        const escape = source[position];
        if (escape === 'u') {
          for (let digit = 0; digit < 4; digit += 1) {
            position += 1;
            if (position >= source.length || !isHexDigit(source[position])) {
              fail('Unicode 转义必须包含 4 位十六进制数字');
            }
          }
        } else if (!'"\\/bfnrt'.includes(escape)) {
          fail('无效的字符串转义');
        }
      }
      position += 1;
    }
    fail('字符串缺少结束引号');
  }

  function numberEnd() {
    if (source[position] === '-') position += 1;
    if (source[position] === '0') {
      position += 1;
      if (isDigit(source[position])) fail('数字不能包含前导零');
    } else {
      if (!isDigit(source[position])) fail('数字缺少整数部分');
      while (isDigit(source[position])) position += 1;
    }
    if (source[position] === '.') {
      position += 1;
      if (!isDigit(source[position])) fail('小数点后必须有数字');
      while (isDigit(source[position])) position += 1;
    }
    if (source[position] === 'e' || source[position] === 'E') {
      position += 1;
      if (source[position] === '+' || source[position] === '-') position += 1;
      if (!isDigit(source[position])) fail('指数部分必须有数字');
      while (isDigit(source[position])) position += 1;
    }
  }

  function value(depth) {
    whitespace();
    const start = position;
    const character = source[position];
    let type;
    let children;

    if (character === '{' || character === '[') {
      if (depth >= MAX_JSON_DEPTH) {
        fail(`JSON 嵌套层级不能超过 ${MAX_JSON_DEPTH} 层`, position, 'MAX_JSON_DEPTH');
      }
      const object = character === '{';
      type = object ? 'object' : 'array';
      const closing = object ? '}' : ']';
      children = [];
      const keys = object ? new Set() : null;
      position += 1;
      whitespace();
      if (source[position] !== closing) {
        while (true) {
          let keyMetadata;
          if (object) {
            if (source[position] !== '"') fail('对象键必须是双引号字符串');
            const keyStart = position;
            stringEnd();
            const keyEnd = position;
            const keyRaw = source.slice(keyStart, keyEnd);
            // Only a validated string is decoded. JSON numbers never enter JSON.parse.
            const key = JSON.parse(keyRaw);
            keyMetadata = { key, keyRaw, keyStart, keyEnd };
            if (keys.has(key)) duplicates.push({ key, start: keyStart });
            keys.add(key);
            whitespace();
            if (source[position] !== ':') fail('对象键后缺少冒号');
            position += 1;
          }
          const child = value(depth + 1);
          if (keyMetadata) Object.assign(child, keyMetadata);
          children.push(child);
          whitespace();
          if (source[position] === closing) break;
          if (source[position] !== ',') fail(`此处应为逗号或 ${closing}`);
          position += 1;
          whitespace();
          if (source[position] === closing) fail('JSON 不允许末尾逗号');
        }
      }
      position += 1;
    } else if (character === '"') {
      type = 'string';
      stringEnd();
    } else if (character === '-' || isDigit(character)) {
      type = 'number';
      numberEnd();
    } else {
      const literal = character === 't' ? 'true' : character === 'f' ? 'false' : character === 'n' ? 'null' : null;
      if (!literal || !source.startsWith(literal, position)) {
        fail(position >= source.length ? 'JSON 不完整，缺少值' : '此处应为有效的 JSON 值');
      }
      type = literal === 'null' ? 'null' : 'boolean';
      position += literal.length;
    }

    nodeCount += 1;
    const node = { type, start, end: position };
    if (children) node.children = children;
    return node;
  }

  const root = value(0);
  whitespace();
  if (position !== source.length) fail('JSON 值之后存在多余内容');
  return { root, nodeCount, duplicates };
}

function render(source, root, indent) {
  const chunks = [];
  const indentation = [''];
  const pretty = indent.length > 0;
  let outputLength = 0;

  function append(...pieces) {
    for (const piece of pieces) outputLength += piece.length;
    // Check UTF-16 code units before collecting/joining expanded output. A small
    // dense input at depth 256 can otherwise create hundreds of MB of padding.
    if (outputLength > MAX_FORMATTED_CHARS) {
      const error = new RangeError(`格式化结果超过 ${MAX_FORMATTED_CHARS} 字符上限，请改用压缩或缩小输入。`);
      Object.assign(error, { code: 'MAX_FORMATTED_SIZE', limit: MAX_FORMATTED_CHARS });
      throw error;
    }
    chunks.push(...pieces);
  }

  function padding(depth) {
    while (indentation.length <= depth) indentation.push(indentation.at(-1) + indent);
    return indentation[depth];
  }

  function write(node, depth) {
    if (!node.children) {
      append(source.slice(node.start, node.end));
      return;
    }
    const object = node.type === 'object';
    append(object ? '{' : '[');
    node.children.forEach((child, index) => {
      if (index > 0) append(',');
      if (pretty) append('\n', padding(depth + 1));
      if (object) append(child.keyRaw, pretty ? ': ' : ':');
      write(child, depth + 1);
    });
    if (pretty && node.children.length > 0) append('\n', padding(depth));
    append(object ? '}' : ']');
  }

  write(root, 0);
  return chunks.join('');
}

/** Change only insignificant whitespace; never stringify materialized values. */
export function formatJSON(source, indent = 2) {
  let unit;
  if (Number.isInteger(indent) && indent >= 0 && indent <= 10) {
    unit = ' '.repeat(indent);
  } else if (typeof indent === 'string' && indent.length <= 10 && /^[ \t\r\n]*$/.test(indent)) {
    unit = indent;
  } else {
    throw new RangeError('缩进必须是 0 到 10 的整数，或至多 10 个 JSON 空白字符。');
  }
  return render(source, parseJSON(source).root, unit);
}

export function minifyJSON(source) {
  return render(source, parseJSON(source).root, '');
}
