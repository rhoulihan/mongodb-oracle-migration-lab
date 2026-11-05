---
name: shutdown-lab
description: Shut the lab down after the session. Use when asked to "shut down the lab", "tear down", "/shutdown-lab", or to put the laptop away. Closes the console, deck and speaker-notes tabs, ends the tmux session and its terminal window, and stops the stack.
---

# Shut down the lab

One command: `./lab.sh shutdown`. Give it a 600000 ms Bash timeout.

| Ask | Command |
|---|---|
| Normal shutdown (volumes kept) | `./lab.sh shutdown` |
| Delete the data volumes too | `./lab.sh shutdown --wipe` |

What it does:
1. Chrome: closes the console, deck and speaker-view tabs. Other tabs stay.
2. tmux: ends session `lab`, and closes its Terminal window when that is the
   window's only tab. The Claude terminal is never closed.
3. Stack: stops every container (the d4 replicator too). `--wipe` also deletes
   the data volumes (the next launch resets them anyway).

## Rules

- `--wipe` deletes data: run it only when the presenter asks for it by name.
- Report in two lines at most: OK, or each FAIL line as printed.
- Never print or repeat any password.
