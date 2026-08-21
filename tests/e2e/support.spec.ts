import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('Manual technical support', () => {
  test('opens the support page and keeps feedback explicitly user-entered', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(({ shell }) => {
        const globals = globalThis as unknown as { __supportOpenExternalUrls?: string[] };
        globals.__supportOpenExternalUrls = [];
        shell.openExternal = async (url: string) => {
          globals.__supportOpenExternalUrls?.push(url);
        };
      });

      const page = await getStableWindow(app);
      await page.getByTestId('sidebar-nav-support').click();

      const supportPage = page.getByTestId('support-page');
      await expect(supportPage).toBeVisible();
      await expect(page.getByTestId('support-wechat-qr')).toBeVisible();
      await expect(supportPage).toContainText('hecare888');
      await expect(supportPage).toContainText('hefangsheng@gmail.com');
      await expect(supportPage).toContainText('never attached automatically');

      await page.getByTestId('support-feedback-input').fill('The wallet page should explain a failed connection.');
      await expect(page.getByTestId('support-send-feedback')).toBeEnabled();
      await expect(page.getByTestId('support-feedback-input')).toHaveValue(
        'The wallet page should explain a failed connection.',
      );

      await page.getByTestId('support-send-feedback').click();
      await expect.poll(async () => app.evaluate(() => (
        (globalThis as unknown as { __supportOpenExternalUrls?: string[] }).__supportOpenExternalUrls ?? []
      ))).toHaveLength(1);

      const [mailto] = await app.evaluate(() => (
        (globalThis as unknown as { __supportOpenExternalUrls?: string[] }).__supportOpenExternalUrls ?? []
      ));
      expect(mailto).toMatch(/^mailto:hefangsheng@gmail\.com\?/);
      expect(decodeURIComponent(mailto ?? '')).toContain('The wallet page should explain a failed connection.');
      expect(decodeURIComponent(mailto ?? '')).toContain('U-Claw');
      expect(mailto).not.toContain('sk-');

      await page.getByTestId('sidebar-nav-settings').click();
      await expect(page.getByTestId('settings-page')).toBeVisible();
      await app.evaluate(({ BrowserWindow, Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('technical-support');
        item?.click(undefined, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0], undefined);
      });
      await expect(page.getByTestId('support-page')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
