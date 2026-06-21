# pi-notify

A [pi](https://pi.dev) extension that fires a desktop notification when the agent finishes a turn. Good for long-running tasks where you want to tab away and come back when pi needs you.

## Behavior

- macOS: native Notification Center banner via `osascript`, with a summary of the agent's last response.
- Other platforms: OSC sequences to the terminal (kitty OSC 99, iTerm2/Ghostty/WezTerm OSC 9, Warp/other OSC 777) plus a bell.
- Skips notification if the terminal is the active (frontmost) window, so you're not spammed while watching pi.

Adds a `/notify-test` command to verify notifications work.

## Install

```bash
pi install git:github.com/keen99/pi-notify
```

## License

MIT
