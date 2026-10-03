import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, access, cp, appendFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const artifacts = join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const json = '{"id":9007199254740993,"10":"first","2":"second","duplicate":1,"duplicate":2,"nested":{"name":"Ada","active":true},"list":[1,2,3],"html":"<img src=x onerror=alert(1)>"}';
const aiObject = '{"request_id":9007199254740993,"ok":true}';
const aiArray = '[{"name":"示例"},2]';
const aiText = `request log\n${aiObject}\nresponse\n${aiArray}\nend`;
let aiMode = 'success';
let aiRequests = 0;
let lastInput;
const pageRequests = new Map();
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/v1/chat/completions') {
    aiRequests++;
    let body = '';
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    lastInput = data.messages[1].content;
    assert.equal(request.headers.authorization, 'Bearer test-only-key');
    response.setHeader('Content-Type', 'application/json');
    if (aiMode === 'auth') { response.writeHead(401); response.end('{"error":"not authorized"}'); return; }
    if (aiMode === 'slow') { const timer = setTimeout(() => response.end('{}'), 65_000); response.on('close', () => clearTimeout(timer)); return; }
    const results = lastInput.includes('connection') ? ['{"connection":"ok"}'] : aiMode === 'fabricated' ? ['{"invented":true}'] : [aiObject, aiArray];
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }] }));
    return;
  }
  if (['/data.json', '/problem', '/csp'].includes(path)) {
    pageRequests.set(path, (pageRequests.get(path) || 0) + 1);
    response.setHeader('Content-Type', path === '/problem' ? 'application/problem+json' : 'application/json');
    if (path === '/csp') response.setHeader('Content-Security-Policy', "default-src 'none'; frame-src 'none'; style-src 'none'");
    response.end(json);
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><title>Ordinary page</title><body><h1 id="untouched">普通网页</h1><p id="log">log {"a":1}</p></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'json-lens-test-'));
const extensionPath = join(profile, 'test-extension');
await cp(join(root, 'extension'), extensionPath, { recursive: true });
// Headless Chromium cannot interact with the OS optional-permission prompt.
// Pregrant only the mock server host in the disposable test manifest.
const testManifestPath = join(extensionPath, 'manifest.json');
const testManifest = JSON.parse(await readFile(testManifestPath, 'utf8'));
testManifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(testManifestPath, JSON.stringify(testManifest));
// Test-only handle for the actual native-menu callback, in an ephemeral copy.
// Chrome's OS context menu is not exposed to headless Playwright.
await appendFile(join(extensionPath, 'background.js'), '\nglobalThis.__jsonLensTestSelection = openSelection;\n');
let context;
let currentPage;
const errors = [];
const checks = [];
function pass(label) { checks.push(label); console.log(`PASS ${label}`); }
async function valid(page) { await page.waitForFunction(() => document.querySelector('#editorStatus')?.textContent.includes('有效 JSON')); }
async function noticeContains(page, text) { await page.waitForFunction(text => document.querySelector('#notice')?.textContent.includes(text), text); }

