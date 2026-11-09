import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QueuedInputSummary } from '../types/queuedInput';

function SendingIndicator() {
  const { t } = useTranslation('chat');
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(timer);
  }, []);
  return visible ? <Loader2 className="ml-2 inline-block h-3.5 w-3.5 animate-spin text-neutral-400" role="status" aria-label={t('inputQueue.sending')} /> : null;
}

/** Provisional sends stay outside the transcript until the gateway accepts them. */
export default function SendingMessages({ items }: { items: QueuedInputSummary[] }) {
  const { t } = useTranslation('chat');
  return items.map((item) => (
    <div key={item.id} className="flex justify-end py-2" data-sending-input={item.id}>
      <div className="min-w-0 max-w-[78%] rounded-[22px] bg-neutral-100 px-4 py-2.5 text-[14px] leading-relaxed text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
        <span className="whitespace-pre-wrap break-words">{item.displayText || t('inputQueue.attachmentOnly')}</span>
        {item.attachmentCount ? <span className="ml-2 text-xs text-neutral-500">+{item.attachmentCount}</span> : null}
        <SendingIndicator />
      </div>
    </div>
  ));
}
