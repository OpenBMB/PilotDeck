import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../../types/types';
import { conversationError } from '../../utils/conversationErrors';

export default function ConversationError({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('chat');
  const error = conversationError(message, t);
  return <section role="alert" className="grid min-w-0 grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-x-2 py-1 text-[13px] leading-6">
    <span aria-hidden="true" className="mt-[9px] h-1.5 w-1.5 rounded-full bg-red-500" />
    <div className="min-w-0">
      <p className="m-0 text-muted-foreground">
        <span className="mr-2 font-medium text-red-600 dark:text-red-400">{t('conversationError.label')}</span>
        {error.title}
      </p>
      <details className="group/error-details mt-0.5 text-[12px] text-muted-foreground">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded py-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden="true" className="h-3 w-3 transition-transform group-open/error-details:rotate-90 motion-reduce:transition-none" />
          {t('conversationError.details')}
        </summary>
        <p className="mb-0 mt-1 text-[13px] leading-6">{error.hint}</p>
        {error.details && <pre className="mb-0 mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-[12px] leading-5">{error.details}</pre>}
      </details>
    </div>
    {error.code && <code className="max-w-[160px] break-all pl-2 pt-0.5 text-[11px] leading-5 text-muted-foreground">{error.code}</code>}
  </section>;
}
