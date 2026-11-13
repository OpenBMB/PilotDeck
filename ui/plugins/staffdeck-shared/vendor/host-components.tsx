import type { ComponentProps, ReactNode } from 'react';
import * as Primitive from './formal-primitives';
import { Button } from './formal-primitives/button';
import { Info, Check, ChevronDown, CircleAlert } from 'lucide-react';
import * as FormalIcons from './FormalIcons';
import * as SourceIcons from './FormalSourceIcons';
import { StatusBadge } from './FormalStatusBadge';
import './FormalPresentation.css';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { FormalHostPrimitiveProvider } from './FormalHostPrimitives';
import { ConfirmDialog as SourceConfirmDialog } from './FormalConfirmDialog';
import { Paginator as SourcePaginator } from './FormalPaginator';
import { DetailField } from './FormalDetailField';
import { StatCard } from './FormalStatCard';
import CapabilityScopeLoading from './FormalCapabilityScopeLoading';
import { CapabilityScopeBadge, CapabilityScopeControl } from './FormalCapabilityScopeControl';
import { ModelConfigDropdown } from './FormalModelConfigDropdown';
import { PilotDeckDialog, PilotDeckDialogContent, PilotDeckDialogTitle } from './dialog-primitives';

const primitives = { ...Primitive, Button, ...FormalIcons, ...SourceIcons };
function wrap(Source: any) {
  return function FormalComponent(props: any) {
    return <FormalHostPrimitiveProvider value={primitives}><Source {...props} /></FormalHostPrimitiveProvider>;
  };
}

// Account controls belong to the native PilotDeck shell. Preserve the source
// page's left/right/title/description slots without importing SD auth/store.
function AppHeader({ left, right, title, description, className }: any) {
  return <header className={className}>{left ?? <><h1>{title}</h1>{description && <p>{description}</p>}</>}{right}</header>;
}
function DialogFooter({ className = '', showCloseButton = false, children, ...props }: ComponentProps<'div'> & { showCloseButton?: boolean }) {
  return <div data-slot="dialog-footer" className={`flex flex-col-reverse gap-2 bg-white px-[24px] py-[12px] sm:flex-row sm:justify-end ${className}`} {...props}>
    {children}
    {showCloseButton && <DialogPrimitive.Close asChild><Button variant="outline">Close</Button></DialogPrimitive.Close>}
  </div>;
}

export const pilotDeckFormalComponents = {
  ...Primitive,
  AppHeader, DialogFooter,
  UIButton: Button, UISelect: Primitive.Select,
  Dialog: PilotDeckDialog, DialogContent: PilotDeckDialogContent, DialogTitle: PilotDeckDialogTitle,
  ConfirmDialog: wrap(SourceConfirmDialog), Paginator: wrap(SourcePaginator),
  DetailField, StatCard, StatusBadge, CapabilityScopeLoading,
  CapabilityScopeBadge, CapabilityScopeControl: wrap(CapabilityScopeControl),
  ModelConfigDropdown: wrap(ModelConfigDropdown),
};
export const pilotDeckFormalIcons = { ...FormalIcons, ...SourceIcons };
export const pilotDeckNotify = {
  success: (message: string) => window.dispatchEvent(new CustomEvent('pilotdeck:toast', { detail: { kind: 'success', message } })),
  warning: (message: string) => window.dispatchEvent(new CustomEvent('pilotdeck:toast', { detail: { kind: 'warning', message } })),
  error: (message: string) => window.dispatchEvent(new CustomEvent('pilotdeck:toast', { detail: { kind: 'error', message } })),
  info: (message: string) => window.dispatchEvent(new CustomEvent('pilotdeck:toast', { detail: { kind: 'info', message } })),
};
