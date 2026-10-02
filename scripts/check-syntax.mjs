#!/usr/bin/env node
/**
 * Syntax gate used by `npm run check` and by the Dockerfile.
 *
 * Why not a linter: this project has no build step and no dev-dependency tree on
 * purpose (it runs on a NAS). `node --check` catches the mistakes that actually
 * break a deployment — a bad edit, a truncated file, a stray character — and it
 * runs in milliseconds with zero dependencies.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['src', 'scripts', 'public'].map((dir) => path.join(root, dir));

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) yield full;
  }
}

let checked = 0;
let failed = 0;
for (const target of targets) {
  let files = [];
  try { files = [...walk(target)]; } catch { continue; }
  for (const file of files) {
    const rel = path.relative(root, file);
    if (rel.startsWith('public/') && !rel.endsWith('.js')) continue;
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    checked += 1;
    if (res.status !== 0) {
      failed += 1;
      console.error(`✗ ${rel}\n${res.stderr}`);
    } else {
      console.log(`✓ ${rel}`);
    }
  }
}

console.log(`\n${checked - failed}/${checked} files passed the syntax check`);
process.exit(failed ? 1 : 0);
