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
| Speaker notes to the laptop (demo start) / back, deck in focus (demo end) | `./lab.sh drive notes laptop` / `./lab.sh drive notes external` |
| Type a terminal command | `./lab.sh drive term 'CMD'`, or `./lab.sh drive term A 'CMD'` / `B` for D7 |
| Bring a window to the front (macOS); `home` also puts Claude's terminal over the notes' slide preview | `./lab.sh drive focus console` / `./lab.sh drive focus term`; `./lab.sh drive focus home` returns to Claude's terminal |

Give every drive command a 600000 ms Bash timeout. Some steps run 1 to 3 minutes.

## Protocol

1. **Status.** Run `./lab.sh drive status`. On any FAIL line, say what it is in one line, then stop. Examples: "open the console in Chrome", or "run `tmux attach -t lab` in the terminal you share".
2. **Plan.** Run `./lab.sh drive plan dN`. Also read the demo's table in `docs/REHEARSAL.md` section 5 (the "Expect" column, and the notes under the table).
3. **Notes to the laptop, then wait.** Before step 1, run `./lab.sh drive notes laptop` (the speaker notes move to the laptop display), then `./lab.sh drive focus console` or `term`, whichever window step 1 uses, then `./lab.sh drive focus home`. Reply one line: "Share the external display, then say next." **Don't run step 1 until the presenter says next.**
4. **Each step, in order:**
   1. **Window.** When the window changes from the last step, run `./lab.sh drive focus console` or `./lab.sh drive focus term` (D7: `term`). It brings that window to the front of the shared screen. Focus first, before any `drive wait` or long step, so the window switches the moment the presenter says next. The presenter doesn't switch windows. Don't wait for "ready". If focus prints FAIL, fall back: say **Share the Console** or **Share the Terminal** and wait for ready. For a terminal step's Mark done, don't focus the console.
   2a. **Return.** After the step's commands finish (and after Mark done), always run `./lab.sh drive focus home` to give focus back to the terminal running this Claude session, then report.
   2. **Run it.**
      - Console step: `drive console dN STEP`.
      - Terminal step: `drive term 'COMMAND'` with the exact command from the plan, then `drive console dN STEP`. That is **Mark done**, the console's check that the command worked. Run it without asking: the console is not on screen, the check still runs.
   3. **Report** in at most two lines: OK or FAIL, the key number from the output, and the matching "Expect"/"Say" line from the run sheet.
5. **On FAIL or a stall:**
   - Never debug or improvise on stage.
   - Offer `--skip` for that step. It shows the rehearsal recording. Remind the presenter to say so out loud.
   - For a terminal step that failed, offer the step's reset line from the run sheet.
   - Wait for the presenter's choice.
6. **After the last step:** if the run sheet says "Reset after", say the command and run it with `drive term` on the presenter's ok. D2: `./lab.sh reset d2`. D4: `./lab.sh reset d4`.
7. **The last "next" (back to the slides).** When the presenter says next after the last step's report (and after any reset), run `./lab.sh drive notes external`: the notes go back in front on the external display, tmux is minimized, and the deck takes the focus on the laptop. Don't run `drive focus home` after it: the deck keeps the focus. Reply one line: "Back to the slides: share the laptop."

## Special cases (from the run sheet)

- **D3, terminal step 2:** read the `restore took N s` number to the presenter so they can say it live.
- **D4:** before step 1, remind the presenter to say it's a **stand-in for Oracle GoldenGate**.
- **D5, then D6:** after D5's last step, offer to start D6 step 1 with `--nowait` while the presenter talks slides 35 to 37; start it before `drive notes external`. When they return to D6, run `drive notes laptop`, then `drive wait SEQ` before step 2.
- **D6 step 3** runs about 35 s on the Mac. Say "running, about 35 s" once, then wait.
- **Timings stay hidden until the equality step passes** (D5 step 5, D6 step 5). This is by design. Don't report a missing time as a fault.

## Style

- The presenter reads your reply between sentences. Short lines only.
- No narration, no tables.
- Never print or repeat any password.
