import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://localhost:4200';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: [
    {
      command: 'npm run server:e2e',
      url: 'http://localhost:3001/api/health',
      env: {
        JWT_SECRET: 'e2e-only-secret-that-is-at-least-32-bytes-long',
        NODE_ENV: 'development',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm start -- --configuration e2e --port 4200',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
