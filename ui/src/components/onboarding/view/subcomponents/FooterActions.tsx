import { ArrowLeftIcon, ArrowRightIcon } from './icons';

type FooterActionsProps = {
  backLabel: string;
  nextLabel: string;
  nextDisabled?: boolean;
  nextBusy?: boolean;
  onBack: () => void;
  onNext: () => void;
};

export default function FooterActions({
  backLabel,
  nextLabel,
  nextDisabled = false,
  nextBusy = false,
  onBack,
  onNext,
}: FooterActionsProps) {
  return (
    <div className="footer-actions">
      <button className="button secondary" type="button" onClick={onBack}>
        <ArrowLeftIcon />
        {backLabel}
      </button>
      <button
        className="button primary"
        type="button"
        onClick={onNext}
        disabled={nextDisabled || nextBusy}
      >
        {nextLabel}
        <ArrowRightIcon />
      </button>
    </div>
  );
}
