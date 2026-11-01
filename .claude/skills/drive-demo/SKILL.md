---
name: drive-demo
description: Run one of the session's live demos (D1 to D7) for the presenter while they talk. Use when asked to "run demo D3", "drive D5", "/drive-demo d6", or to run the demos live. Tells the presenter which window to share, runs each step on the shared screen, and reports the result in a line or two.
---

# Drive a demo

The presenter is on stage. The audience sees one shared window at a time:
- **Console**: the instructor console in Chrome (http://127.0.0.1:3200).
- **Terminal**: the terminal attached to tmux session `lab`. It shows window `main`, or window `agents` for D7 (A on the left, B on the right). `drive term` switches the tmux window itself.

You never touch the screen directly. Every action is one `./lab.sh drive` command:

| Action | Command |
|---|---|
| Check readiness | `./lab.sh drive status` |
| List the steps | `./lab.sh drive plan dN` |
| Run a console step | `./lab.sh drive console dN STEP` |
| Show the rehearsal result | `./lab.sh drive console dN STEP --skip` |
| Start a step without waiting | `./lab.sh drive console dN STEP --nowait`, then `./lab.sh drive wait SEQ` |
| Type a terminal command | `./lab.sh drive term 'CMD'`, or `./lab.sh drive term A 'CMD'` / `B` for D7 |

Give every drive command a 600000 ms Bash timeout. Some steps run 1 to 3 minutes.

## Protocol

1. **Status.** Run `./lab.sh drive status`. On any FAIL line, say what it is in one line, then stop. Examples: "open the console in Chrome", or "run `tmux attach -t lab` in the terminal you share".
2. **Plan.** Run `./lab.sh drive plan dN`. Also read the demo's table in `docs/REHEARSAL.md` section 5 (the "Expect" column, and the notes under the table).
3. **Each step, in order:**
   1. **Window.** When the window changes from the last step, say one line: **Share the Console**, **Share the Terminal**, or for D7 **Share the Terminal (A and B)**. Wait for the presenter to say ready. Don't ask again while the window stays the same.
   2. **Run it.**
      - Console step: `drive console dN STEP`.
      - Terminal step: `drive term 'COMMAND'` with the exact command from the plan, then `drive console dN STEP`. That is **Mark done**, the console's check that the command worked. Run it without asking: the console is not on screen, the check still runs.
   3. **Report** in at most two lines: OK or FAIL, the key number from the output, and the matching "Expect"/"Say" line from the run sheet.
4. **On FAIL or a stall:**
   - Never debug or improvise on stage.
   - Offer `--skip` for that step. It shows the rehearsal recording. Remind the presenter to say so out loud.
   - For a terminal step that failed, offer the step's reset line from the run sheet.
   - Wait for the presenter's choice.
5. **After the last step:** if the run sheet says "Reset after", say the command and run it with `drive term` on the presenter's ok. D2: `./lab.sh reset d2`. D4: `./lab.sh reset d4`.

## Special cases (from the run sheet)

- **D3, terminal step 2:** read the `restore took N s` number to the presenter so they can say it live.
- **D4:** before step 1, remind the presenter to say it's a **stand-in for Oracle GoldenGate**.
- **D5, then D6:** after D5's last step, offer to start D6 step 1 with `--nowait` while the presenter talks slides 35 to 37. When they return to D6, run `drive wait SEQ` before step 2.
- **D6 step 3** runs about 80 to 90 s. Say "running, about 90 s" once, then wait.
- **Timings stay hidden until the equality step passes** (D5 step 5, D6 step 5). This is by design. Don't report a missing time as a fault.

## Style

- The presenter reads your reply between sentences. Short lines only.
- No narration, no tables.
- Never print or repeat any password.
