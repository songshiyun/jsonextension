import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { extractCandidates } from '../extension/core/extract.js';

test('extracts all complete outermost objects and arrays from prose, logs, and fences', () => {
  const first = '{ "10":9007199254740993, "2":1e400, "10":-0, "child":{"x":1} }';
  const second = '[true, {"s":"text"}]';
  const text = `日志 [INFO]\n${first}\n\`\`\`json\n${second}\n\`\`\`\n结束`;
  assert.deepEqual(extractCandidates(text), [
    { id: 'json-1', raw: first, start: text.indexOf(first), end: text.indexOf(first) + first.length, decoded: false },
    { id: 'json-2', raw: second, start: text.indexOf(second), end: text.indexOf(second) + second.length, decoded: false },
  ]);
});

test('does not offer nested objects or arrays as separate candidates', () => {
  const text = '{"a":[{"b":1}],"c":{"d":2},"s":"{\\"inside\\":3}"}';
  const result = extractCandidates(text);
  assert.equal(result?.length, 1);
  assert.equal(result[0].raw, text);
});

test('retains separate occurrences of identical objects with stable source-order IDs', () => {
  const text = 'first {} second {} third []';
  const result = extractCandidates(text);
  assert.equal(result?.length, 3);
  assert.deepEqual(result.map(candidate => candidate.id), ['json-1', 'json-2', 'json-3']);
  assert.deepEqual(result.map(candidate => candidate.start), [6, 16, 25]);
  assert.deepEqual(extractCandidates(text), result);
});

test('ignores bracket and quote delimiters inside JSON strings', () => {
  const raw = String.raw`{"text":"} ] [ { \" \\","list":["{", "}"]}`;
  assert.equal(extractCandidates(`prefix ${raw} suffix`)?.[0]?.raw, raw);
});

test('returns no scalars and does not repair invalid JSON', () => {
  const text = '42 true null "hello" {a:1} {"a":1,} [01] [NaN] {"a":2}';
  const result = extractCandidates(text);
  assert.deepEqual(result?.map(candidate => candidate.raw), ['{"a":2}']);
});

test('never salvages a complete child from a truncated or invalid outer container', () => {
  for (const text of [
    'log {"a":{"complete":true},"tail":',
    'log [{"complete":true},',
    'log {"a":[1,2]',
    '{"complete":true,"bad":{"nested":1},oops}',
    '"unterminated escaped payload {\\"complete\\":true}',
  ]) {
    assert.deepEqual(extractCandidates(text), [], text);
  }
});

test('keeps preceding complete candidates when a later candidate is truncated', () => {
  assert.deepEqual(extractCandidates('{} next {"child":{"ok":1},')?.map(candidate => candidate.raw), ['{}']);
});

test('decodes complete JSON string literals losslessly and points to their source wrapper', () => {
  const raw = String.raw`{"n":9007199254740993,"big":1e400,"zero":-0,"a":"\u0061","a":"\/"}`;
  const encoded = JSON.stringify(raw);
  const text = `payload=${encoded} end`;
  assert.deepEqual(extractCandidates(text), [{
    id: 'json-1', raw, start: 8, end: 8 + encoded.length, decoded: true,
  }]);
});

test('supports one, two, and three full JSON string encoding layers', () => {
  const raw = '{"a":[1,2]}';
  let text = raw;
  for (let layer = 1; layer <= 3; layer += 1) {
    text = JSON.stringify(text);
    assert.deepEqual(extractCandidates(text), [{
      id: 'json-1', raw, start: 0, end: text.length, decoded: true,
    }], `layer ${layer}`);
  }
});

test('extracts multiple decoded candidates once each, preserving identical occurrences', () => {
  const encoded = JSON.stringify('first {"a":1} second {"a":1} last [2]');
  const result = extractCandidates(encoded);
  assert.deepEqual(result?.map(candidate => candidate.raw), ['{"a":1}', '{"a":1}', '[2]']);
  assert.deepEqual(result.map(candidate => [candidate.start, candidate.end, candidate.decoded]),
    Array(3).fill([0, encoded.length, true]));
});

