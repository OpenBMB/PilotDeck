import {
  useEffect,
  useId,
  useState,
  type RefObject,
} from 'react';
import { findTextSearchMatches } from '../utils/fileSearch';

type DomSearchMatch = {
  range: Range;
  element: HTMLElement;
};

type UseDomFileSearchOptions = {
  rootRef: RefObject<HTMLElement>;
  query: string;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  enabled?: boolean;
  contentKey?: string | number | boolean;
};

type CssHighlightsRegistry = Map<string, unknown>;

function getCssHighlights(): CssHighlightsRegistry | undefined {
  return (globalThis.CSS as unknown as {
    highlights?: CssHighlightsRegistry;
  })?.highlights;
}

function getHighlightConstructor() {
  return (globalThis as unknown as {
    Highlight?: new (...ranges: Range[]) => unknown;
  }).Highlight;
}

export function findDomTextMatches(root: HTMLElement, query: string): DomSearchMatch[] {
  if (!query.trim()) return [];

  const matches: DomSearchMatch[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('style,script,[data-file-search-exclude]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent?.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  let node = walker.nextNode();
  while (node) {
    const text = node.textContent || '';
    for (const match of findTextSearchMatches(text, query)) {
      const range = document.createRange();
      range.setStart(node, match.from);
      range.setEnd(node, match.to);
      matches.push({
        range,
        element: node.parentElement || root,
      });
    }
    node = walker.nextNode();
  }

  return matches;
}

export function useDomFileSearch({
  rootRef,
  query,
  activeIndex,
  onActiveIndexChange,
  enabled = true,
  contentKey = '',
}: UseDomFileSearchOptions) {
  const [matches, setMatches] = useState<DomSearchMatch[]>([]);
  const highlightId = useId().replace(/[^a-z0-9_-]/gi, '');
  const allHighlightName = `pilotdeck-file-search-${highlightId}`;
  const activeHighlightName = `${allHighlightName}-active`;

  useEffect(() => {
    const cssHighlights = getCssHighlights();
    cssHighlights?.delete(allHighlightName);
    cssHighlights?.delete(activeHighlightName);

    const root = rootRef.current;
    if (!enabled || !root) {
      setMatches([]);
      return undefined;
    }
    if (!query.trim()) {
      setMatches([]);
      onActiveIndexChange(0);
      return undefined;
    }

    const nextMatches = findDomTextMatches(root, query);
    setMatches(nextMatches);
    onActiveIndexChange(0);

    const HighlightConstructor = getHighlightConstructor();
    if (cssHighlights && HighlightConstructor && nextMatches.length > 0) {
      cssHighlights.set(
        allHighlightName,
        new HighlightConstructor(...nextMatches.map((match) => match.range)),
      );
    }

    return () => {
      cssHighlights?.delete(allHighlightName);
      cssHighlights?.delete(activeHighlightName);
    };
  }, [
    activeHighlightName,
    allHighlightName,
    contentKey,
    enabled,
    onActiveIndexChange,
    query,
    rootRef,
  ]);

  useEffect(() => {
    const cssHighlights = getCssHighlights();
    const HighlightConstructor = getHighlightConstructor();
    cssHighlights?.delete(activeHighlightName);
    if (!enabled || matches.length === 0) return;

    const match = matches[Math.min(activeIndex, matches.length - 1)];
    if (cssHighlights && HighlightConstructor) {
      cssHighlights.set(activeHighlightName, new HighlightConstructor(match.range));
    }
    match.element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [activeHighlightName, activeIndex, enabled, matches]);

  return {
    matchCount: matches.length,
    highlightStyles: `
      ::highlight(${allHighlightName}) {
        background: var(--file-search-highlight-bg);
        color: inherit;
      }
      ::highlight(${activeHighlightName}) {
        background: var(--file-search-highlight-active-bg);
        color: inherit;
      }
    `,
  };
}
