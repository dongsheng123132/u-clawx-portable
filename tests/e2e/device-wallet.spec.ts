import {
  completeSetup,
  expect,
  getRecordedHostInvocations,
  installIpcMocks,
  test,
} from './fixtures/electron';
import { E2E_EXCLUSIVE_TAG } from './parallel-policy';

test.describe('Device wallet', { tag: E2E_EXCLUSIVE_TAG }, () => {
  test('shows the complete wallet card and confirms local-only removal through typed Host API', async ({ electronApp, page }) => {
    await completeSetup(page);
    await installIpcMocks(electronApp, {
      recordHostInvocations: true,
      hostApi: {
        '["uclaw","wallet",null]': {
          ready: true,
          apiKeyMasked: 'sk-demo...wallet',
          walletId: 'wal_e2e',
        },
        '["uclaw","balance",null]': {
          available: true,
          remainTokens: 500000,
          apiKeyMasked: 'sk-demo...wallet',
        },
        '["uclaw","apiKey",null]': { apiKey: 'sk-device-wallet-e2e' },
        '["uclaw","resetLocalWallet",null]': { success: true },
      },
    });

    await page.getByTestId('sidebar-nav-models').click();
    const panel = page.getByTestId('uclaw-cloud-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Device Wallet');
    await expect(page.getByTestId('uclaw-cloud-recharge-button')).toHaveText(/Top up/);
    await expect(page.getByTestId('uclaw-cloud-copy-api-key')).toHaveText(/Copy key/);
    await expect(page.getByTestId('uclaw-cloud-rotate-key')).toHaveText(/Rotate key/);
    await expect(page.getByTestId('uclaw-cloud-adopt-key')).toHaveText(/Use key/);

    await page.getByTestId('uclaw-cloud-reset-local-wallet').click();
    await expect(page.getByRole('dialog')).toContainText('Remove the wallet from this device?');
    await page.getByRole('button', { name: 'Remove locally' }).click();

    await expect.poll(async () => (
      (await getRecordedHostInvocations(electronApp))
        .some((entry) => entry.module === 'uclaw' && entry.action === 'resetLocalWallet')
    )).toBe(true);
  });
});
