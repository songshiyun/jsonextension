import { parseJSON } from './json.js';

export const MAX_DECODE_LAYERS = 3;
const INVALID_ENCODING = Symbol('invalid JSON string content');
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

// This locates a lexical boundary only. JSON.parse subsequently validates the
// complete string token, so invalid escapes are never repaired by this scanner.
function quotedEnd(text, start) {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === '"') return index + 1;
  }
  return -1;
}

// A streaming JSON-string decoder lets all supported interpretations advance
// together. One bad interpretation cannot repeatedly rescan an entire suffix
// before a short, valid escaped fragment is found by another interpretation.
function characterReader(text, start, layers) {
  let position = start;
  let next = () => position < text.length ? text[position++] : null;
  for (let layer = 0; layer < layers; layer += 1) {
    const previous = next;
    next = () => {
      const character = previous();
      if (character === null) return null;
      if (character === '"' || character.charCodeAt(0) < 0x20) throw INVALID_ENCODING;
      if (character !== '\\') return character;
      const escape = previous();
      if (escape === 'u') {
        let digits = '';
        for (let index = 0; index < 4; index += 1) {
          const digit = previous();
          if (digit === null || !/^[0-9a-fA-F]$/.test(digit)) throw INVALID_ENCODING;
          digits += digit;
        }
        return String.fromCharCode(Number.parseInt(digits, 16));
      }
      if (!Object.hasOwn(ESCAPES, escape)) throw INVALID_ENCODING;
      return ESCAPES[escape];
    };
  }
  return { next, get position() { return position; } };
}

function readContainer(text, start, availableLayers) {
  const states = Array.from({ length: availableLayers + 1 }, (_, layers) => ({
    layers,
    reader: characterReader(text, start, layers),
    closing: [],
    quoted: false,
    escaped: false,
    viable: true,
    active: true,
  }));
  let active = states.length;
  let furthest = start;

  function stop(state) {
    state.active = false;
    active -= 1;
  }

  while (active > 0) {
    for (const state of states) {
      if (!state.active) continue;
      let character;
      try {
        character = state.reader.next();
      } catch (error) {
        if (error !== INVALID_ENCODING) throw error;
        furthest = Math.max(furthest, state.reader.position);
        stop(state);
        continue;
      }
      const end = state.reader.position;
      furthest = Math.max(furthest, end);
      if (character === null) {
        stop(state);
        continue;
      }
      if (state.quoted) {
        if (state.escaped) state.escaped = false;
        else if (character === '\\') state.escaped = true;
        else if (character === '"') state.quoted = false;
      } else if (character === '"') {
        state.quoted = true;
      } else if (character === '\\') {
        // JSON never has a backslash outside strings. Keep scanning this
        // interpretation for containment, but prefer a decoded boundary if it
        // becomes available, even when that bounded JSON later fails parsing.
        state.viable = false;
      } else if (character === '{' || character === '[') {
        state.closing.push(character === '{' ? '}' : ']');
      } else if (character === '}' || character === ']') {
        // A mismatched closer must not terminate the outer region and expose a
        // child of that invalid region as a supposedly independent candidate.
        if (state.closing.at(-1) !== character) continue;
        state.closing.pop();
        if (state.closing.length > 0) continue;
        stop(state);
        let raw = text.slice(start, end);
        try {
          for (let layer = 0; layer < state.layers; layer += 1) {
            // These quotes establish a JSON string boundary, not JSON syntax
            // repair. The complete content must pass normal string validation.
            raw = JSON.parse(`"${raw}"`);
          }
          parseJSON(raw);
          return { raw, end, layers: state.layers };
        } catch (error) {
          if (!(error instanceof SyntaxError) || error.code === 'MAX_JSON_DEPTH') throw error;
          if (state.viable) return { raw: null, end, layers: state.layers };
        }
      }
    }
  }
  return { raw: null, end: furthest, layers: 0 };
}

/**
 * Find complete outermost objects/arrays, without repairing invalid input.
 *
 * start/end are zero-based, end-exclusive UTF-16 offsets into the ORIGINAL text.
 * For decoded=false, raw === text.slice(start, end). For decoded=true, they
 * identify the original bare escaped fragment, or the outermost enclosing JSON
 * string token (including quotes) when there is one. raw is the exact candidate
 * text after at most three valid string decodes in total. Several candidates
 * decoded from one enclosing string can share this original span.
 *
 * Scanning is bounded by the three-layer decode limit. A
 * truncated/invalid outer container never falls back to one of its children.
 * Disjoint identical occurrences remain distinct; there is no candidate cap.
 */
export function extractCandidates(text) {
  if (typeof text !== 'string') throw new TypeError('待提取内容必须是字符串。');
  const candidates = [];

  function scan(source, decodeLayers, originalSpan) {
    let position = 0;
    while (position < source.length) {
      const character = source[position];
      if (character === '{' || character === '[') {
        const { raw, end, layers } = readContainer(source, position, MAX_DECODE_LAYERS - decodeLayers);
        if (raw !== null) {
          candidates.push({
            id: `json-${candidates.length + 1}`,
            raw,
            start: originalSpan?.start ?? position,
            end: originalSpan?.end ?? end,
            decoded: originalSpan !== null || layers > 0,
          });
        }
        position = end;
      } else if (character === '"') {
        const end = quotedEnd(source, position);
        if (end === -1) break;
        if (decodeLayers < MAX_DECODE_LAYERS) {
          let decoded;
          try {
            // This slice starts and ends with quotes, so no number is decoded.
            decoded = JSON.parse(source.slice(position, end));
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
          if (typeof decoded === 'string') {
            scan(decoded, decodeLayers + 1, originalSpan ?? { start: position, end });
          }
        }
        position = end;
      } else {
        position += 1;
      }
    }
  }

  scan(text, 0, null);
  return candidates;
}
