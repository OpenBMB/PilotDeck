import { useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';

type AnimatedDisclosureProps = ComponentPropsWithoutRef<'div'> & {
  expanded: boolean;
  contentClassName?: string;
  keepMounted?: boolean;
};

/** Animate intrinsic height in both directions and preserve opened content/scroll state. */
export function AnimatedDisclosure({ expanded, children, className = '', contentClassName = '', keepMounted = false, ...props }: AnimatedDisclosureProps) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(expanded);
  const [visited, setVisited] = useState(expanded);
  if (expanded && !visited) setVisited(true);
  useLayoutEffect(() => {
    // Commit the zero-height starting layout before revealing newly mounted details.
    // This also permits a native <details> parent to animate its first opening.
    if (expanded) root.current?.getBoundingClientRect();
    setVisible(expanded);
  }, [expanded]);
  return <div {...props} ref={root} className={`chat-process-disclosure ${className}`}
    data-expanded={visible} aria-hidden={!expanded} {...(!expanded ? { inert: '' } : {})}>
    <div className="min-h-0 min-w-0 overflow-hidden">
      <div className={`flow-root min-w-0 ${contentClassName}`}>{keepMounted || visited || expanded ? children : null}</div>
    </div>
  </div>;
}
