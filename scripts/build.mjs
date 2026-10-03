import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'extension');
const output = join(root, 'dist');
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Expected Manifest V3');
const required = ['viewer.html', 'viewer.js', 'options.html', 'options.js', 'worker.js', 'tree.js', 'style.css', 'core/json.js', 'core/extract.js', 'core/llm.js', manifest.background.service_worker, ...manifest.content_scripts.flatMap(script => script.js), ...Object.values(manifest.icons || {})];
for (const file of required) if (!(await stat(join(source, file))).isFile()) throw new Error(`Missing extension asset: ${file}`);
// Only copy shipped assets; no source text, settings, tests or API credentials enter the package.
await mkdir(output, { recursive: true });
for (const entry of await readdir(source)) await cp(join(source, entry), join(output, entry), { recursive: true, force: true });
console.log(`JSON Lens ${manifest.version} built successfully. Load unpacked: ${output}`);
