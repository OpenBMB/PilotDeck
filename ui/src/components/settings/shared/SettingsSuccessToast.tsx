import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

const SETTINGS_SUCCESS_EVENT = "pilotdeck:settings-success";
const SETTINGS_SAVE_SUCCESS_EVENT = "pilotdeck:settings-save-success";
const TOAST_DURATION_MS = 2400;
const pendingSaveMessages: string[] = [];

export function showSettingsSuccess(message?: string) {
  window.dispatchEvent(
    new CustomEvent(SETTINGS_SUCCESS_EVENT, {
      detail: { message },
    }),
  );
}

export function queueSettingsSaveSuccess(message: string) {
  pendingSaveMessages.push(message);
}

export function takeSettingsSaveSuccess(): string | undefined {
  return pendingSaveMessages.shift();
}

export function notifySettingsSaveSuccess(message?: string) {
  window.dispatchEvent(
    new CustomEvent(SETTINGS_SAVE_SUCCESS_EVENT, { detail: { message } }),
  );
}

export function SettingsSuccessToastProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const display = (nextMessage: string) => {
      setMessage(nextMessage);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setMessage(null);
        timerRef.current = null;
      }, TOAST_DURATION_MS);
    };
    const onSuccess = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      display(detail?.message || t('saveStatus.success'));
    };
    const onSaveSuccess = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      display(detail?.message || t('saveStatus.success'));
    };

    window.addEventListener(SETTINGS_SUCCESS_EVENT, onSuccess);
    window.addEventListener(SETTINGS_SAVE_SUCCESS_EVENT, onSaveSuccess);
    return () => {
      window.removeEventListener(SETTINGS_SUCCESS_EVENT, onSuccess);
      window.removeEventListener(SETTINGS_SAVE_SUCCESS_EVENT, onSaveSuccess);
    };
  }, [t]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return (
    <>
      {children}
      {message ? (
        <div className="pilotdeck-settings-notification"><div className="settings-success-toast" role="status" aria-live="polite">
          <span aria-hidden="true">
            <svg width="14" height="14" fill="none" viewBox="0 0 16 16">
              <path
                d="m4.25 8.15 2.3 2.3 5.2-5.2"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          {message}
        </div></div>
      ) : null}
    </>
  );
}
