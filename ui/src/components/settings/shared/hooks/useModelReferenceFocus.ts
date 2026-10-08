import { useEffect } from 'react';

export function useModelReferenceFocus(reference: string | null, section: string) {
  useEffect(() => {
    if (!reference) return;
    let highlighted: HTMLElement | undefined;
    const content = document.querySelector('.settings-content');
    if (!content) return;
    const focus = () => {
      const target = Array.from(content.querySelectorAll<HTMLElement>('[data-model-reference]'))
        .find(element => element.dataset.modelReference === reference);
      if (!target || target === highlighted) return;
      highlighted?.removeAttribute('data-reference-highlight');
      highlighted = target;
      target.setAttribute('data-reference-highlight', '');
      target.scrollIntoView?.({ block: 'center', behavior: 'instant' });
      target.focus({ preventScroll: true });
    };
    const observer = new MutationObserver(focus);
    observer.observe(content, { childList: true, subtree: true });
    focus();
    return () => { observer.disconnect(); highlighted?.removeAttribute('data-reference-highlight'); };
  }, [reference, section]);
}
