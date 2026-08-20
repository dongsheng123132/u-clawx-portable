import { useEffect, useState } from 'react';
import { Check, ClipboardPaste, Copy, ExternalLink, KeyRound, RefreshCw, RotateCw, WalletCards } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { hostApi } from '@/lib/host-api';
import { useUclawCloudStore } from '@/stores/uclaw-cloud';

/**
 * 虾粮中心面板：余额 + 一键充值 + 设备钱包密钥管理。
 *
 * 没有登录、没有账号状态 —— 钱包没就绪时只提示「联网后自动获取」，
 * 不拦用户做别的事。
 */
function formatTokens(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '不可用';
  return `${value.toLocaleString()} 虾粮`;
}

export function UclawCloudPanel() {
  const wallet = useUclawCloudStore((s) => s.wallet);
  const balance = useUclawCloudStore((s) => s.balance);
  const refresh = useUclawCloudStore((s) => s.refresh);
  const refreshBalance = useUclawCloudStore((s) => s.refreshBalance);
  const getRechargeUrl = useUclawCloudStore((s) => s.getRechargeUrl);
  const getApiKey = useUclawCloudStore((s) => s.getApiKey);
  const rotateKey = useUclawCloudStore((s) => s.rotateKey);
  const adoptKey = useUclawCloudStore((s) => s.adoptKey);

  const [refreshing, setRefreshing] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [adoptValue, setAdoptValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apiKeyMasked = balance?.apiKeyMasked || wallet?.apiKeyMasked || '-';
  const balanceLabel = balance?.available ? formatTokens(balance.remainTokens) : '不可用';

  async function guarded(action: () => Promise<string>, fallback: string) {
    setBusy(true);
    try {
      toast.success((await action()) || fallback);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshBalance();
      toast.success('余额已刷新');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleRecharge() {
    try {
      await hostApi.shell.openExternal(await getRechargeUrl());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  // 有些环境里右键菜单和 Ctrl+V 都不好使（Electron 输入框的粘贴依赖应用菜单
  // 的加速键），给个按钮直接从剪贴板读，是最不会出错的一条路。
  async function handlePaste() {
    try {
      const text = (await navigator.clipboard.readText())?.trim();
      if (!text) throw new Error('剪贴板是空的');
      setAdoptValue(text);
    } catch {
      toast.error('读不到剪贴板，请在输入框里按 Ctrl+V，或右键选「粘贴」');
    }
  }

  async function handleCopyKey() {
    try {
      const key = await getApiKey();
      if (!key) throw new Error('这台机器还没有钱包，联网后会自动获取');
      await navigator.clipboard.writeText(key);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 1500);
      toast.success('密钥已复制');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
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
            <span className="text-[15px] font-semibold text-foreground">虾盘云</span>
            <span
              data-testid="uclaw-cloud-key"
              className="truncate font-mono text-[13px] text-muted-foreground"
            >
              {apiKeyMasked}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span data-testid="uclaw-cloud-balance" className="text-[14px] font-medium text-foreground">
              {balanceLabel}
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
              刷新
            </Button>
          </div>
        </div>

        {wallet && !wallet.ready && (
          <p
            data-testid="uclaw-cloud-no-wallet"
            className="rounded-lg bg-black/5 px-3 py-2 text-[12px] text-muted-foreground dark:bg-white/5"
          >
            这台机器还没有钱包，联网后会自动获取；也可以在下面填入已有密钥。
          </p>
        )}

        <Button
          type="button"
          data-testid="uclaw-cloud-recharge-button"
          className="h-11 w-full rounded-xl"
          onClick={() => void handleRecharge()}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          一键充值
        </Button>

        <div className="space-y-3 border-t border-black/10 pt-4 dark:border-white/10">
          <span className="text-[13px] font-semibold text-foreground">密钥管理</span>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            密钥由服务端签发，<strong className="font-medium text-foreground">它就是你的钱包</strong>，
            请自行备份 —— 换电脑时填回去，余额跟着走。
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
              复制密钥
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
              换一把
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
              aria-label="填入已有密钥"
            />
            <Button
              type="button"
              data-testid="uclaw-cloud-paste-key"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 rounded-lg"
              onClick={() => void handlePaste()}
              aria-label="粘贴密钥"
              title="从剪贴板粘贴"
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
              }, '已启用这把密钥')}
            >
              <KeyRound className="mr-1.5 h-3.5 w-3.5" />
              启用
            </Button>
          </div>
        </div>
      </CardContent>

      <ConfirmDialog
        open={rotateConfirmOpen}
        title="换一把密钥？"
        message={
          '换完之后，现在这把密钥立刻失效 —— 别处（其它电脑、脚本）如果还在用它，都要改成新的。\n\n'
          + '余额不受影响：它记在钱包上，不记在密钥上。'
        }
        confirmLabel="换"
        cancelLabel="算了"
        variant="destructive"
        onConfirm={async () => {
          setRotateConfirmOpen(false);
          await guarded(rotateKey, '已换成新密钥');
        }}
        onCancel={() => setRotateConfirmOpen(false)}
      />
    </Card>
  );
}

export default UclawCloudPanel;
