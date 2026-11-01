// The shared gate for the integration files: they need the lab stack, so they
// run only with LAB_UP=1 (`./lab.sh up && ./lab.sh check` first). Without it,
// `npm test` reports every integration test as skipped and runs no hook, so
// nothing tries to reach a database. Integration files import describe, test,
// the hooks and expect from here instead of from vitest.
import * as v from 'vitest';

export const LAB_UP = Boolean(process.env.LAB_UP);
const noop = () => {};

export const describe = LAB_UP ? v.describe : v.describe.skip;
export const test = LAB_UP ? v.test : v.test.skip;
export const beforeAll = LAB_UP ? v.beforeAll : noop;
export const afterAll = LAB_UP ? v.afterAll : noop;
export const beforeEach = LAB_UP ? v.beforeEach : noop;
export const afterEach = LAB_UP ? v.afterEach : noop;
export const { expect } = v;
