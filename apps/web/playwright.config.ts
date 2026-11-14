import { defineConfig, devices } from '@playwright/test';

// Uses the system Chrome so no browser download is needed; override with PW_CHANNEL (e.g. msedge).
const channel = process.env.PW_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:4173' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel } },
  ],
  webServer: [
    // No watch mode and no reuse: always test the current code, and leave no orphan process.
    {
      command: 'node --env-file-if-exists=.env --import tsx src/server.ts',
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: false,
      cwd: '../api',
    },
    {
      command: 'pnpm build && pnpm preview --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
    },
  ],
});
