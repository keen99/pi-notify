import assert from "node:assert/strict";
import test from "node:test";

const notify = await import("../index.js");
const {
	detectTerminal,
	extractSummary,
	osc9,
	osc99,
	osc777,
	sendTerminalNotification,
	isActiveWindow,
} = notify as {
	detectTerminal: (env?: Partial<typeof process.env>) => string;
	extractSummary: (messages: any[]) => { title: string; body: string; errored: boolean };
	osc9: (m: string) => string;
	osc99: (m: string) => string;
	osc777: (m: string) => string;
	sendTerminalNotification: (t: string, title: string, body: string) => void;
	isActiveWindow: () => boolean;
};

// ── detectTerminal ──────────────────────────────────────────────────────
// detectTerminal reads process.env directly; save/restore around each case.
const ENV_KEYS = ["TERM_PROGRAM", "TERM"];

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
	const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
	for (const k of ENV_KEYS) delete process.env[k];
	Object.assign(process.env, env);
	try {
		fn();
	} finally {
		for (const k of ENV_KEYS) delete process.env[k];
		for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
	}
}

test("detectTerminal maps TERM_PROGRAM variants", () => {
	withEnv({ TERM_PROGRAM: "ghostty" }, () => assert.equal(detectTerminal(), "ghostty"));
	withEnv({ TERM_PROGRAM: "kitty" }, () => assert.equal(detectTerminal(), "kitty"));
	withEnv({ TERM_PROGRAM: "iTerm.app" }, () => assert.equal(detectTerminal(), "iterm2"));
	withEnv({ TERM_PROGRAM: "WezTerm" }, () => assert.equal(detectTerminal(), "wezterm"));
	withEnv({ TERM_PROGRAM: "WarpTerminal" }, () => assert.equal(detectTerminal(), "warp"));
	withEnv({ TERM_PROGRAM: "Apple_Terminal" }, () => assert.equal(detectTerminal(), "terminal_app"));
});

test("detectTerminal falls back to TERM, then unknown", () => {
	withEnv({ TERM: "xterm-ghostty" }, () => assert.equal(detectTerminal(), "ghostty"));
	withEnv({ TERM: "xterm-kitty" }, () => assert.equal(detectTerminal(), "kitty"));
	withEnv({}, () => assert.equal(detectTerminal(), "unknown"));
	withEnv({ TERM_PROGRAM: "vscode", TERM: "xterm-256color" }, () => assert.equal(detectTerminal(), "unknown"));
});

// ── OSC builders ────────────────────────────────────────────────────────
test("osc9 wraps message in OSC 9 + BEL", () => {
	assert.equal(osc9("hello"), "\x1b]9;hello\x07");
});

test("osc99 uses kitty notification params", () => {
	assert.equal(osc99("body"), "\x1b]99;i=1:d=0:p=body;body\x07");
});

test("osc777 targets pi source", () => {
	assert.equal(osc777("msg"), "\x1b]777;notify;pi;msg\x07");
});

// ── sendTerminalNotification ────────────────────────────────────────────
function captureStdout(fn: () => void): string {
	const orig = process.stdout.write.bind(process.stdout);
	let out = "";
	(process.stdout as any).write = (chunk: any, ...rest: any[]) => {
		out += chunk?.toString?.() ?? String(chunk);
		return orig.length >= 0 ? true : true;
	};
	try {
		fn();
	} finally {
		process.stdout.write = orig;
	}
	return out;
}

test("sendTerminalNotification: iterm2/ghostty/wezterm prefix title into OSC 9", () => {
	for (const term of ["iterm2", "ghostty", "wezterm"]) {
		const out = captureStdout(() => sendTerminalNotification(term as any, "pi ✓ done", "All set"));
		assert.equal(out, `\x1b]9;pi ✓ done: All set\x07\x07`, term);
	}
});

