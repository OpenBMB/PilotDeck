type KeyboardEventLike = {
  key?: string;
  keyCode?: number;
  which?: number;
  isComposing?: boolean;
  nativeEvent?: {
    keyCode?: number;
    which?: number;
    isComposing?: boolean;
  };
};

const IME_PROCESS_KEY_CODE = 229;

export function isImeCompositionEvent(event: KeyboardEventLike): boolean {
  const nativeEvent = event.nativeEvent;
  return Boolean(
    event.isComposing ||
      nativeEvent?.isComposing ||
      event.keyCode === IME_PROCESS_KEY_CODE ||
      event.which === IME_PROCESS_KEY_CODE ||
      nativeEvent?.keyCode === IME_PROCESS_KEY_CODE ||
      nativeEvent?.which === IME_PROCESS_KEY_CODE,
  );
}

export function isImeEnterEvent(event: KeyboardEventLike): boolean {
  return event.key === 'Enter' && isImeCompositionEvent(event);
}
