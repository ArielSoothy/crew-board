# Privacy

crew-board reads the machine's process list using ps to identify helper processes.
It queries environments only for candidate helpers, extracts only CLAUDE_CODE_SESSION_ID,
and never stores or logs full environment strings or other environment variables.
With showElsewhere=false, it reads logs and cwd only for helpers proven to belong to this session.
It reads helper output/log files for progress, including helpers started by session scripts.
It uses lsof to find their stdout/stderr log paths and working directory (cwd).
With showElsewhere=true, these reads also cover other-window and untagged local helpers.
It writes board state in Claude Code plugin state and stall markers under ~/.claude/crew-board/stall-markers/.
It adds one owned-helper stall note (model, elapsed silence, PID, log path) to the next user message's context.
The plugin itself sends nothing off the machine and makes no network requests.
The context note becomes part of the normal Claude conversation and follows its provider data handling.
Helper CLIs have their own provider connections and privacy practices.
Finished board rows expire after 20 seconds; session end clears the board.
Markers remain until removed manually or until a running board cleans markers older than maxAgeSeconds.
Delete the marker files in that folder with your file manager to clear them manually.
Removing markers permits a later notification for a still-stalled helper.
