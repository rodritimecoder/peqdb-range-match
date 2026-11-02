import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'vendor', 'autoeq-c', 'src');
const OUT = join(ROOT, 'bin', process.platform === 'win32' ? 'autoeq.exe' : 'autoeq');
const sources = ['autoeq.c', 'biquad.c', 'init.c'].map((file) => join(SRC, file));

mkdirSync(join(ROOT, 'bin'), { recursive: true });

let last = 'no compiler tried';
for (const cc of ['cc', 'gcc', 'clang']) {
  const run = spawnSync(cc, [...sources, '-lm', '-O2', '-o', OUT], { stdio: 'inherit' });
  if (run.error?.code === 'ENOENT') {
    last = `${cc}: not found`;
    continue;
  }
  if (run.status === 0) {
    console.log(`built ${OUT}`);
    process.exit(0);
  }
  last = `${cc}: exit ${run.status}`;
}

console.error(`could not build autoeq-c (${last}); install cc, gcc or clang and retry`);
process.exit(1);
