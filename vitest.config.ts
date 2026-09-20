import { defineConfig } from 'vitest/config'

/**
 * Node-only suite. The install suite mounts a real Cordis Loader tree and the
 * workflow suites drive subprocess-backed steps, so the default 5s timeout is
 * too tight on a cold Windows run.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
