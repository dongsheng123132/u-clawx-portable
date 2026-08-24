import { AlertTriangle, ExternalLink, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { hostApi } from '@/lib/host-api';
import { isQuotaRunError } from './quota-error';

export function AcpErrorBanner({
  message,
  kind = 'load',
  onDismiss,
}: {
  message: string;
  kind?: 'load' | 'prompt';
  onDismiss?: () => void;
}) {
  const { t } = useTranslation('chat');
  const quota = isQuotaRunError(message);
  const title = quota
    ? t('acp.quotaTitle')
    : kind === 'prompt'
      ? t('acp.promptFailed')
      : t('acp.loadFailed');

  async function openRechargePage() {
    try {
      await hostApi.shell.openExternal((await hostApi.uclaw.rechargeUrl()).url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div
      data-testid="acp-error-banner"
      className="flex items-start gap-3 rounded-2xl border border-red-500/20 bg-surface-modal px-4 py-3 text-red-700 shadow-sm dark:text-red-400"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {quota ? (
          <div className="mt-1 flex items-center justify-between gap-3">
            <p className="break-words text-sm opacity-80">{t('acp.quotaHint')}</p>
            <Button
              type="button"
              data-testid="acp-error-recharge"
              className="h-8 shrink-0 rounded-lg bg-red-700 px-3 text-xs font-medium text-white hover:bg-red-800 dark:bg-red-500 dark:text-white dark:hover:bg-red-400"
              onClick={() => void openRechargePage()}
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('acp.recharge')}
            </Button>
          </div>
        ) : (
          <p className="mt-1 break-words text-sm opacity-80">{message}</p>
        )}
      </div>
      {onDismiss && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-red-700 hover:bg-black/5 dark:text-red-400 dark:hover:bg-white/10"
          aria-label={t('acp.dismiss')}
          title={t('acp.dismiss')}
          onClick={onDismiss}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
