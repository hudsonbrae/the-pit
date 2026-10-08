import { defineConfig, devices } from '@playwright/test';

// Builds the frontend, starts the real server with mock AI and mock market data,
// and drives it with real browsers.
const PORT = 8790;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm start',
    url: `http://localhost:${PORT}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { PORT: String(PORT), AI_PROVIDER: 'mock', MARKET_PROVIDER: 'mock', ANTHROPIC_API_KEY: '', FINNHUB_API_KEY: '', SUPABASE_URL: '', SUPABASE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' },
  },
});
