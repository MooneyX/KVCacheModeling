import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/integration',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true,
  },
  projects: [
    { name: 'development', use: { baseURL: 'http://127.0.0.1:4173' } },
    { name: 'production', use: { baseURL: 'http://127.0.0.1:8787' } },
  ],
  webServer: [
    { command: 'npm run dev -- --port 4173 --strictPort', url: 'http://127.0.0.1:4173', reuseExistingServer: false },
    { command: 'npm start', url: 'http://127.0.0.1:8787/api/health', reuseExistingServer: false,
      env: { HOST: '127.0.0.1', PORT: '8787', SIM_ACCESS_TOKEN: '', SIM_DATA_DIR: '.runtime/browser-tests', SIM_MAX_TASKS: '1000' } },
  ],
});
