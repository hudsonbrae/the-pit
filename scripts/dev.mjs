// `npm run dev`: the game server (auto-restarts on change) and Vite (hot reload) side by side.
import { spawn } from 'node:child_process';

const procs = [
  ['server', ['tsx', 'watch', 'server/index.ts']],
  ['web', ['vite']],
].map(([name, args]) => {
  const p = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const tag = (s) => s.toString().split('\n').filter(Boolean).map(l => `[${name}] ${l}`).join('\n') + '\n';
  p.stdout.on('data', d => process.stdout.write(tag(d)));
  p.stderr.on('data', d => process.stderr.write(tag(d)));
  p.on('exit', code => { console.log(`[${name}] exited (${code})`); stop(); });
  return p;
});
function stop() { procs.forEach(p => p.kill()); process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
