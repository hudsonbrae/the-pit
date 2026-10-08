import { createApp } from './app.js';

// Last line of defence: log, never die, on a stray rejection or exception.
process.on('unhandledRejection', e => console.error(JSON.stringify({ ev: 'unhandled_rejection', error: String((e as Error)?.stack ?? e) })));
process.on('uncaughtException', e => console.error(JSON.stringify({ ev: 'uncaught_exception', error: String(e?.stack ?? e) })));

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
