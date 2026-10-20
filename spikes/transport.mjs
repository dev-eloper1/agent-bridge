import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
const p = spawn(process.execPath, ['scripts/mock-acp.mjs']);
const c = client({ name: 'spike' }).onNotification('session/update', () => {}).connect(ndJsonStream(Writable.toWeb(p.stdin), Readable.toWeb(p.stdout)));
try {
 const init = await c.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
 const session = await c.agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });
 for (const text of ['remember alpha', 'recall']) await c.agent.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] });
 console.log(JSON.stringify({ transport: 'sdk', initialize: init, session, prompts: 2 }));
} finally { c.close(); p.kill(); }
