import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Integration tests talk to the local Supabase stack: allow for a cold start.
  test: { setupFiles: ['./test/setup.ts'], testTimeout: 15_000 },
});
