#!/usr/bin/env node
// Deep pinned-pi smoke for desktop notifications. Drives a REAL agent turn
// with no external model: a local canned-SSE HTTP server stands in as an
// openai-completions provider (registered via test/mock-provider.ts), the
// RPC `prompt` verb runs a genuine turn, and the smoke asserts the extension
// observed the full lifecycle — session_start recorded terminal detection
// (notify-installed.json) and agent_end produced the notification summary
// (notify-agent-end.json) matching the assistant's actual text.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'pi-notify-deep-'));
const agentDir = join(dir, 'agent');
mkdirSync(join(agentDir, 'sessions', 'tmp'), { recursive: true });
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mocktest', defaultModel: 'mock-model' }, null, 2) + '\n');
const MARKER_START = join(agentDir, 'notify-installed.json');
const MARKER_END = join(agentDir, 'notify-agent-end.json');

// Canned openai-completions SSE: role delta -> content delta -> stop -> DONE.
const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const server = createServer((req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
	res.write(chunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
	res.write(chunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta: { content: 'notify me when done' }, finish_reason: null }] }));
	res.write(chunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
	res.write('data: [DONE]\n\n');
	res.end();
});
server.listen(0, '127.0.0.1');
await new Promise((resolve) => server.on('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const child = spawn(
	process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
	['--mode', 'rpc', '--no-extensions', '-e', join(root, 'index.ts'), '-e', join(root, 'test', 'mock-provider.ts'), '--session-dir', join(agentDir, 'sessions', 'tmp')],
	{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NOTIFY_DEBUG: '1', MOCK_BASE_URL: baseUrl, MOCK_API_KEY: 'test-key' }, cwd: dir },
);
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });

const t0 = Date.now();
let phase = 'boot';
let promptSent = false;
const killTimer = setTimeout(() => child.kill('SIGKILL'), 90_000);
const poll = setInterval(() => {
	if (phase === 'boot' && existsSync(MARKER_START)) {
		phase = 'prompt';
		console.error('  session_start proven (marker 1); sending RPC prompt');
		child.stdin.write(JSON.stringify({ type: 'prompt', id: 'p1', message: 'hi' }) + '\n');
		promptSent = true;
	} else if (phase === 'prompt' && existsSync(MARKER_END)) {
		phase = 'done';
		clearInterval(poll);
		finish(true);
	} else if (Date.now() - t0 > (promptSent ? 45_000 : 20_000)) {
		clearInterval(poll);
		finish(false);
	}
}, 200);

function finish(ok) {
	child.kill('SIGTERM');
	server.close();
	child.on('exit', () => {
		clearTimeout(killTimer);
		try {
			assert2(ok, `timed out at phase=${phase}; stderr tail: ${err.slice(-800)}`);
			const start = JSON.parse(readFileSync(MARKER_START, 'utf8'));
			const end = JSON.parse(readFileSync(MARKER_END, 'utf8'));
			assert2(typeof start.terminal === 'string' && start.terminal.length > 0, `installed marker terminal: ${JSON.stringify(start)}`);
			assert2(end.title === 'pi ✓ done', `agent_end title: ${JSON.stringify(end.title)}`);
			assert2(end.body === 'notify me when done', `agent_end body matches assistant text: ${JSON.stringify(end.body)}`);
			assert2(end.errored === false, `errored flag: ${JSON.stringify(end.errored)}`);
			assert2((end.messageCount ?? 0) > 0, `messageCount: ${JSON.stringify(end)}`);
			console.log(`Deep smoke PASS: real turn driven; session_start detected "${start.terminal}", agent_end summary "${end.title}: ${end.body}" (${(Date.now() - t0) / 1000 | 0}s).`);
		} catch (e) {
			console.error('FAIL', e.message);
			console.error(`stdout tail: ${out.slice(-400)}`);
			process.exitCode = 1;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
function assert2(cond, msg) { if (!cond) throw new Error(msg); }
