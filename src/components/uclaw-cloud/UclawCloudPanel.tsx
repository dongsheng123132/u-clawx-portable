import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ClipboardPaste, Copy, ExternalLink, KeyRound, RefreshCw, RotateCw, Trash2, WalletCards } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { hostApi } from '@/lib/host-api';
import { useProviderStore } from '@/stores/providers';
import { useUclawCloudStore } from '@/stores/uclaw-cloud';

/**
 * 虾粮中心面板：余额 + 一键充值 + 设备钱包密钥管理。
 *
 * 没有登录、没有账号状态 —— 钱包没就绪时只提示「联网后自动获取」，
 * 不拦用户做别的事。
 */
function formatTokens(value: number | undefined, locale: string, unit: string, unavailable: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return unavailable;
  return `${value.toLocaleString(locale)} ${unit}`;
}

export function UclawCloudPanel() {
  const { t, i18n } = useTranslation('settings');
  const wallet = useUclawCloudStore((s) => s.wallet);
  const balance = useUclawCloudStore((s) => s.balance);
  const refresh = useUclawCloudStore((s) => s.refresh);
  const refreshBalance = useUclawCloudStore((s) => s.refreshBalance);
  const getRechargeUrl = useUclawCloudStore((s) => s.getRechargeUrl);
  const getApiKey = useUclawCloudStore((s) => s.getApiKey);
  const rotateKey = useUclawCloudStore((s) => s.rotateKey);
  const adoptKey = useUclawCloudStore((s) => s.adoptKey);
  const importLegacyWallet = useUclawCloudStore((s) => s.importLegacyWallet);
  const createFreshWallet = useUclawCloudStore((s) => s.createFreshWallet);
  const resetLocalWallet = useUclawCloudStore((s) => s.resetLocalWallet);
  const refreshProviderSnapshot = useProviderStore((s) => s.refreshProviderSnapshot);

  const [refreshing, setRefreshing] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [legacyImportConfirmOpen, setLegacyImportConfirmOpen] = useState(false);
  const [legacyFreshConfirmOpen, setLegacyFreshConfirmOpen] = useState(false);
  const [adoptValue, setAdoptValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const legacyCandidate = wallet?.legacyWallet?.status === 'candidate'
    ? wallet.legacyWallet
    : undefined;
  const apiKeyMasked = balance?.apiKeyMasked
    || wallet?.apiKeyMasked
    || legacyCandidate?.apiKeyMasked
    || '-';
  const balanceLabel = balance?.available
    ? formatTokens(
        balance.remainTokens,
        i18n.resolvedLanguage || i18n.language,
        t('deviceWallet.tokenUnit'),
        t('deviceWallet.unavailable'),
      )
    : t('deviceWallet.unavailable');
  const walletStatusLabel = legacyCandidate
    ? t('deviceWallet.pendingImport')
    : balanceLabel;
  const legacyBalanceLabel = formatTokens(
    wallet?.legacyWallet?.remainTokens,
    i18n.resolvedLanguage || i18n.language,
    t('deviceWallet.tokenUnit'),
    t('deviceWallet.unavailable'),
  );

  function translatedError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const keyByCode: Record<string, string> = {
      DEVICE_WALLET_UNKNOWN_PENDING: 'deviceWallet.errors.unknownPending',
      DEVICE_WALLET_PENDING_NOT_SETTLED: 'deviceWallet.errors.pendingNotSettled',
      DEVICE_WALLET_PENDING_SETTLED: 'deviceWallet.errors.pendingSettled',
      DEVICE_WALLET_RESET_FAILED: 'deviceWallet.errors.resetFailed',
      DEVICE_WALLET_LEGACY_PENDING: 'deviceWallet.errors.legacyPending',
      DEVICE_WALLET_LEGACY_INVALID: 'deviceWallet.errors.legacyInvalid',
      DEVICE_WALLET_LEGACY_NOT_FOUND: 'deviceWallet.errors.legacyNotFound',
      DEVICE_WALLET_LEGACY_IMPORT_FAILED: 'deviceWallet.errors.legacyImportFailed',
      DEVICE_WALLET_CREATE_FRESH_FAILED: 'deviceWallet.errors.createFreshFailed',
    };
    return keyByCode[message] ? t(keyByCode[message]) : message;
  }

  async function guarded(action: () => Promise<string>, fallback: string) {
    setBusy(true);
    try {
      const message = await action();
      // 钱包动作会创建、更新或删除同一把受管 Provider。同步刷新两块 UI，
      // 避免上方钱包已就绪、下方仍显示“未配置提供商”的陈旧快照。
      await refreshProviderSnapshot();
      toast.success(message || fallback);
    } catch (error) {
      toast.error(translatedError(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshBalance();
      toast.success(t('deviceWallet.balanceRefreshed'));
    } catch (error) {
      toast.error(translatedError(error));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleRecharge() {
    try {
      await hostApi.shell.openExternal(await getRechargeUrl());
    } catch (error) {
      toast.error(translatedError(error));
    }
  }

  // 有些环境里右键菜单和 Ctrl+V 都不好使（Electron 输入框的粘贴依赖应用菜单
  // 的加速键），给个按钮直接从剪贴板读，是最不会出错的一条路。
  async function handlePaste() {
    try {
      const text = (await navigator.clipboard.readText())?.trim();
      if (!text) throw new Error(t('deviceWallet.clipboardEmpty'));
      setAdoptValue(text);
    } catch {
      toast.error(t('deviceWallet.clipboardUnavailable'));
    }
  }

  async function handleCopyKey() {
    try {
      const key = await getApiKey();
      if (!key) throw new Error(t('deviceWallet.noWalletCopy'));
      await navigator.clipboard.writeText(key);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 1500);
      toast.success(t('deviceWallet.keyCopied'));
    } catch (error) {
      toast.error(translatedError(error));
    }
  }

  async function handlePrepareReset() {
    try {
      const key = await getApiKey();
      if (!key) throw new Error(t('deviceWallet.noWalletCopy'));
      await navigator.clipboard.writeText(key);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 1500);
      toast.success(t('deviceWallet.keyCopiedBeforeRemove'));
      setResetConfirmOpen(true);
    } catch (error) {
      toast.error(translatedError(error));
    }
  }

  return (
    <Card
      data-testid="uclaw-cloud-panel"
      className="overflow-hidden rounded-2xl border border-black/10 bg-transparent shadow-none dark:border-white/10"
    >
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <WalletCards className="h-5 w-5 shrink-0 text-primary" />
            <span className="text-[15px] font-semibold text-foreground">{t('deviceWallet.title')}</span>
            <span
              data-testid="uclaw-cloud-key"
              className="truncate font-mono text-[13px] text-muted-foreground"
            >
              {apiKeyMasked}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span data-testid="uclaw-cloud-balance" className="text-[14px] font-medium text-foreground">
              {walletStatusLabel}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-3"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5${refreshing ? ' animate-spin' : ''}`} />
              {t('deviceWallet.refresh')}
            </Button>
          </div>
        </div>

        {wallet && !wallet.ready && wallet.legacyWallet?.status === 'candidate' && (
          <div
            data-testid="uclaw-cloud-legacy-wallet"
            className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4"
          >
            <div className="space-y-1">
              <p className="text-[13px] font-semibold text-foreground">
                {t('deviceWallet.legacy.title')}
              </p>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {t('deviceWallet.legacy.found', {
                  key: wallet.legacyWallet.apiKeyMasked || '-',
                  balance: legacyBalanceLabel,
                })}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                data-testid="uclaw-cloud-import-legacy-wallet"
                className="h-9 flex-1 rounded-lg"
                disabled={busy}
                onClick={() => setLegacyImportConfirmOpen(true)}
              >
                {t('deviceWallet.legacy.import')}
              </Button>
              <Button
                type="button"
                data-testid="uclaw-cloud-create-fresh-wallet"
                variant="outline"
                className="h-9 flex-1 rounded-lg"
                disabled={busy}
                onClick={() => setLegacyFreshConfirmOpen(true)}
              >
                {t('deviceWallet.legacy.createFresh')}
              </Button>
            </div>
          </div>
        )}

        {wallet && !wallet.ready && wallet.legacyWallet?.status === 'blocked' && (
          <p
            data-testid="uclaw-cloud-legacy-wallet-blocked"
            className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-700 dark:text-red-400"
          >
            {t(wallet.legacyWallet.reason === 'pending'
              ? 'deviceWallet.legacy.pending'
              : 'deviceWallet.legacy.invalid')}
          </p>
        )}

        {wallet && !wallet.ready && !wallet.legacyWallet && (
          <p
            data-testid="uclaw-cloud-no-wallet"
            className="rounded-lg bg-black/5 px-3 py-2 text-[12px] text-muted-foreground dark:bg-white/5"
          >
            {t('deviceWallet.noWallet')}
          </p>
        )}

        <Button
          type="button"
          data-testid="uclaw-cloud-recharge-button"
          className="h-11 w-full rounded-xl"
          onClick={() => void handleRecharge()}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          {t('deviceWallet.recharge')}
        </Button>

        <div className="space-y-3 border-t border-black/10 pt-4 dark:border-white/10">
          <span className="text-[13px] font-semibold text-foreground">{t('deviceWallet.management')}</span>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {t('deviceWallet.backupPrefix')}
            <strong className="font-medium text-foreground">{t('deviceWallet.backupStrong')}</strong>
            {t('deviceWallet.backupSuffix')}
          </p>

          <div className="flex gap-2">
            <Button
              type="button"
              data-testid="uclaw-cloud-copy-api-key"
              variant="outline"
              className="h-9 flex-1 rounded-lg"
              onClick={() => void handleCopyKey()}
            >
              {keyCopied ? <Check className="mr-1.5 h-3.5 w-3.5 text-green-500" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
              {t('deviceWallet.copyKey')}
            </Button>
            <Button
              type="button"
              data-testid="uclaw-cloud-rotate-key"
              variant="outline"
              className="h-9 flex-1 rounded-lg"
              disabled={busy}
              onClick={() => setRotateConfirmOpen(true)}
            >
              <RotateCw className="mr-1.5 h-3.5 w-3.5" />
              {t('deviceWallet.rotateKey')}
            </Button>
          </div>

          <div className="flex gap-2">
            <Input
              data-testid="uclaw-cloud-adopt-key-input"
              value={adoptValue}
              onChange={(event) => setAdoptValue(event.target.value)}
              placeholder="sk-..."
              spellCheck={false}
              autoComplete="off"
              className="h-9 min-w-0 flex-1 font-mono text-[12px]"
              aria-label={t('deviceWallet.adoptAria')}
            />
            <Button
              type="button"
              data-testid="uclaw-cloud-paste-key"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 rounded-lg"
              onClick={() => void handlePaste()}
              aria-label={t('deviceWallet.pasteKey')}
              title={t('deviceWallet.pasteTitle')}
            >
              <ClipboardPaste className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              data-testid="uclaw-cloud-adopt-key"
              variant="outline"
              className="h-9 shrink-0 rounded-lg"
              disabled={busy || !adoptValue.trim()}
              onClick={() => void guarded(async () => {
                const message = await adoptKey(adoptValue);
                setAdoptValue('');
                return message;
              }, t('deviceWallet.adopted'))}
            >
              <KeyRound className="mr-1.5 h-3.5 w-3.5" />
              {t('deviceWallet.enable')}
            </Button>
          </div>

          <div className="border-t border-black/10 pt-3 dark:border-white/10">
            <Button
              type="button"
              data-testid="uclaw-cloud-reset-local-wallet"
              variant="ghost"
              className="h-9 w-full justify-start rounded-lg text-red-700 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-400"
              disabled={busy || !wallet?.ready}
              onClick={() => void handlePrepareReset()}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t('deviceWallet.removeLocal')}
            </Button>
          </div>
        </div>
      </CardContent>

      <ConfirmDialog
        open={legacyImportConfirmOpen}
        title={t('deviceWallet.legacy.importDialog.title')}
        message={t('deviceWallet.legacy.importDialog.message', {
          key: wallet?.legacyWallet?.apiKeyMasked || '-',
          balance: legacyBalanceLabel,
        })}
        confirmLabel={t('deviceWallet.legacy.importDialog.confirm')}
        cancelLabel={t('deviceWallet.cancel')}
        onConfirm={async () => {
          setLegacyImportConfirmOpen(false);
          await guarded(importLegacyWallet, t('deviceWallet.legacy.imported'));
        }}
        onCancel={() => setLegacyImportConfirmOpen(false)}
      />
      <ConfirmDialog
        open={legacyFreshConfirmOpen}
        title={t('deviceWallet.legacy.freshDialog.title')}
        message={t('deviceWallet.legacy.freshDialog.message')}
        confirmLabel={t('deviceWallet.legacy.freshDialog.confirm')}
        cancelLabel={t('deviceWallet.cancel')}
        variant="destructive"
        onConfirm={async () => {
          setLegacyFreshConfirmOpen(false);
          await guarded(createFreshWallet, t('deviceWallet.legacy.freshCreated'));
        }}
        onCancel={() => setLegacyFreshConfirmOpen(false)}
      />
      <ConfirmDialog
        open={rotateConfirmOpen}
        title={t('deviceWallet.rotateDialog.title')}
        message={t('deviceWallet.rotateDialog.message')}
        confirmLabel={t('deviceWallet.rotateDialog.confirm')}
        cancelLabel={t('deviceWallet.cancel')}
        variant="destructive"
        onConfirm={async () => {
          setRotateConfirmOpen(false);
          await guarded(rotateKey, t('deviceWallet.rotated'));
        }}
        onCancel={() => setRotateConfirmOpen(false)}
      />
      <ConfirmDialog
        open={resetConfirmOpen}
        title={t('deviceWallet.removeDialog.title')}
        message={t('deviceWallet.removeDialog.message')}
        confirmLabel={t('deviceWallet.removeDialog.confirm')}
        cancelLabel={t('deviceWallet.cancel')}
        variant="destructive"
        onConfirm={async () => {
          setResetConfirmOpen(false);
          await guarded(resetLocalWallet, t('deviceWallet.removed'));
        }}
        onCancel={() => setResetConfirmOpen(false)}
      />
    </Card>
  );
}

export default UclawCloudPanel;
