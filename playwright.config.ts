import { defineConfig } from '@playwright/test';

const devPort = process.env.PLAYWRIGHT_DEV_PORT || '4173';
const apiPort = process.env.PLAYWRIGHT_API_PORT || '8787';
const devUrl = `http://127.0.0.1:${devPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const taskDataDir = `.runtime/browser-tests/run-${process.pid}-${Date.now()}`;

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
    { name: 'development', use: { baseURL: devUrl } },
    { name: 'production', use: { baseURL: apiUrl } },
  ],
  webServer: [
    { command: `npm run dev -- --port ${devPort} --strictPort`, url: devUrl, reuseExistingServer: false,
      env: { SIM_API_URL: apiUrl } },
    { command: 'npm start', url: `${apiUrl}/api/health`, reuseExistingServer: false,
      env: { HOST: '127.0.0.1', PORT: apiPort, SIM_ACCESS_TOKEN: '', SIM_DATA_DIR: taskDataDir, SIM_MAX_TASKS: '1000' } },
  ],
});
