import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Project credential').fill(PASSWORD);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByTestId('global-toolbar')).toBeVisible();
}

test('runs a direct command in an authenticated terminal and shows the history boundary', async ({
  page,
}) => {
  await signIn(page);
  await page.getByTestId('nav-terminal').click();

  const surface = page.getByTestId('terminal-surface');
  await expect(surface).toBeVisible();

  const notice = page.getByTestId('terminal-out-of-band-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('outside');
  await expect(notice).toContainText(/Run, Task, and Provenance/);
  await expect(notice).toContainText(/not recorded/);

  await expect(page.getByTestId('terminal-status')).toHaveText(/Connected/);
  await expect(surface.locator('.xterm')).toBeVisible();

  // The command output differs from the typed text, so a local echo alone
  // cannot satisfy the assertion: the Server shell must have executed it.
  await surface.locator('.xterm').click();
  await page.keyboard.type('echo server-$(printf output)');
  await page.keyboard.press('Enter');
  await expect(surface.locator('.xterm-rows')).toContainText('server-output');

  // Proves the shell's working directory is the Project root, not the Server's
  // process directory.
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await expect(surface.locator('.xterm-rows')).toContainText(/sflow-e2e-/);

  // An exited shell is recoverable from the same surface.
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('terminal-status')).toHaveText(/Session ended/);
  await page.getByRole('button', { name: 'Restart terminal' }).click();
  await expect(page.getByTestId('terminal-status')).toHaveText(/Connected/);

  await surface.locator('.xterm').click();
  await page.keyboard.type('echo restarted-ok');
  await page.keyboard.press('Enter');
  await expect(surface.locator('.xterm-rows')).toContainText('restarted-ok');
});

test('the terminal surface is not mounted outside the Terminal section', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('terminal-surface')).toHaveCount(0);

  await page.getByTestId('nav-terminal').click();
  await expect(page.getByTestId('terminal-surface')).toBeVisible();

  await page.getByTestId('nav-workflows').click();
  await expect(page.getByTestId('terminal-surface')).toHaveCount(0);
});
