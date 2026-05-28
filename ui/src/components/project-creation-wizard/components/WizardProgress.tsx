import { Fragment } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WizardStep } from '../types';

type WizardProgressProps = {
  step: WizardStep;
};

export default function WizardProgress({ step }: WizardProgressProps) {
  const { t } = useTranslation();
  const steps: WizardStep[] = [1, 2, 3];

  return (
    <div className="px-6 pb-2 pt-4">
      <div className="flex items-center justify-between">
        {steps.map((currentStep) => {
          const isDone = currentStep < step;
          const isActive = currentStep === step;
          return (
            <Fragment key={currentStep}>
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium ${
                    isDone
                      ? 'bg-foreground text-background'
                      : isActive
                        ? 'bg-foreground/90 text-background'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {isDone ? <Check className="h-4 w-4" strokeWidth={2} /> : currentStep}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:inline ${
                    isActive || isDone ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {currentStep === 1
                    ? t('projectWizard.steps.type')
                    : currentStep === 2
                      ? t('projectWizard.steps.configure')
                      : t('projectWizard.steps.confirm')}
                </span>
              </div>

              {currentStep < 3 && (
                <div
                  className={`mx-2 h-px flex-1 ${isDone ? 'bg-foreground' : 'bg-border'}`}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
