#!/usr/bin/env node
// Write the randprotocol.org site's src/data/release.ts for a release: every file attached to it,
// with its size and SHA-256. The site's /clients pages link the files and print the sums from it.
//
//   scripts/release/checksums.sh v0.6.7                                   # fills dist/release/v0.6.7/
//   node scripts/release/site-release.mjs v0.6.7 > ../randprotocol.org/src/data/release.ts
//
// It reads dist/release/<tag>/SHA256SUMS — what checksums.sh wrote after downloading the release
// back from GitHub — and nothing else decides what is listed: a file that is not in SHA256SUMS is
// not on the site. Sizes are read from the same directory, and each file is hashed again here, so
// a directory that no longer matches its SHA256SUMS stops this rather than publishing a wrong sum.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
  console.error('usage: site-release.mjs v<major>.<minor>.<patch> [YYYY-MM-DD]');
  process.exit(2);
}
const date = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'release', tag);

const files = readFileSync(join(dir, 'SHA256SUMS'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`SHA256SUMS: not a sum line: ${line}`);
    const [, sha256, name] = m;
    const path = join(dir, name);
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== sha256) throw new Error(`${name}: SHA256SUMS says ${sha256}, the file is ${actual}`);
    return { name, size: statSync(path).size, sha256 };
  });

const rows = files
  .map((f) => `  { name: ${JSON.stringify(f.name)}, size: ${f.size}, sha256: ${JSON.stringify(f.sha256)} },`)
  .join('\n');

process.stdout.write(`// GENERATED — do not edit. Written by the clients repository:
//   scripts/release/checksums.sh ${tag} && node scripts/release/site-release.mjs ${tag} > src/data/release.ts
// Every file attached to the ${tag} release of github.com/randprotocol/clients, with the size and
// SHA-256 of the file as GitHub serves it. src/data/clients.ts says which client each belongs to.

export const RELEASE = {
  version: ${JSON.stringify(tag.slice(1))},
  tag: ${JSON.stringify(tag)},
  date: ${JSON.stringify(date)},
} as const;

export type ReleaseFile = { name: string; size: number; sha256: string };

export const RELEASE_FILES: ReleaseFile[] = [
${rows}
];
`);
