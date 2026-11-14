import { defineConfig, devices } from '@playwright/test';

// Uses the system Chrome so no browser download is needed; override with PW_CHANNEL (e.g. msedge).
// PW_EXECUTABLE_PATH instead points at a specific Chromium binary (CI or cloud sandboxes).
const executablePath = process.env.PW_EXECUTABLE_PATH;
const channel = executablePath ? undefined : (process.env.PW_CHANNEL ?? 'chrome');
const browser = { channel, launchOptions: { executablePath } };

export default defineConfig({
  testDir: './e2e',
  // One worker: the assistant specs call real AI providers, whose per-minute rate limits
  // are hit (429) when desktop and mobile chat in parallel.
  workers: 1,
  use: { baseURL: 'http://localhost:4173' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...browser } },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...browser } },
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
