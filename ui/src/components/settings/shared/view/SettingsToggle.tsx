import { cn } from "../../../../lib/utils";
import { useTranslation } from "react-i18next";
import {
  queueSettingsSaveSuccess,
  showSettingsSuccess,
} from "../SettingsSuccessToast";

type SettingsToggleProps = {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  suppressNextSaveToast?: boolean;
  successLabel?: string;
  showSuccessToast?: boolean;
};

export default function SettingsToggle({
  checked,
  onChange,
  ariaLabel,
  disabled,
  suppressNextSaveToast = false,
  successLabel = ariaLabel,
  showSuccessToast = true,
}: SettingsToggleProps) {
  const { t } = useTranslation('settings');
  const handleClick = () => {
    const nextValue = !checked;
    const message = t(nextValue ? 'saveStatus.enabled' : 'saveStatus.disabled', { label: successLabel });
    if (showSuccessToast && suppressNextSaveToast) {
      queueSettingsSaveSuccess(message);
    }
    onChange(nextValue);
    if (showSuccessToast && !suppressNextSaveToast) showSettingsSuccess(message);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={handleClick}
      className={cn("route-switch", checked && "on")}
    >
      <span />
    </button>
  );
}
