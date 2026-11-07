---
name: drive-demo
description: Run the session's live demos (D1 to D7) for the presenter while they talk. Use when asked to "run demo D3", "drive D5", "/drive-demo d6", "watch the demos", or to run the demos live. The presenter's clicker drives each demo through the autopilot; Claude watches its log and relays each result in a line or two, or drives by hand when the autopilot is off.
---

# Drive a demo

The presenter shares one display for the whole session (the external, in the room or in Zoom) and never switches shares. The deck, the console and the tmux terminal all live on it; the speaker notes stay on the laptop. The audience sees one window at a time:
- **Deck**: between demos, in front with the focus.
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
| Demo start / demo end (deck back in front, in focus) | `./lab.sh drive demo` / `./lab.sh drive slides` |
| The clicker drives the demos | `./lab.sh drive autopilot start\|stop\|status` (log: `.lab/drive/autopilot.log`) |
| Type a terminal command | `./lab.sh drive term 'CMD'`, or `./lab.sh drive term A 'CMD'` / `B` for D7 |
| Bring a window to the front (macOS); `home` also puts Claude's terminal over the notes' slide preview | `./lab.sh drive focus console` / `./lab.sh drive focus term`; `./lab.sh drive focus home` returns to Claude's terminal |

Give every drive command a 600000 ms Bash timeout. Some steps run 1 to 3 minutes.

## Autopilot (the default): the clicker drives the demo

`./lab.sh launch` starts the autopilot. The presenter's next (Right arrow) runs the demo, so the presenter never waits on you:
- On a demo slide (D1 to D7), next brings up the demo: step 1's window comes to the front of the shared display.
- Each next after that runs one step: the console or the terminal comes to the front and the step runs (terminal steps are typed, then marked done).
- After a FAIL, the next press shows that step's rehearsal result instead.
- The press after the last step brings the deck back, in front with the focus. D2 and D4 reset in the background. D5's end starts D6 step 1 in the background.
- Presses while a step runs are dropped.
- During a demo the keyboard focus sits on the speaker notes (laptop); they send each press. If presses stop working, the presenter clicks the speaker notes once.

Your job: watch and relay.
1. **Check.** Run `./lab.sh drive autopilot status`. If it's off, run `./lab.sh drive autopilot start`.
2. **Watch.** Start a Monitor on `tail -n 0 -F .lab/drive/autopilot.log` (persistent). Each line is one event.
3. **Relay** each line in at most two lines: OK or FAIL, the key number, and the matching "Expect"/"Say" line from `docs/REHEARSAL.md` section 5.
   - `dN up`: one line, "DN is up." Add the special case below if there is one.
   - A FAIL line: "Next press shows the rehearsal result: say so out loud." Never debug on stage.
   - `done: deck in front`: "Back to the slides."
4. Don't run any drive command while the autopilot runs a demo, unless the presenter asks you to.

## Manual (the autopilot is off, or the presenter asks for it)

1. **Status.** Run `./lab.sh drive status`. On any FAIL line, say what it is in one line, then stop. Examples: "open the console in Chrome", or "run `tmux attach -t lab` in the terminal you share".
2. **Plan.** Run `./lab.sh drive plan dN`. Also read the demo's table in `docs/REHEARSAL.md` section 5 (the "Expect" column, and the notes under the table).
3. **Demo start, then wait.** Before step 1, run `./lab.sh drive demo`, then `./lab.sh drive focus console` or `term`, whichever window step 1 uses, then `./lab.sh drive focus home`. Reply one line: "DN is up. Say next." **Don't run step 1 until the presenter says next.**
4. **Each step, in order:**
   1. **Window.** When the window changes from the last step, run `./lab.sh drive focus console` or `./lab.sh drive focus term` (D7: `term`). Focus first, before any `drive wait` or long step. If focus prints FAIL, say **Bring up the Console** or **Bring up the Terminal** and wait for ready. For a terminal step's Mark done, don't focus the console.
   2. **Run it.**
      - Console step: `drive console dN STEP`.
      - Terminal step: `drive term 'COMMAND'` with the exact command from the plan (D7: `drive term A|B`), then `drive console dN STEP`. That is **Mark done**. Run it without asking.
   3. **Return.** Run `./lab.sh drive focus home`, then report in at most two lines: OK or FAIL, the key number, and the matching "Expect"/"Say" line.
5. **On FAIL or a stall:** never debug on stage. Offer `--skip` for that step (the rehearsal recording; the presenter says so out loud), or for a terminal step its reset line from the run sheet. Wait for the choice.
6. **After the last step:** if the run sheet says "Reset after", say the command and run it on the presenter's ok. D2: `./lab.sh reset d2`. D4: `./lab.sh reset d4`.
7. **The last "next".** Run `./lab.sh drive slides` (the deck back in front, with the focus). Don't run `drive focus home` after it. Reply one line: "Back to the slides."

## Special cases (from the run sheet)

- **D3, terminal step 2:** read the `restore took N s` number to the presenter so they can say it live (the autopilot logs it on its own line).
- **D4:** before step 1, remind the presenter to say it's a **stand-in for Oracle GoldenGate**.
- **D5, then D6:** the autopilot starts D6 step 1 in the background when D5 ends, while the presenter talks slides 36 to 38; D6's first step waits for it. Manual: offer to start it with `--nowait` before `drive slides`; back at D6, run `drive demo` and `drive focus console`, then `drive wait SEQ` before step 2.
- **D7 step 7 (Compass):** Compass comes to the front with the order's filter on the clipboard. Relay: "In Compass: mig, orders_dv, paste, Find." The presenter's clicks there take the keyboard, so add: "Then click the speaker notes to go on."
- **D6 step 3** runs about 35 s on the Mac. Say "running, about 35 s" once, then wait.
- **Timings stay hidden until the equality step passes** (D5 step 5, D6 step 5). This is by design. Don't report a missing time as a fault.

## Style

- The presenter reads your reply between sentences. Short lines only.
- No narration, no tables.
- Never print or repeat any password.
