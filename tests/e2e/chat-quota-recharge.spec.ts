import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getRecordedHostInvocations,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';

const MAIN_SESSION_KEY = 'agent:main:main';
const MAIN_WORKSPACE = '/workspace';
const DEFAULT_WORKSPACE = '~/.openclaw/workspace';
const QUOTA_ERROR =
  'Error: 403 - "403 token quota is not enough, please check your token quota or contact the administrator"';
const RECHARGE_URL = 'https://pay.example/recharge?key=sk-e2e-wallet';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(',')}}`;
}

async function installQuotaPromptFailureMocks(app: ElectronApplication) {
  await app.evaluate(async ({ app: _app }) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    type IpcInvokeHandler = (
      event: unknown,
      request: { id?: string; module?: string; action?: string; payload?: Record<string, unknown>; args?: unknown[] },
    ) => Promise<unknown>;
    const handlers = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, IpcInvokeHandler>;
    })._invokeHandlers;
    const originalHostInvoke = handlers?.get('host:invoke');
    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event: unknown, request: Parameters<IpcInvokeHandler>[1]) => {
      if (request?.module === 'chat' && request.action === 'sendAcpPrompt') {
        // 虾盘云 new-api 额度中间件的 raw 报错原文。
        return {
          id: request.id,
          ok: true,
          data: { success: false, error: 'Error: 403 - "403 token quota is not enough, please check your token quota or contact the administrator"' },
        };
      }
      return originalHostInvoke?.(event, request) ?? { id: request?.id, ok: true, data: {} };
    });

    // 记录而不是真开系统浏览器 —— Windows 上真开 Chrome 会让 crashpad
    // 锁住临时 homeDir，teardown 清理时 EBUSY。
    const { shell } = process.mainModule!.require('electron') as typeof import('electron');
    (shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal =
      async (url: string) => {
        const globals = globalThis as unknown as { __e2eOpenedExternalUrls?: string[] };
        globals.__e2eOpenedExternalUrls ??= [];
        globals.__e2eOpenedExternalUrls.push(url);
      };
  });
}

test.describe('U-ClawX chat quota recharge prompt', () => {
  test('quota failure shows a top-up banner and opens the wallet recharge page', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({
      skipSetup: true,
      // Windows 上 Electron 的 crashpad 会锁住 homeDir 里的
      // CrashpadMetrics-active.pma，teardown 清理临时目录时 EBUSY。
      additionalArgs: ['--disable-crash-reporter', '--disable-crashpad'],
    });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', gatewayReady: true, port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main', workspacePath: MAIN_WORKSPACE }],
            },
          },
        },
        hostApi: {
          ...Object.fromEntries([
            ['chat', 'loadAcpSession', { sessionKey: MAIN_SESSION_KEY, workspaceRoot: MAIN_WORKSPACE, cwd: MAIN_WORKSPACE }],
            ['chat', 'loadAcpSession', { sessionKey: MAIN_SESSION_KEY, workspaceRoot: MAIN_WORKSPACE, cwd: MAIN_WORKSPACE, createIfMissing: true }],
            ['chat', 'loadAcpSession', { sessionKey: MAIN_SESSION_KEY, workspaceRoot: DEFAULT_WORKSPACE, cwd: DEFAULT_WORKSPACE }],
            ['chat', 'loadAcpSession', { sessionKey: MAIN_SESSION_KEY, workspaceRoot: DEFAULT_WORKSPACE, cwd: DEFAULT_WORKSPACE, createIfMissing: true }],
            ['chat', 'loadAcpSession', { sessionKey: MAIN_SESSION_KEY, workspaceRoot: '/', cwd: '/' }],
            ['chat', 'loadAcpSession', { sessionKey: MAIN_SESSION_KEY, workspaceRoot: '/', cwd: '/', createIfMissing: true }],
          ].map((args) => [stableStringify(args), { success: true, generation: 1 }])),
          [stableStringify(['uclaw', 'rechargeUrl', null])]: { url: RECHARGE_URL },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main', workspace: MAIN_WORKSPACE, mainSessionKey: MAIN_SESSION_KEY }],
              },
            },
          },
        },
        recordHostInvocations: true,
      });
      await installQuotaPromptFailureMocks(app);

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('chat-page')).toBeVisible();
      await expect(page.getByTestId('acp-chat-empty-state')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('chat-composer-input').fill('hello');
      await page.getByTestId('chat-composer-send').click();

      // 横幅出现：友好标题 + 充值按钮，且不再甩 raw 英文报错。
      const banner = page.getByTestId('acp-error-banner');
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await expect(banner).toContainText('Insufficient balance');
      await expect(banner).not.toContainText('token quota is not enough');

      // 点「Top up」→ 走 typed IPC 拿带钱包 key 的充值页 → 系统浏览器打开。
      await page.getByTestId('acp-error-recharge').click();
      await expect.poll(async () => {
        const invocations = await getRecordedHostInvocations(app);
        return invocations.filter((invocation) =>
          invocation.module === 'uclaw' && invocation.action === 'rechargeUrl'
        ).length;
      }, { timeout: 15_000 }).toBeGreaterThan(0);

      // shell.openExternal 已在主进程被替换成记录器，验证打开的正是带 key 的充值页。
      await expect.poll(async () => {
        const opened = await app.evaluate(() => (
          (globalThis as unknown as { __e2eOpenedExternalUrls?: string[] }).__e2eOpenedExternalUrls ?? []
        ));
        return opened.filter((url) => url === RECHARGE_URL).length;
      }, { timeout: 15_000 }).toBeGreaterThan(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
