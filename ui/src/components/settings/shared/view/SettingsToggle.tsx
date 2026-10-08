import { cn } from "../../../../lib/utils";
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
  const handleClick = () => {
    const nextValue = !checked;
    const message = `${successLabel}已${nextValue ? "开启" : "关闭"}`;
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
