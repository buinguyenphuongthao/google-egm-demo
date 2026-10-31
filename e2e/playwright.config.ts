import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:4173', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Health returns 503 until DynamoDB Local answers, so this also waits for the db.
      command: 'npm run dev -w api',
      cwd: '..',
      url: 'http://localhost:3001/api/health',
      reuseExistingServer: !isCI,
    },
    {
      command: 'npm run build -w web && npm run preview -w web -- --port 4173 --strictPort',
      cwd: '..',
      url: 'http://localhost:4173',
      reuseExistingServer: !isCI,
    },
  ],
});
