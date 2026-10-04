import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ESC = "\x1b";
const BEL = "\x07";

// --- Terminal detection ---

type Terminal = "ghostty" | "kitty" | "iterm2" | "wezterm" | "warp" | "terminal_app" | "unknown";

// Terminals that forward OSC notifications to OS Notification Center natively
const NATIVE_DESKTOP: Set<Terminal> = new Set(["ghostty", "kitty", "iterm2"]);

export function detectTerminal(): Terminal {
  const term = (process.env.TERM_PROGRAM || process.env.TERM || "").toLowerCase();
  if (term.includes("ghostty")) return "ghostty";
  if (term.includes("kitty")) return "kitty";
  if (term.includes("iterm")) return "iterm2";
  if (term.includes("wezterm")) return "wezterm";
  if (term.includes("warp")) return "warp";
  if (term.includes("apple_terminal") || term === "terminal") return "terminal_app";
  return "unknown";
}

// --- OSC sequences ---

export function osc9(message: string): string {
  return `${ESC}]9;${message}${BEL}`;
}

export function osc99(message: string): string {
  return `${ESC}]99;i=1:d=0:p=body;${message}${BEL}`;
}

export function osc777(message: string): string {
  return `${ESC}]777;notify;pi;${message}${BEL}`;
}

export function sendTerminalNotification(terminal: Terminal, title: string, body: string): void {
  // OSC 9 supports title; others just get the body
  const payload = terminal === "iterm2" || terminal === "ghostty" || terminal === "wezterm"
    ? `${title}: ${body}`
    : body;

  const sequences: string[] = [];
  switch (terminal) {
    case "kitty": sequences.push(osc99(payload)); break;
    case "ghostty":
    case "iterm2":
    case "wezterm": sequences.push(osc9(payload)); break;
    case "warp": sequences.push(osc777(payload)); break;
    default: sequences.push(osc777(payload)); break;
  }
  sequences.push(BEL);
  process.stdout.write(sequences.join(""));
}

function sendMacOSBanner(title: string, body: string): void {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    execFileSync(
      "osascript",
      ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
      { timeout: 3000, stdio: "ignore" }
    );
  } catch { /* silent */ }
}

/**
 * Check if any terminal window is the frontmost (active) window.
 * Uses the bundled window ID from TERM_PROGRAM_PID or falls back to
 * checking if the terminal process itself is frontmost.
 */
export function isActiveWindow(): boolean {
  try {
    // Get the frontmost app name
    const frontApp = execFileSync(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
      { timeout: 2000, encoding: "utf-8" }
    ).trim();

    // Map terminal program to app name
    const termProgram = (process.env.TERM_PROGRAM || "").toLowerCase();
    const appMap: Record<string, string> = {
      ghostty: "Ghostty",
      iterm2: "iTerm2",
      wezterm: "WezTerm",
      warp: "Warp",
      apple_terminal: "Terminal",
      terminal: "Terminal",
      kitty: "kitty",
    };
    const appName = appMap[termProgram] || "";

    return frontApp === appName;
  } catch {
    // Can't determine — be conservative, don't skip notification
    return false;
  }
}

// --- Extract summary from agent messages ---

interface TextContent { type: "text"; text: string }
interface ToolCall { type: "toolCall"; toolName: string; name?: string }
interface ToolResult { role: "toolResult"; toolName?: string; isError?: boolean }
type AnyMessage = { role: string; content?: any };

function isTextContent(c: any): c is TextContent {
  return c && c.type === "text" && typeof c.text === "string";
}

function isToolCall(c: any): c is ToolCall {
  return c && c.type === "toolCall" && typeof c.toolName === "string";
}

export function extractSummary(messages: any[]): { title: string; body: string; errored: boolean } {
  // Find the last assistant message
  const assistantMsgs = messages.filter((m: any) => m.role === "assistant");
  const lastAssistant = assistantMsgs[assistantMsgs.length - 1];

  if (!lastAssistant?.content) {
    return { title: "pi finished", body: "Agent completed", errored: false };
  }

  const content = lastAssistant.content as any[];

  // Check for errors in stop reason
  const errored = lastAssistant.stopReason === "error";

  // Get the last text block (the actual response)
  const textBlocks = content.filter(isTextContent);
  const lastText = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : "";

  // Count tool calls across this agent run
  const toolCalls = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (isToolCall(block)) toolCalls.add(block.toolName);
      }
    }
  }

  // Check for tool result errors
  let hadErrors = errored;
  for (const msg of messages) {
    if (msg.role === "toolResult" && msg.isError) hadErrors = true;
  }

  // Build a concise body from the last text
  // Take first line or first ~120 chars, whichever is shorter
  let body = lastText.trim();
  const firstNewline = body.indexOf("\n");
  if (firstNewline > 0) body = body.slice(0, firstNewline);
  if (body.length > 120) body = body.slice(0, 117) + "...";

  // If no text body, describe what happened
  if (!body) {
    if (toolCalls.size > 0) {
      body = `Ran ${[...toolCalls].join(", ")}`;
    } else {
      body = "Agent completed";
    }
  }

  // Title reflects status
  const title = hadErrors ? "pi ✗ error" : "pi ✓ done";

  return { title, body, errored: hadErrors };
}

// --- Main extension ---

export default function (pi: ExtensionAPI) {
  const terminal = detectTerminal();

  if (process.env.NOTIFY_DEBUG === "1") {
    try {
      writeFileSync(join(getAgentDir(), "notify-installed.json"), JSON.stringify({ terminal }) + "\n");
    } catch { /* debug marker best-effort */ }
  }

  pi.on("agent_end", async (event, _ctx) => {
    const { title, body, errored } = extractSummary(event.messages);

    if (process.env.NOTIFY_DEBUG === "1") {
      try {
        writeFileSync(
          join(getAgentDir(), "notify-agent-end.json"),
          JSON.stringify({ title, body, errored, messageCount: event.messages?.length ?? 0 }) + "\n",
        );
      } catch { /* debug marker best-effort */ }
    }

    // Skip notification if the terminal is the active (frontmost) window
    if (isActiveWindow()) return;

    if (process.platform === "darwin") {
      sendMacOSBanner(title, body);
    } else {
      sendTerminalNotification(terminal, title, body);
    }
  });

  pi.registerCommand("notify-test", {
    description: "Test notification",
    handler: async () => {
      const title = "pi ✓ done";
      const body = "Notification test successful";
      if (process.platform === "darwin") {
        sendMacOSBanner(title, body);
      } else {
        sendTerminalNotification(terminal, title, body);
      }
    },
  });
}