test('does not repair invalid or truncated escaped JSON', () => {
  for (const text of [
    JSON.stringify('{"a":{"ok":1},'),
    String.raw`"{\"a\":01}"`,
    String.raw`"{\"a\":\x31}"`,
    String.raw`"{\"a\":1}`,
  ]) {
    assert.deepEqual(extractCandidates(text), [], text);
  }
});

test('does not silently cap many independent candidate occurrences', () => {
  const text = '[] '.repeat(2000);
  const result = extractCandidates(text);
  assert.equal(result?.length, 2000);
  assert.equal(result[1999].id, 'json-2000');
});

test('bounds work for 100 KiB prose, malformed containers, and malformed strings', () => {
  const cases = [
    'a'.repeat(100 * 1024 - 2) + '{}',
    '{'.repeat(100 * 1024),
    ('"\\x" ').repeat(20 * 1024),
  ];
  const started = performance.now();
  assert.equal(extractCandidates(cases[0])?.length, 1);
  assert.deepEqual(extractCandidates(cases[1]), []);
  assert.deepEqual(extractCandidates(cases[2]), []);
  assert.ok(performance.now() - started < 2000, '100 KiB scans should finish promptly without repeated suffix parsing');
});

test('rejects non-string extraction input clearly', () => {
  assert.throws(() => extractCandidates(null), TypeError);
});

test('decodes a balanced bare escaped fragment without changing its JSON lexemes', () => {
  const raw = String.raw`{"a":9007199254740993,"a":1e400,"b":-0,"text":"} [ { \" \\","escape":"\u0061"}`;
  const escaped = JSON.stringify(raw).slice(1, -1);
  const text = `log data=${escaped} finished`;
  assert.deepEqual(extractCandidates(text), [{
    id: 'json-1', raw, start: 9, end: 9 + escaped.length, decoded: true,
  }]);
});

test('supports double and triple escaped bare fragments with one total decoding budget', () => {
  const raw = '[{"a":1},"value"]';
  let escaped = raw;
  for (let layer = 1; layer <= 3; layer += 1) {
    escaped = JSON.stringify(escaped).slice(1, -1);
    const text = `prefix ${escaped} suffix`;
    assert.deepEqual(extractCandidates(text), [{
      id: 'json-1', raw, start: 7, end: 7 + escaped.length, decoded: true,
    }], `bare layer ${layer}`);
  }
  const onceBare = JSON.stringify(raw).slice(1, -1);
  const wrapped = JSON.stringify(JSON.stringify(onceBare));
  assert.deepEqual(extractCandidates(wrapped), [{
    id: 'json-1', raw, start: 0, end: wrapped.length, decoded: true,
  }]);
});

test('rejects malformed or truncated bare escaped outer fragments without inner salvage', () => {
  for (const text of [
    String.raw`data={\"a\":{\"complete\":true},`,
    String.raw`data={\"a\":01}`,
    String.raw`data={\"a\":\x31}`,
    String.raw`data={\"a\":\"unfinished}`,
    String.raw`data={"a":\"mixed\"}`,
    JSON.stringify(String.raw`{\"a\":{\"complete\":true},`).slice(1, -1),
  ]) {
    assert.deepEqual(extractCandidates(text), [], text);
  }
});

test('does not let a mismatched closer expose a child of an invalid outer object', () => {
  assert.deepEqual(extractCandidates('{"broken":] {"child":1}'), []);
});

test('bounds repeated bare escaped extraction to avoid repeated suffix scans', () => {
  const raw = '{"id":1}';
  const escaped = JSON.stringify(raw).slice(1, -1);
  const text = `${escaped} `.repeat(8000);
  const started = performance.now();
  const result = extractCandidates(text);
  assert.equal(result.length, 8000);
  assert.equal(result.at(-1).raw, raw);
  assert.ok(performance.now() - started < 2000, 'Repeated escaped objects should not trigger quadratic rescanning');
});

test('continues after a balanced invalid escaped fragment without dropping later independent JSON', () => {
  const invalid = String.raw`{\"a\":01}`;
  const text = `bad ${invalid} valid {"ok":1}`;
  assert.deepEqual(extractCandidates(text).map(candidate => candidate.raw), ['{"ok":1}']);
});

test('never exposes a nested child after mixed invalid escaping in the outer object', () => {
  assert.deepEqual(extractCandidates(String.raw`{"a":\"bad\", "child":{"safe":1}}`), []);
});
