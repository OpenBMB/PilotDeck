import { Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MainContentStateViewProps } from '../../types/types';

export default function MainContentStateView({ mode }: MainContentStateViewProps) {
  const { t } = useTranslation();

  const isLoading = mode === 'loading';

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-2 text-[13px] text-neutral-500 dark:text-neutral-400">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-b-2 border-neutral-400" />
            <span>{t('mainContent.loading', { defaultValue: 'Loading…' })}</span>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-[440px] px-6 text-center">
            <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-900">
              <Folder className="h-4.5 w-4.5 text-neutral-500" strokeWidth={1.75} />
            </div>
            <h2 className="mb-1 text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
              {t('mainContent.chooseProject', { defaultValue: 'Pick a project to start' })}
            </h2>
            <p className="text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              {t('mainContent.selectProjectDescription', {
                defaultValue: 'Choose a project from the sidebar, or open a new one.',
              })}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
