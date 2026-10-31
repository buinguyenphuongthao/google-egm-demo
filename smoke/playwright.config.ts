import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.SMOKE_BASE_URL;
if (!baseURL) throw new Error('SMOKE_BASE_URL is required, e.g. https://dxxxx.cloudfront.net');
// The sites admit only the owner's IPs and requests carrying this token (CI runner IPs vary).
// Traces and reports record request headers, so CI uploads them encrypted, never in the clear.
const token = process.env.SMOKE_TOKEN;
if (process.env.CI && !token) throw new Error('SMOKE_TOKEN is required in CI');

export default defineConfig({
  testDir: './tests',
  retries: 1,
  timeout: 150_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    // Sent on every request the page makes; the SPA calls no third-party origins.
    extraHTTPHeaders: token ? { 'x-egm-smoke-token': token } : {},
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
