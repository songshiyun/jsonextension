import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJSON, formatJSON, minifyJSON, MAX_LOCAL_BYTES, MAX_AI_BYTES } from '../extension/core/json.js';

test('parses value spans without converting numbers or reordering object keys', () => {
  const source = '{"10":9007199254740993,"2":1e400,"10":-0}';
  const parsed = parseJSON(source);
  assert.deepEqual(parsed, {
    root: {
      type: 'object', start: 0, end: source.length,
      children: [
        { type: 'number', start: 6, end: 22, key: '10', keyRaw: '"10"', keyStart: 1, keyEnd: 5 },
        { type: 'number', start: 27, end: 32, key: '2', keyRaw: '"2"', keyStart: 23, keyEnd: 26 },
        { type: 'number', start: 38, end: 40, key: '10', keyRaw: '"10"', keyStart: 33, keyEnd: 37 },
      ],
    },
    nodeCount: 4,
    duplicates: [{ key: '10', start: 33 }],
  });
});

test('accepts every JSON value at the top level and skips only JSON whitespace', () => {
  for (const [literal, type] of [
    ['"text"', 'string'], ['9007199254740993', 'number'], ['1e400', 'number'],
    ['-0', 'number'], ['true', 'boolean'], ['false', 'boolean'], ['null', 'null'],
    ['[]', 'array'], ['{}', 'object'],
  ]) {
    const source = ` \t\r\n${literal}\r\n`;
    const parsed = parseJSON(source);
    assert.equal(parsed?.root?.type, type, literal);
    assert.equal(source.slice(parsed.root.start, parsed.root.end), literal);
    assert.equal(parsed.nodeCount, 1);
  }
});

test('preserves array order, nested values, key escapes, and delimiter text in strings', () => {
  const source = String.raw`{"\u0061":["}] [{ \"quoted\"",{"a":false}],"a":null,"__proto__":true}`;
  const parsed = parseJSON(source);
  assert.equal(parsed?.root?.type, 'object');
  assert.deepEqual(parsed.root.children.map(node => node.key), ['a', 'a', '__proto__']);
  assert.equal(parsed.root.children[0].keyRaw, String.raw`"\u0061"`);
  assert.equal(parsed.root.children[0].children[0].type, 'string');
  assert.equal(parsed.root.children[0].children[1].children[0].key, 'a');
  assert.equal(parsed.nodeCount, 7);
  assert.deepEqual(parsed.duplicates, [{ key: 'a', start: source.indexOf('"a":null') }]);
});

test('reports duplicates per object without treating nested same-name keys as duplicates', () => {
  const parsed = parseJSON('{"x":{"x":1},"y":{"x":2,"x":3}}');
  assert.equal(parsed?.duplicates?.length, 1);
  assert.equal(parsed.duplicates[0].key, 'x');
});

test('rejects nonstandard, incomplete, and trailing JSON syntax', () => {
  const invalid = [
    '', ' ', '+1', '01', '-01', '1.', '.1', '1e', '1e+', 'NaN', 'Infinity',
    'undefined', 'True', 'NULL', '\uFEFF{}', '\u00a0{}', '// hi\n{}',
    '{a:1}', "{'a':1}", '{"a":}', '{"a" 1}', '{"a":1,}', '[1,]', '[,1]',
    '{}{}', 'true false', '"text', '"a\ntext"', '"\u0000"',
    String.raw`"\x20"`, String.raw`"\u12xz"`, String.raw`"\u123"`, '"ends\\',
    '[1 2]', '{"a":1 "b":2}', '[}', '{]', '[[', '{"a": [1,2]',
  ];
  for (const source of invalid) {
    assert.throws(() => parseJSON(source), error => {
      assert.ok(error instanceof SyntaxError, source);
      assert.equal(typeof error.position, 'number', source);
      assert.ok(error.line >= 1 && error.column >= 1, source);
      return true;
    }, source);
  }
});

test('reports an actionable one-based line and column and zero-based position', () => {
  const source = '{\r\n  "a": 1,\r\n  "b": ]\r\n}';
  assert.throws(() => parseJSON(source), error => {
    assert.equal(error.position, source.indexOf(']'));
    assert.equal(error.line, 3);
    assert.equal(error.column, 8);
    assert.match(error.message, /第 3 行.*第 8 列/);
    return true;
  });
});

test('allows 256 container levels and rejects the next level without overflowing the stack', () => {
  const supported = '['.repeat(256) + '0' + ']'.repeat(256);
  assert.equal(parseJSON(supported)?.nodeCount, 257);
  const tooDeep = '['.repeat(257) + '0' + ']'.repeat(257);
  assert.throws(() => parseJSON(tooDeep), error => {
    assert.ok(error instanceof SyntaxError);
    assert.match(error.message, /256/);
    assert.equal(error.position, 256);
    return true;
  });
});

test('rejects non-string input with a clear type error', () => {
  for (const value of [null, undefined, 1, {}, []]) {
    assert.throws(() => parseJSON(value), TypeError);
  }
});

test('formats only insignificant whitespace while preserving all lexemes and duplicate key order', () => {
  const source = String.raw` { "10" : 9007199254740993, "2": 1e400, "10" : -0, "\u0061" : "\u4e2d\/\n", "nested" : [true, { "x": null }, []] } `;
  const expected = [
    '{',
    '  "10": 9007199254740993,',
    '  "2": 1e400,',
    '  "10": -0,',
    String.raw`  "\u0061": "\u4e2d\/\n",`,
    '  "nested": [',
    '    true,',
    '    {',
    '      "x": null',
    '    },',
    '    []',
    '  ]',
    '}',
  ].join('\n');
  assert.equal(formatJSON(source), expected);
  assert.equal(formatJSON(expected), expected);
  assert.equal(minifyJSON(source), String.raw`{"10":9007199254740993,"2":1e400,"10":-0,"\u0061":"\u4e2d\/\n","nested":[true,{"x":null},[]]}`);
});

test('formatting supports numeric or JSON-whitespace indentation and no terminal newline', () => {
  assert.equal(formatJSON('[1,2]', 4), '[\n    1,\n    2\n]');
  assert.equal(formatJSON('{"a":1}', '\t'), '{\n\t"a": 1\n}');
  assert.equal(formatJSON('[ 1, 2 ]', 0), '[1,2]');
  assert.equal(formatJSON('[ 1, 2 ]', ''), '[1,2]');
  assert.equal(formatJSON('  {}  '), '{}');
  assert.equal(formatJSON('  "text" \n'), '"text"');
  assert.equal(minifyJSON(' \r\n 1.2300E+09 \t'), '1.2300E+09');
});

test('formatting and minification reject invalid JSON and indentation', () => {
  assert.throws(() => formatJSON('[1,]'), SyntaxError);
  assert.throws(() => minifyJSON('{"a":01}'), SyntaxError);
  for (const indent of [-1, 11, 1.5, null, 'x', '           ']) {
    assert.throws(() => formatJSON('{}', indent), RangeError);
  }
});

test('exports the caller-enforced local and AI byte limits', () => {
  assert.equal(MAX_LOCAL_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_AI_BYTES, 100 * 1024);
});

test('rejects excessive formatting expansion while keeping compact output available', () => {
  const source = '['.repeat(256) + '0,'.repeat(45000) + '0' + ']'.repeat(256);
  assert.throws(() => formatJSON(source), error => {
    assert.ok(error instanceof RangeError);
    assert.equal(error.code, 'MAX_FORMATTED_SIZE');
    assert.match(error.message, /格式化.*字符.*压缩/);
    return true;
  });
  assert.equal(minifyJSON(source), source);
});
