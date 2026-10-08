import { createApp } from './app.js';

const app = createApp();
const port = await app.listen();
const d = app.deps;
console.log(`The Pit is running on http://localhost:${port}`);
console.log(`  AI:      ${d.llm ? d.llm.label + (d.llm.real ? ` (${d.cfg.modelRound} / ${d.cfg.modelFast})` : '') : 'off (offline rules only)'}`);
console.log(`  Data:    ${d.hub ? d.hub.provider.name : 'off'}`);
console.log(`  Storage: ${d.store.kind === 'supabase' ? 'Supabase' : 'memory (resets when the server restarts)'}`);

const stop = async () => { console.log('Shutting down…'); await app.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
