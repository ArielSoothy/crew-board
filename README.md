# crew-board

Shows this session's Claude subagents and external helpers above the prompt, with their model, elapsed time, latest action, and stall warnings.

## Install

```text
/plugin install crew-board --marketplace ArielSoothy/crew-board
```

For a local folder, launch Claude Code with the plugin's absolute path:

```sh
CLAUDE_CODE_PLUGIN_DIRS=/absolute/path/to/crew-board claude
```

## Use cases

- Run a Claude Explore subagent alongside a Codex code review and see each worker's latest action without switching windows.
- Launch a script that runs `codex exec`, `agy --print`, or `claude -p`, then watch its observed log activity above the prompt.
- Notice a helper that has stopped writing output: the row shows a stall warning, macOS can notify you, and your next user message includes one stall note for an owned helper.

## Requirements and usage

Use macOS with `ps`, `lsof`, `/bin/sh`, and a writable `HOME`. Linux is **experimental, untested**; process discovery and environment visibility depend on the local tools and permissions. Native notifications require macOS `osascript` and are skipped on Linux.

The local engine declarations identify Claude Code 2.1.311. Use that version or a compatible newer engine; an exact minimum version is not established. External helper CLIs must already be installed and authenticated. This plugin installs none.

Start a conversation and launch helpers normally. Supported external commands are `codex exec`, `agy -p` / `agy --print`, and `claude -p` / `claude --print`. Claude subagents show tool steps; external helpers show observed actions from their output files. Logs are polled every five seconds and read once more at completion when ownership is proven. Finished rows dim for twenty seconds, then disappear. An idle board draws nothing; unavailable `ps` or `lsof` produces one dim diagnostic line.

## Scope and settings

By default, process binding requires an exact candidate `CLAUDE_CODE_SESSION_ID` match or a parent-PID chain reaching this Claude process. Timing and model are used only to choose among owned candidates. `CLAUDE_PID` hints and a tagged sibling are insufficient. Detached helpers whose ownership cannot be proven stay hidden. If process discovery fails, the launch row remains visible without reading unverified logs or cwd.

Configure these values under `pluginConfigs.crew-board`:

| Setting | Default | Effect |
| --- | --- | --- |
| `showElsewhere` | `false` | Opt in to other-window and untagged helpers, labeled as `◦` elsewhere rows and grouped by folder. Their stalls never add session-context notes. |
| `stallMinutes` | `8` | Warn after this long without new output; new output resets the warning. |
| `maxAgeSeconds` | `7200` | Expire workers without an observed completion and clean up older stall markers on each timer tick. |

The board shows up to six owned rows and four elsewhere rows, with overflow counts. Action counts measure recognized log entries, not percentage complete.

## What the hook does and changes

The plugin has one hook module, `hooks/register.tsx`. It:

- Watches `Bash` tool calls for commands that launch `codex exec`, `agy -p`/`--print`, or `claude -p`/`--print`, and adds a row for each launch.
- Watches `Agent` tool calls and agent spawns to add a row for each Claude subagent with its model, and counts that subagent's tool steps.
- Runs a timer every five seconds that checks the process list (`ps`, `lsof`) to find a launched helper's process, log file, and working folder, then reads that log for its latest action. Stall warnings can trigger one macOS notification per helper.
- Marks a row finished when the subagent's turn completes or its task notification arrives, and clears the board when the session ends.
- Draws the rows above the prompt box.

What the hook changes: the area above the prompt box (the rows), the plugin's own board state for the session, and the next user message's session context when an owned helper has stalled (one short stall note, once per helper). It also writes notification-deduplication marker files under `~/.claude/crew-board/`. It changes no tool calls, no tool results, no files of yours, and no settings.

## Programs the hook runs, and why

The hook runs local programs through Claude Code's process API only. Every command is one of these, with only the process id, helper name, or notification text filled in at run time:

| Command | Why |
| --- | --- |
| `/bin/sh -c 'echo $PPID'` | Learn this Claude Code process id when the host hides it. |
| `ps -Ao pid=,ppid=,etime=,command=` | List running processes to find helpers launched from this session. |
| `ps eww -o pid=,command= -p <pids>` | Read the candidate helpers' environment to match `CLAUDE_CODE_SESSION_ID`. Only that one variable is kept. |
| `lsof -a -p <pid> -d cwd -Fn` | Find a proven helper's working folder. |
| `lsof -p <pid> -a -d 1,2 -Fn` | Find a proven helper's output log file, so its latest action can be read. |
| `/bin/sh -c 'mkdir -p ... && set -C && : > .../stall-markers/<name>'` | Create an empty marker file under `~/.claude/crew-board/stall-markers/` so a stall is notified once. |
| `osascript -e 'display notification ...'` (macOS only) | Show one desktop notification when an owned helper stalls. |

Each program is required for the feature next to it; none installs anything, and a missing program only limits discovery.

## What the hook sends, and where

- To the macOS Notification Center, through `osascript`: one notification per stalled helper, containing the helper's name and how long it has been quiet.
- Into this Claude session's context, through the user-prompt hook's `additionalContext`: one short stall note per stalled owned helper, so Claude knows a helper has gone quiet.
- To disk: empty marker files under `~/.claude/crew-board/stall-markers/`.
- Nowhere else. The hook makes no network calls and sends nothing to any server.

The one piece of reflective code, `(globalThis as { process?: { pid?: number } }).process?.pid`, reads this Claude Code process's own id so that helpers can be matched to this session; when the host hides `process`, the `/bin/sh -c 'echo $PPID'` command above is used instead.

## Privacy

The plugin scans the machine's process list with `ps` and uses `lsof` for proven helpers' log paths and cwd. It reads those helper logs for progress, writes notification-deduplication markers under `~/.claude/crew-board/`, stores board state in Claude Code plugin state, and injects a stall note into the next user message's session context. With `showElsewhere=false`, other sessions' logs and cwd are not read; opting in expands that scope. Candidate environment queries retain only `CLAUDE_CODE_SESSION_ID`, never full environment strings. The plugin makes no network requests; the stall note follows normal Claude conversation data handling. See [Privacy](PRIVACY.md) for retention and deletion.

## Developing

The `.claude-plugin/types/` declarations are generated by Anthropic's Claude Code engine and ignored here. Regenerate them before type-checking or running development tests; runtime does not require these files. TypeScript 5.4 or newer is needed for type checking. The Claude Code 2.1.311 engine test runner can also run without the declarations.

Replace the example path with the plugin folder's absolute location and regenerate the declarations with this command, verified on Claude Code 2.1.311:

```sh
CLAUDE_CODE_PLUGIN_DIR_WATCH=1 CLAUDE_CODE_PLUGIN_DIRS=/absolute/path/to/crew-board claude --print /help --no-session-persistence
```

On Claude Code 2.1.311, `/help isn't available in this environment.` after loading is expected; the declaration files are still generated. This command uses a version-dependent watch switch. Redistribution permission for generated declarations has not been verified.

Run the local checks from the plugin root:

```sh
claude plugin test .
bunx --no-install tsc --noEmit -p .
claude plugin validate --profile directory --strict .
```

## Support

Report problems at https://github.com/ArielSoothy/crew-board/issues.

## License

MIT — Copyright (c) 2026 Ariel Soothy. See [LICENSE](LICENSE).