try {
  let executablePath = process.env.CHROMIUM_PATH;
  if (!executablePath) {
    try { await access(chromium.executablePath()); }
    catch { throw new Error('Chromium is missing. Run npx playwright install chromium, or set CHROMIUM_PATH.'); }
  }
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', executablePath,
    headless: process.env.HEADED !== '1',
    viewport: { width: 1440, height: 960 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).hostname;
  const base = `chrome-extension://${extensionId}`;
  const page = await context.newPage();
  currentPage = page;
  await page.goto(`${base}/viewer.html`);
  await page.locator('#sample').click();
  await valid(page);
  assert.match(await page.locator('#source').inputValue(), /9007199254740993/);
  pass('extension loads and example preserves a large integer');

  await page.locator('#source').fill(json);
  await valid(page);
  await page.locator('#format').click();
  await page.waitForFunction(() => document.querySelector('#source').value.includes('\n'));
  assert.equal((await page.locator('#source').inputValue()).match(/"duplicate"/g).length, 2);
  assert.match(await page.locator('#documentStats').textContent(), /重复字段/);
  assert.equal(await page.locator('#tree img').count(), 0);
  await page.locator('#minify').click();
  await page.waitForFunction(text => document.querySelector('#source').value === text, json);
  pass('format/minify preserve literals, duplicates, member order and inert HTML');

  await page.locator('#search').fill('Ada');
  await page.waitForFunction(() => document.querySelector('#searchCount').textContent === '1 项');
  await page.locator('.tree-row.match').click();
  assert.equal(await page.locator('#path').textContent(), '$.nested.name');
  await page.locator('#copyPath').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已复制路径'));
  await page.locator('#search').fill('');
  pass('nested search, node selection and copy path');

  await page.locator('#source').fill('{\n  "a":\n}');
  await page.waitForFunction(() => document.querySelector('#editorStatus').classList.contains('invalid'));
  assert.match(await page.locator('#editorStatus').textContent(), /第 \d+ 行，第 \d+ 列/);
  assert.equal(await page.locator('#copy').isDisabled(), true);
  await page.locator('#source').fill('{"a":1}');
  await valid(page);
  await page.locator('#source').focus();
  await page.locator('#source').evaluate(element => element.setSelectionRange(6, 6));
  await page.keyboard.type('2');
  await page.waitForFunction(() => document.querySelector('#source').value === '{"a":12}');
  await valid(page);
  assert.equal(await page.locator('#source').evaluate(element => element.selectionStart), 7);
  pass('invalid-edit feedback disables export and validation preserves caret');

  const downloadEvent = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'json-lens.json');
  pass('JSON download');

  for (const endpoint of ['/data.json', '/problem', '/csp']) {
    const doc = await context.newPage(); currentPage = doc;
    await doc.goto(`${origin}${endpoint}`);
    const frame = doc.frameLocator('#json-lens-frame');
    await frame.locator('#editorStatus.valid').waitFor();
    assert.match(await frame.locator('#source').inputValue(), /9007199254740993/);
    assert.equal(pageRequests.get(endpoint), 1);
    await doc.locator('#json-lens-restore').click();
    assert.equal(await doc.locator('#json-lens-frame').count(), 0);
    assert.equal(await doc.locator('pre').textContent(), json);
    await doc.close();
  }
  pass('application/json and application/problem+json auto-enhance without refetch; restore original');
  currentPage = page;

  const ordinary = await context.newPage();
  await ordinary.goto(origin);
  assert.equal(await ordinary.locator('#untouched').textContent(), '普通网页');
  assert.equal(await ordinary.locator('#json-lens-frame').count(), 0);
  await ordinary.close();
  pass('ordinary HTML stays unchanged');

  const nextPage = context.waitForEvent('page');
  nextPage.catch(() => {});
  await serviceWorker.evaluate(() => globalThis.__jsonLensTestSelection({ menuItemId: 'json-lens-format', selectionText: '{"from_selection":9007199254740993}' }));
  const selectionPage = await nextPage;
  await selectionPage.waitForURL(`${base}/viewer.html**`);
  await valid(selectionPage);
  assert.match(await selectionPage.locator('#source').inputValue(), /9007199254740993/);
  assert.equal(new URL(selectionPage.url()).search, '');
  await selectionPage.close();
  pass('registered context-menu handler transfers selection to a standalone tab');

  const deepSource = '['.repeat(256) + '0,'.repeat(11_000) + '0' + ']'.repeat(256);
  const deepPageEvent = context.waitForEvent('page');
  deepPageEvent.catch(() => {});
  await serviceWorker.evaluate(text => globalThis.__jsonLensTestSelection({ menuItemId: 'json-lens-format', selectionText: text }), deepSource);
  const deepPage = await deepPageEvent;
  await deepPage.waitForURL(`${base}/viewer.html**`);
  await valid(deepPage);
  assert.equal(await deepPage.locator('#source').inputValue(), deepSource);
  await noticeContains(deepPage, '缩进后的内容超过');
  assert.ok(await deepPage.locator('.tree-row').count() > 0);
  assert.equal(await deepPage.locator('#minify').isEnabled(), true);
  await deepPage.close();
  pass('valid source remains viewable when formatted output exceeds the size limit');

  const oversizedSelection = '{"payload":"' + 'x'.repeat(103_000) + '"}';
  const oversizePageEvent = context.waitForEvent('page');
  oversizePageEvent.catch(() => {});
  await serviceWorker.evaluate(text => globalThis.__jsonLensTestSelection({ menuItemId: 'json-lens-ai', selectionText: text }), oversizedSelection);
  const oversizedPage = await oversizePageEvent;
  await oversizedPage.waitForURL(`${base}/viewer.html**`);
  await noticeContains(oversizedPage, '100 KB');
  assert.equal(await oversizedPage.locator('#source').inputValue(), oversizedSelection);
  assert.equal(aiRequests, 0);
  await oversizedPage.close();
  pass('AI context-menu size error retains selected source without sending');

  const options = await context.newPage(); currentPage = options;
  await options.goto(`${base}/options.html`);
  await options.locator('#baseUrl').fill(`${origin}/v1`);
  await options.locator('#apiKey').fill('test-only-key');
  await options.locator('#model').fill('mock-json-extractor');
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#settingsNotice').textContent.includes('已保存'));
  await options.locator('#test').click();
  await options.waitForFunction(() => document.querySelector('#settingsNotice').textContent.includes('连接成功'));
  await options.close(); currentPage = page;
  pass('local settings and a real HTTP Chat Completions connection test');

  const aiMenuPageEvent = context.waitForEvent('page');
  aiMenuPageEvent.catch(() => {});
  await serviceWorker.evaluate(text => globalThis.__jsonLensTestSelection({ menuItemId: 'json-lens-ai', selectionText: text }), aiText);
  const aiMenuPage = await aiMenuPageEvent;
  await aiMenuPage.waitForURL(`${base}/viewer.html**`);
  await noticeContains(aiMenuPage, '已识别 2 个 JSON');
  assert.equal(lastInput, aiText);
  await aiMenuPage.close();
  pass('AI context-menu handler automatically extracts the selected text');

  await page.locator('#source').fill(aiText);
  await page.locator('#ai').click();
  await noticeContains(page, '已识别 2 个 JSON');
  assert.equal(lastInput, aiText);
  assert.equal(await page.locator('#resultSelect option').count(), 3);
  assert.match(await page.locator('#source').inputValue(), /9007199254740993/);
  await page.locator('#resultSelect').selectOption('1');
  await valid(page);
  assert.match(await page.locator('#source').inputValue(), /示例/);
  await page.locator('#original').click();
  assert.equal(await page.locator('#source').inputValue(), aiText);
  pass('AI extraction, multiple-result switching and original-text recovery');

  const beforeOversize = aiRequests;
  await page.locator('#source').fill('中'.repeat(40_000));
  await page.locator('#ai').click();
  await noticeContains(page, '100 KB');
  assert.equal(aiRequests, beforeOversize);
  pass('AI byte limit blocks network transmission');

  for (const [mode, expected] of [['auth', '鉴权失败'], ['fabricated', '原文不一致']]) {
    aiMode = mode;
    await page.locator('#source').fill(aiText);
    await page.locator('#ai').click();
    await noticeContains(page, expected);
    assert.equal(await page.locator('#source').inputValue(), aiText);
  }
  pass('authentication and fidelity failures preserve source');

  aiMode = 'slow';
  await page.locator('#ai').click();
  await page.locator('#cancel').waitFor({ state: 'visible' });
  await page.locator('#cancel').click();
  await noticeContains(page, '已取消');
  assert.equal(await page.locator('#source').isEditable(), true);
  pass('in-flight cancellation returns editor control');

  aiMode = 'success';
  await page.locator('#clear').click();
  await page.locator('#sample').click();
  await valid(page);
  await page.locator('#expand').click();
  await page.screenshot({ path: join(artifacts, 'json-lens-light.png'), fullPage: true, animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(artifacts, 'json-lens-dark.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 600, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(artifacts, 'json-lens-narrow.png'), fullPage: true, animations: 'disabled' });
  pass('light/dark appearance and narrow-width layout');

  const saved = await serviceWorker.evaluate(() => chrome.storage.local.get(null));
  assert.deepEqual(Object.keys(saved), ['settings']);
  assert.deepEqual(errors, []);
  pass('only settings persisted; no uncaught page errors');
  console.log(`\n${checks.length} browser checks passed. Screenshots: ${artifacts}`);
} catch (error) {
  if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
