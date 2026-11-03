import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../../types/types';
import { conversationError } from '../../utils/conversationErrors';

export default function ConversationError({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('chat');
  const error = conversationError(message, t);
  return <section role="alert" className="min-w-0 rounded-xl border border-red-200/70 bg-red-50/40 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/20">
    <div className="flex items-start gap-2.5">
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[14px] font-medium leading-6 text-foreground">{error.title}</p>
        <p className="mb-0 mt-1 text-[13px] leading-6 text-muted-foreground">{error.hint}</p>
        {error.details && <details className="mt-2 text-[12px] text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{t('conversationError.details')}</summary>
          <pre className="mb-0 mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background/80 p-3 font-mono text-[12px] leading-5 text-muted-foreground">{error.details}</pre>
        </details>}
      </div>
    </div>
  </section>;
}
