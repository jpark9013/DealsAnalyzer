// The most recently built zip in dist/, for scripts that default to it.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function newestZip() {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const zips = (existsSync(dist) ? readdirSync(dist) : [])
    .filter((name) => name.endsWith('.zip'))
    .map((name) => path.join(dist, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!zips.length) throw new Error('No zip in dist/: run npm run package, or put the zip there.');
  return zips[0];
}
