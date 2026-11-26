import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required for built-in SQLite.');
let checked = 0;
function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (['vendor','.git','.runtime','data','node_modules'].includes(item.name)) continue;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) walk(absolute);
    else if (/\.(mjs|js)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', absolute], { stdio: 'inherit' });
      if (result.error || result.status !== 0) throw result.error || new Error(`Syntax error: ${path.relative(root, absolute)}`);
      checked++;
    }
  }
}
walk(root);
for (const file of ['README.md','lab4-report.md','docs/architecture.png','docs/data-model.png','compose.yaml','contracts/driver-profile.pact.json','frontend/vendor/leaflet/LICENSE']) {
  if (!existsSync(path.join(root, file))) throw new Error(`Missing deliverable: ${file}`);
}
const contract = JSON.parse(readFileSync(path.join(root, 'contracts', 'driver-profile.pact.json'), 'utf8'));
if (!Array.isArray(contract.interactions) || contract.interactions.length < 2) throw new Error('Pact contract needs at least two interactions');
for (const interaction of contract.interactions) {
  if (!interaction.request?.method || !interaction.request?.path || !interaction.response?.status) throw new Error('Pact interaction is incomplete');
}
const business = JSON.parse(readFileSync(path.join(root, 'contracts', 'openapi.json'), 'utf8'));
const operations = Object.values(business.paths).flatMap(pathItem => Object.values(pathItem));
console.log(`PASS: ${checked} JavaScript modules parse; ${operations.length} business API operations; ${contract.interactions.length} contract interactions; required deliverables exist; Node ${process.version}.`);
