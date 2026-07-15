# Pi Auto Compact

Pi Auto Compact adds early, configurable context compaction to Pi and safely resumes unfinished tool-driven work after compaction.

It uses Pi's native compaction API and summary format. It does not replace Pi's summarizer, rewrite session history, or make a second model call outside Pi's compaction flow.

## What is missing in native Pi

Pi already protects sessions from context overflow. Native automatic compaction runs when estimated context usage exceeds `contextWindow - reserveTokens`, and Pi lets users configure the response reserve and the amount of recent context to keep.

That native behavior does not provide an early percentage trigger, a session-only toggle, an interactive settings panel, or an extension-managed continuation after compaction interrupts unfinished tool work. Pi Auto Compact fills those gaps while leaving native compaction available as a final safety net.

| Capability | Native Pi | Pi Auto Compact |
|---|---|---|
| Automatic trigger | Near the model limit, based on reserved response tokens | At a configurable percentage of context usage |
| Manual compaction | `/compact` | Unchanged |
| Summary generation | Pi's native compaction prompt and session format | Uses the same native flow with optional supplemental guidance |
| Session-only control | No dedicated toggle | `/auto-compact` |
| Interactive configuration | Settings file | `/auto-compact-config` TUI panel |
| Resume interrupted tool work | Native retry handles overflow recovery | Queues one configurable follow-up after successful early compaction |

## Install

```bash
pi install npm:@thunstack/auto-compact
```

Try it for one Pi run without installing:

```bash
pi -e npm:@thunstack/auto-compact
```

Install directly from GitHub:

```bash
pi install git:github.com/aashishd/pi-auto-compact-plugin
```

Pi packages execute with your full system permissions. Review third-party extension source before installing it.

## Commands

| Command | Purpose |
|---|---|
| `/auto-compact` | Toggle auto-compaction for the current session without changing the global startup default |
| `/auto-compact-config` | Open the settings panel in Pi's interactive terminal UI |

The settings command requires TUI mode. The compaction behavior itself also works in non-interactive modes.

## Settings and defaults

Global settings are stored in `$PI_CODING_AGENT_DIR/auto-compact.json`, or `~/.pi/agent/auto-compact.json` when that environment variable is unset. The file is created only after a setting is saved. Until then, in-memory defaults are used.

| Setting | Default | Scope | Accepted values | Purpose |
|---|---:|---|---|---|
| `enabledAtSessionStart` | `true` | Global startup default | `true` or `false` | Sets whether new and forked sessions start with the extension active |
| Active in current session | Startup default | Current session | `true` or `false` | Controlled by `/auto-compact`; restored on reload or resume and never written to global config |
| `thresholdPercent` | `60` | Global | Integer `1` through `99` | Compacts only when context usage is strictly greater than this percentage |
| `autoResume` | `true` | Global | `true` or `false` | Resumes only when compaction interrupted a non-terminating tool-driven turn |
| `resumptionInstruction` | `Continue the unfinished work from the compaction summary. Preserve prior decisions, avoid repeating completed work, and proceed with the next pending step.` | Global | Any string | Follow-up user message queued once after successful interrupted compaction; blank disables the follow-up |
| `waitForTurnEnd` | `true` | Fixed safety setting | `true` only | Defers compaction to Pi's `turn_end` boundary; `false` is rejected because Pi does not expose a safe reliable live boundary |
| `additionalCompactionInstruction` | `Preserve unfinished work and exact details required to resume safely.` | Global | Any string | Appends guidance to Pi's native compaction prompt; blank uses only the native prompt |

Equivalent config file:

```json
{
  "version": 1,
  "enabledAtSessionStart": true,
  "thresholdPercent": 60,
  "autoResume": true,
  "resumptionInstruction": "Continue the unfinished work from the compaction summary. Preserve prior decisions, avoid repeating completed work, and proceed with the next pending step.",
  "waitForTurnEnd": true,
  "additionalCompactionInstruction": "Preserve unfinished work and exact details required to resume safely."
}
```

Use `/auto-compact-config` instead of editing the file when TUI mode is available. Saves are written atomically with owner-only permissions.

## How it behaves

1. After each completed Pi turn, the extension reads the active model's context usage.
2. When usage crosses above the configured threshold, it requests Pi's native compaction flow.
3. The detector disarms until usage returns to or below the threshold, preventing repeated compactions at the same usage level.
4. If that compaction interrupted a non-terminating tool-driven turn, the extension queues the resumption instruction exactly once.
5. Session replacement or reload invalidates stale completion callbacks, so old compactions cannot resume a new runtime.

A tool result that explicitly requests termination is respected, including mixed tool batches. Final assistant responses are never auto-resumed.

### Interaction with native auto-compaction

This extension does not disable Pi's built-in threshold or overflow recovery. With the default 60% trigger, it normally compacts before Pi reaches its native reserve boundary. If native compaction runs first, Pi handles that event normally and this extension does not add its auto-resume message.

Pi's native compaction settings still control how much recent context is kept and how much response space is reserved.

## Uninstall

```bash
pi remove npm:@thunstack/auto-compact
```

Removing the package does not delete `~/.pi/agent/auto-compact.json`. Delete that optional settings file separately if you no longer want it.

## Development

```bash
npm install
npm run check
```

`npm run check` type-checks the extension, runs the behavior tests, and previews the npm tarball. Publishing also runs the same checks through `prepublishOnly`.

## License

MIT
