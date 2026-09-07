import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The fixture server binds a real port; running files in one process keeps
    // port use and temp databases predictable.
    pool: 'forks',
    // Set before any module reads it, so the per-host politeness delay does
    // not add seconds to every fixture request.
    env: { HOST_MIN_GAP_MS: '0', NO_COLOR: '1' },
  },
});
