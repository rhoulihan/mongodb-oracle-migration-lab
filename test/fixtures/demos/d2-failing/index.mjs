// Fixture demo whose second step fails and third step throws.
export default {
  id: 'd2',
  title: 'Failing fixture demo',
  async setup() {},
  async reset() {},
  steps: [
    { id: 'fine', title: 'Fine', lane: 'console', async run() { return { ok: true, summary: 'fine' }; } },
    { id: 'bad', title: 'Bad', lane: 'console', async run() { return { ok: false, summary: 'results differ' }; } },
    { id: 'boom', title: 'Boom', lane: 'console', async run() { throw new Error('kaboom'); } },
  ],
};
