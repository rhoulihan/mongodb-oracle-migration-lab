// Test files run one at a time: the integration files share one live Oracle
// schema (target-prep.test.mjs drops and recreates the MIG collections), so
// they must never race in parallel workers. Discovery stays the vitest default.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
