# pi-notify

![release-watch](https://github.com/keen99/pi-notify/actions/workflows/release-watch.yml/badge.svg)
[![pi tested](https://img.shields.io/github/v/release/keen99/pi-notify?label=pi%20tested%200.75.0%20%E2%86%92)](https://github.com/keen99/pi-notify/releases)

A [pi](https://pi.dev) extension that fires a desktop notification when the agent finishes a turn. Good for long-running tasks where you want to tab away and come back when pi needs you.

## Behavior

- macOS: native Notification Center banner via `osascript`, with a summary of the agent's last response.
- Other platforms: OSC sequences to the terminal (kitty OSC 99, iTerm2/Ghostty/WezTerm OSC 9, Warp/other OSC 777) plus a bell.
- Skips notification if the terminal is the active (frontmost) window, so you're not spammed while watching pi.

Adds a `/notify-test` command to verify notifications work.

## Install

```bash
# ssh
pi install git:git@github.com:keen99/pi-notify

# https
pi install git:github.com/keen99/pi-notify
```

## Development

```sh
npm run check       # typecheck + unit tests (pure notification logic, no osascript)
npm run test:matrix # deep smoke on every published pi release >= 0.75.0
```

The matrix boots each pinned pi release in RPC mode with the extension
loaded, drives a REAL agent turn through a local canned-SSE mock
provider, and asserts session_start terminal detection plus agent_end
notification summary on the real process. Pure logic (terminal
detection, OSC sequences, summary extraction) is covered by unit
tests. Cached installs live in `.matrix-cache/` and are reused across
runs; new pi releases are picked up automatically.

`PI_TEST_BIN` overrides the pi binary in the smoke test. `NOTIFY_DEBUG=1`
writes session_start/agent_end markers used by the smoke. Tests use
synthetic sessions in temp dirs; never touches real sessions. The
smoke never sends a real macOS banner — the agent_end marker is
written before the frontmost-window check, so no notification fires.

## License

MIT
