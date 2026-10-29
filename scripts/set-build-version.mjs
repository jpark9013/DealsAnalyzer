// Stamps a build number into extension/manifest.json so every release has its
// own version: 1.0.0 in the repo becomes 1.0.<build>. Prints the version, and
// also writes it to $GITHUB_OUTPUT when run in GitHub Actions.
//   node scripts/set-build-version.mjs 42   ->  1.0.42
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const build = process.argv[2] ?? process.env.GITHUB_RUN_NUMBER;
// Browsers allow at most 65535 per version component.
if (!/^\d+$/.test(build ?? '') || Number(build) > 65535) {
  console.error('usage: node scripts/set-build-version.mjs <build number, 0-65535>');
  process.exit(1);
}

const path = new URL('../extension/manifest.json', import.meta.url);
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const [major, minor] = manifest.version.split('.');
manifest.version = `${major}.${minor}.${Number(build)}`;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${manifest.version}\n`);
console.log(manifest.version);
