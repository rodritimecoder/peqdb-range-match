import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.PORT ?? '7319';
const url = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
server.stderr.on('data', (chunk) => { output += chunk; process.stderr.write(chunk); });

const stop = () => {
  if (server.exitCode === null && !server.killed) server.kill();
};
process.on('exit', stop);

let ready = false;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  if (server.exitCode !== null) break;
  try {
    const health = await (await fetch(`${url}/api/health`)).json();
    if (health.data && health.targets) { ready = true; break; }
  } catch { /* server not listening yet */ }
  await sleep(500);
}

if (!ready) {
  stop();
  console.error(`server did not become ready on ${url}\n${output}`);
  process.exit(1);
}

const test = spawnSync(process.execPath, ['test.mjs'], { stdio: 'inherit' });
stop();
process.exit(test.status ?? 1);
