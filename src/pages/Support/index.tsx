import { useMemo, useState } from 'react';
import { AlertTriangle, Copy, Mail, MessageCircle, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { hostApi } from '@/lib/host-api';
import { useUpdateStore } from '@/stores/update';
import wechatQr from '@/assets/wechat-support-qr.jpg';

const SUPPORT_EMAIL = 'hefangsheng@gmail.com';
const SUPPORT_WECHAT = 'hecare888';

function platformName(platform: string | undefined): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return platform || 'Unknown';
}

export function Support() {
  const { t } = useTranslation('support');
  const currentVersion = useUpdateStore((state) => state.currentVersion);
  const [feedback, setFeedback] = useState('');
  const [contact, setContact] = useState('');
  const platform = useMemo(() => platformName(window.electron?.platform), []);

  const buildFeedbackText = () => [
    `${t('feedbackField')}:`,
    feedback.trim(),
    '',
    `${t('contactField')}: ${contact.trim() || t('notProvided')}`,
    `${t('versionField')}: U-ClawX ${currentVersion}`,
    `${t('platformField')}: ${platform}`,
    '',
    t('manualOnlyFooter'),
  ].join('\n');

  const copyText = async (value: string, successMessage: string) => {
    await navigator.clipboard.writeText(value);
    toast.success(successMessage);
  };

  const copyFeedback = async () => {
    if (!feedback.trim()) {
      toast.error(t('feedbackRequired'));
      return;
    }
    await copyText(buildFeedbackText(), t('feedbackCopied'));
  };

  const sendFeedback = async () => {
    if (!feedback.trim()) {
      toast.error(t('feedbackRequired'));
      return;
    }

    const subject = `${t('emailSubject')} · U-ClawX ${currentVersion}`;
    const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(buildFeedbackText())}`;
    try {
      await hostApi.shell.openExternal(mailto);
    } catch {
      await navigator.clipboard.writeText(buildFeedbackText());
      toast.error(t('emailOpenFailed'));
    }
  };

  return (
    <div data-testid="support-page" className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-6 px-8 py-10">
        <div>
          <h1 className="font-serif text-4xl font-normal tracking-tight">{t('title')}</h1>
          <p className="mt-2 text-muted-foreground">{t('subtitle')}</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(300px,0.85fr)_minmax(420px,1.15fr)]">
          <Card className="bg-surface-modal">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <MessageCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
                {t('contactTitle')}
              </CardTitle>
              <CardDescription>{t('contactDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex justify-center rounded-lg bg-white p-3">
                <img
                  data-testid="support-wechat-qr"
                  src={wechatQr}
                  alt={t('qrAlt')}
                  className="h-auto w-full max-w-[300px] rounded-md"
                />
              </div>
              <div className="space-y-2">
                <div className="text-sm text-muted-foreground">{t('wechatId')}</div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 rounded-md bg-surface-input px-3 py-2 text-sm">{SUPPORT_WECHAT}</code>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t('copyWechat')}
                    onClick={() => void copyText(SUPPORT_WECHAT, t('wechatCopied'))}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-sm text-muted-foreground">{t('email')}</div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-surface-input px-3 py-2 text-sm">{SUPPORT_EMAIL}</code>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t('copyEmail')}
                    onClick={() => void copyText(SUPPORT_EMAIL, t('emailCopied'))}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-surface-modal">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <Mail className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                {t('feedbackTitle')}
              </CardTitle>
              <CardDescription>{t('feedbackDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="support-feedback">{t('feedbackLabel')}</Label>
                <Textarea
                  id="support-feedback"
                  data-testid="support-feedback-input"
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                  placeholder={t('feedbackPlaceholder')}
                  className="min-h-40 resize-y bg-surface-input"
                  maxLength={2000}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="support-contact">{t('contactLabel')}</Label>
                <Input
                  id="support-contact"
                  value={contact}
                  onChange={(event) => setContact(event.target.value)}
                  placeholder={t('contactPlaceholder')}
                  className="bg-surface-input"
                  maxLength={200}
                />
              </div>

              <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-4 text-sm text-blue-700 dark:text-blue-400">
                <div className="font-medium">{t('privacyTitle')}</div>
                <p className="mt-1 leading-6">{t('privacyBody')}</p>
              </div>
              <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t('privacyWarning')}</span>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  data-testid="support-send-feedback"
                  type="button"
                  disabled={!feedback.trim()}
                  onClick={() => void sendFeedback()}
                >
                  <Send className="mr-2 h-4 w-4" />
                  {t('sendFeedback')}
                </Button>
                <Button type="button" variant="outline" onClick={() => void copyFeedback()}>
                  <Copy className="mr-2 h-4 w-4" />
                  {t('copyFeedback')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default Support;