test("sendTerminalNotification: kitty uses OSC 99", () => {
	const out = captureStdout(() => sendTerminalNotification("kitty", "pi ✓ done", "Body only"));
	assert.equal(out, "\x1b]99;i=1:d=0:p=body;Body only\x07\x07");
});

test("sendTerminalNotification: warp uses OSC 777", () => {
	const out = captureStdout(() => sendTerminalNotification("warp", "pi ✓ done", "Warp body"));
	assert.equal(out, "\x1b]777;notify;pi;Warp body\x07\x07");
});

test("sendTerminalNotification: unknown terminal falls back to OSC 777", () => {
	const out = captureStdout(() => sendTerminalNotification("unknown" as any, "t", "u"));
	assert.equal(out, "\x1b]777;notify;pi;u\x07\x07");
});

// ── extractSummary ──────────────────────────────────────────────────────
test("extractSummary: default when no assistant messages", () => {
	const r = extractSummary([]);
	assert.deepEqual(r, { title: "pi finished", body: "Agent completed", errored: false });
});

test("extractSummary: last text block becomes body, first line only", () => {
	const msgs = [
		{ role: "assistant", content: [{ type: "text", text: "first draft" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "earlier block" },
				{ type: "text", text: "final answer\nsecond line\nthird" },
			],
		},
	];
	const r = extractSummary(msgs);
	assert.equal(r.body, "final answer");
	assert.equal(r.title, "pi ✓ done");
	assert.equal(r.errored, false);
});

test("extractSummary: body truncated at 120 chars with ellipsis", () => {
	const long = "x".repeat(200);
	const r = extractSummary([{ role: "assistant", content: [{ type: "text", text: long }] }]);
	assert.equal(r.body.length, 120);
	assert.ok(r.body.endsWith("..."));
});

test("extractSummary: stopReason error flags errored + error title", () => {
	const r = extractSummary([
		{ role: "assistant", stopReason: "error", content: [{ type: "text", text: "boom" }] },
	]);
	assert.equal(r.errored, true);
	assert.equal(r.title, "pi ✗ error");
});

test("extractSummary: any toolResult isError flags errored", () => {
	const r = extractSummary([
		{
			role: "assistant",
			content: [{ type: "text", text: "done anyway" }],
		},
		{ role: "toolResult", toolName: "bash", isError: true },
	]);
	assert.equal(r.errored, true);
	assert.equal(r.title, "pi ✗ error");
});

test("extractSummary: empty text falls back to tool-call inventory", () => {
	const r = extractSummary([
		{
			role: "assistant",
			content: [
				{ type: "toolCall", toolName: "read" },
				{ type: "toolCall", toolName: "bash" },
				{ type: "toolCall", toolName: "read" },
			],
		},
	]);
	assert.equal(r.body, "Ran read, bash");
});

test("extractSummary: empty everything falls back to Agent completed", () => {
	const r = extractSummary([{ role: "assistant", content: [] }]);
	assert.equal(r.body, "Agent completed");
});

// ── isActiveWindow ──────────────────────────────────────────────────────
// On CI (linux) osascript is absent → catch path → false (fail-open: send).
// On macOS this runs real AppleScript; assert only boolean type to stay
// environment-agnostic.
test("isActiveWindow returns boolean and never throws", () => {
	assert.equal(typeof isActiveWindow(), "boolean");
});

// ── module loads as pi extension ────────────────────────────────────────
test("default export is a function registering agent_end + notify-test", async () => {
	const { default: notifyExt } = await import("../index.js");
	assert.equal(typeof notifyExt, "function");

	const handlers: Record<string, unknown> = {};
	const commands: Record<string, unknown> = {};
	const fakePi = {
		on: (ev: string, fn: unknown) => {
			handlers[ev] = fn;
		},
		registerCommand: (name: string, def: unknown) => {
			commands[name] = def;
		},
	};
	(notifyExt as any)(fakePi);
	assert.ok(handlers["agent_end"]);
	assert.ok(commands["notify-test"]);
});
