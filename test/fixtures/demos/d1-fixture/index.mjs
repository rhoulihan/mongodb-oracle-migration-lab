// Fixture demo for the contract and runner tests (no lab needed). Its steps
// only succeed from the starting state, so running it twice proves that
// setup restores that state.
const state = { count: null };

/** @type {import('../../../../demos/contract.mjs').Demo} */
export default {
  id: 'd1',
  title: 'Fixture demo',
  async setup() { state.count = 0; },
  async reset() { state.count = null; },
  steps: [
    {
      id: 'start',
      title: 'Start from zero',
      lane: 'console',
      async run() {
        if (state.count !== 0) return { ok: false, summary: 'not at the starting state: run ./lab.sh reset d1' };
        state.count++;
        return { ok: true, summary: 'count is 1', panes: { left: state.count } };
      },
    },
    {
      id: 'type',
      title: 'Type a command',
      lane: 'terminal',
      command: './lab.sh exec mongo mongosh --eval "1"',
      async run(ctx) {
        state.count++;
        return { ok: state.count === 2, summary: `count is ${state.count}`, metrics: { ctx: typeof ctx } };
      },
      async verify() {
        return { ok: state.count === 2, summary: `saw count ${state.count}` };
      },
    },
  ],
};
