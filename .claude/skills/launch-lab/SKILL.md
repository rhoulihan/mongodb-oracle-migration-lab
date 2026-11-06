---
name: launch-lab
description: Set up the lab for the instructor before the session. Use when asked to "launch the lab", "set up the lab", "/launch-lab", or to get the laptop ready to present. Starts the stack, loads the data, stages tmux, and opens the console, speaker notes, terminal and deck windows on the right displays.
---

# Launch the lab

One command does it all: `./lab.sh launch` (macOS). Give it a 600000 ms Bash
timeout. Run it in the background (`run_in_background`) so you can relay the
S prompt below.

| Ask | Command |
|---|---|
| Normal launch | `./lab.sh launch` |
| Retry only the speaker notes | `./lab.sh launch --notes` |
| Re-check everything, change nothing | `./lab.sh launch --check` |

What it does, in order:
1. Stack: always a full reset: fresh volumes, Oracle and ORDS rebuilt, the
   order service back on the MongoDB source in normal mode, then `check`
   (four OK lines). Every demo starts clean.
2. Data: `generate` (loads the MongoDB source).
3. tmux: `drive stage` (session `lab`: window `main`, window `agents`).
4. Windows. Two displays: the console, the speaker notes and the tmux
   terminal go full size on the external display; the deck goes in its own
   window on the laptop display. The console and the deck are Chrome app
   windows (no address bar, no tabs). One display: everything on it.
   Old console, deck and speaker-view tabs are closed first, so a re-run
   leaves no duplicates.
5. Speaker notes: the deck opens them itself on load (`?notes=auto`), when
   Chrome allows the deck pop-ups (allowed once per laptop, from the address
   bar icon). If they don't open, it prints `INFO  the deck could not open the
   speaker notes`. **Tell the presenter at once: "Allow pop-ups for the deck,
   then click it and press S"**, then wait. It waits 60 s.
6. End: the speaker notes in front on the external display (the console
   behind them, the tmux window minimized until a demo needs it), the deck in
   focus on the laptop. The Claude terminal follows the speaker notes: over
   their current-slide preview, in front.

7. Checklist: every item checked live (stack, data counts, MIG empty,
   console, deck, notes, tmux, terminal profile). `[ ]` items print their fix.

## Report

- Show the **Launch checklist** block exactly as printed (the presenter
  verifies from it), then one line: ready for D1, or what is open.
- Other FAIL lines above the checklist: quote them as printed.
- On `FAIL  no speaker view`: "allow popups for the deck in Chrome, then I'll
  retry". Run `./lab.sh launch --notes` on their ok.
- On a `check` FAIL: Oracle may still be booting after the reset. Offer to run
  `./lab.sh check` again.
- Remind once: run `./lab.sh generate` again if the session starts more than
  about 3 hours after the launch (carts must still expire live in D2).

## Rules

- Never change macOS or Chrome settings yourself (Accessibility, popups).
  Tell the presenter what to change.
- Never print or repeat any password.
- Then demos run with the `drive-demo` skill.
