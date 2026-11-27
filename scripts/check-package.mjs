// Fails unless a packaged zip holds exactly what's in extension/ (less the
// screenshots/ for the store listing), with
// manifest.json at its top level: browsers need it there, and nothing from the
// rest of the repo should ever ship.
//   node scripts/check-package.mjs                 checks the newest zip in dist/
//   node scripts/check-package.mjs path/to/x.zip
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { newestZip } from './newest-zip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const zip = process.argv[2] || newestZip();
const packaged = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' })
  .split('\n')
  .filter((name) => name && !name.endsWith('/'));
const expected = readdirSync(path.join(root, 'extension'), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
  .map((entry) => path.relative(path.join(root, 'extension'), path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
  // Store-listing images, uploaded in the dashboard; `npm run package` leaves them out.
  .filter((name) => !name.startsWith('screenshots/'));

const extra = packaged.filter((name) => !expected.includes(name));
const missing = expected.filter((name) => !packaged.includes(name));
if (extra.length || missing.length) {
  if (extra.length) console.error(`Not from extension/: ${extra.join(', ')}`);
  if (missing.length) console.error(`Missing from the zip: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`${path.basename(zip)}: ${packaged.length} files, exactly extension/`);
