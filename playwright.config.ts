import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const projectDir = mkdtempSync(join(tmpdir(), 'sflow-e2e-'));
const port = Number(process.env.SFLOW_E2E_PORT ?? 4273);
const baseURL = `http://127.0.0.1:${port}`;

/**
 * Resolve a Chromium executable. `SFLOW_CHROMIUM_EXECUTABLE` wins; otherwise
 * use the newest cached Playwright Chromium build on this machine. This keeps
 * `pnpm test:e2e` working on offline or pre-provisioned machines whose cached
 * browser revision does not match the installed Playwright version.
 */
function findCachedChromium(): string | undefined {
  const override = process.env.SFLOW_CHROMIUM_EXECUTABLE;
  if (override) return override;

  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
        : join(homedir(), '.cache', 'ms-playwright'),
  ].filter((root): root is string => Boolean(root));

  const executablesIn = (buildDir: string): string[] => [
    join(
      buildDir,
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
    join(
      buildDir,
      'chrome-mac-x64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
    join(buildDir, 'chrome-linux', 'chrome'),
    join(buildDir, 'chrome-win', 'chrome.exe'),
    join(buildDir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
    join(buildDir, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
    join(buildDir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    join(buildDir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
  ];

  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;

    const builds = readdirSync(root)
      .filter((name) => name.startsWith('chromium-'))
      .sort((a, b) => Number(b.split('-')[1] ?? 0) - Number(a.split('-')[1] ?? 0));

    for (const build of builds) {
      for (const executable of executablesIn(join(root, build))) {
        if (existsSync(executable)) return executable;
      }
    }
  }

  return undefined;
}

const chromiumExecutable = findCachedChromium();

export default defineConfig({
  testDir: './tests/acceptance',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {},
  },
  webServer: {
    command: `pnpm -s sflow start --project "${projectDir}" --port ${port} --host 127.0.0.1 --no-open --credential e2e-password`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      SFLOW_E2E_PROJECT: projectDir,
    },
  },
});
