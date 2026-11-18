import { isTeamScope } from '../../../staffdeck-shared/vendor/FormalHostContractHelpers';
import { createContext, createElement, forwardRef, useContext, useState, type ComponentType, type ReactNode } from 'react';
import { cn } from '../../../staffdeck-shared/vendor/FormalUtils';
import { AlertCircle, ArrowLeft, Braces, Check, CheckCircle, ChevronDown, CircleX, Clipboard, Code2, FileText, Info, LoaderCircle, MoreHorizontal, Play, Plus, Save, Send, Square, Trash2, Upload, X, type LucideProps } from 'lucide-react';
import {
  Dialog as SkillsDialog,
  DialogContent as SkillsDialogContent,
  DialogTitle as SkillsDialogTitle,
  Select as SkillsSelect,
  SelectContent as SkillsSelectContent,
  SelectItem as SkillsSelectItem,
  SelectTrigger as SkillsSelectTrigger,
  SelectValue as SkillsSelectValue,
  UIButton as SkillsButton,
} from './SkillsPageHost';

export type EnterpriseAuthUser = { id?: string; username?: string; tenant_id?: string; is_admin?: boolean };
export type GeneralSkillRead = Record<string, any> & { id: string; name?: string };
export type KnowledgeBaseRead = Record<string, any> & { id: string; name?: string };
export type ModelConfigRead = Record<string, any> & { id: string; name?: string; enabled?: boolean; is_default?: boolean };
export type ToolRead = Record<string, any> & { id: string; name?: string; description?: string };
export type ToolSuggestion = Record<string, any> & { id?: string; name?: string };
export type ToolProbeResponse = Record<string, any>;
export type SkillRead = Record<string, any> & { id: string; skill_id: string; name: string; version: string; status?: string; updated_at?: string; content?: SkillCard };
export type SkillGraphNode = Record<string, any> & { node_id?: string };
export type SkillCard = Record<string, any> & { skill_id?: string; name?: string; version?: string; nodes: SkillGraphNode[]; edges: Record<string, any>[] };

type StreamEvent = { event: string; data: Record<string, unknown> };
type Api = {
  get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  postWithSignal<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
};
type HostComponent = ComponentType<any>;

export type DistillPageHost = {
  // Only the native Host retains its original conflict fallback semantics.
  permitsNativeConflictRecovery?(error: unknown): boolean;
  saveVersionPolicy?(snapshot: SkillRead): { serviceAssigned: true; label: string } | undefined;
  restoreEditorReadSnapshot?(snapshot: SkillRead): void;
  api: Api;
  streamGet(path: string, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void>;
  streamPost(path: string, body: Record<string, unknown>, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void>;
  navigate(path: string, options?: { replace?: boolean }): void;
  tenantId: string;
  notify: { success(message: string): void; warning(message: string): void; error(message: string): void; info(message: string): void };
  readEmployeeScope(): string;
  isTeamScope(value: string): boolean;
  components?: Record<string, HostComponent>;
  icons?: Record<string, HostComponent>;
};

const defaultError = () => { throw new Error('StaffDeck Distill API is not configured'); };
const defaultHost: DistillPageHost = {
  api: { get: defaultError, post: defaultError, postWithSignal: defaultError, put: defaultError, delete: defaultError },
  streamGet: async () => { throw new Error('StaffDeck Distill stream API is not configured'); },
  streamPost: async () => { throw new Error('StaffDeck Distill stream API is not configured'); },
  navigate: (path) => { window.location.assign(path); },
  tenantId: 'tenant_demo',
  notify: { success: () => {}, warning: () => {}, error: () => {}, info: () => {} },
  readEmployeeScope: () => '',
  isTeamScope,
};
const HostContext = createContext<DistillPageHost>(defaultHost);
export function DistillPageHostProvider({ value, children }: { value: DistillPageHost; children: ReactNode }) { return <HostContext.Provider value={value}>{children}</HostContext.Provider>; }
export function useDistillPageHost(): DistillPageHost { return useContext(HostContext); }

export { ApiError } from '../../../staffdeck-shared/vendor/FormalApiError';
export * from '../../../staffdeck-shared/vendor/FormalHostContractHelpers';
export { cn } from '../../../staffdeck-shared/vendor/FormalUtils';
export { SELECT_TRIGGER_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles';

function fallbackComponent(name: string, fallback: HostComponent): HostComponent {
  return forwardRef<any, any>((props, ref) => { const host = useDistillPageHost(); const injected = host.components?.[name]; return createElement(injected || fallback, injected ? { ...props, ref } : props); });
}
const NativeInput = ({ className, ...props }: any) => <input {...props} className={cn('rounded border border-neutral-300 px-2 py-1.5 text-sm', className)} />;
const NativeTextarea = ({ className, ...props }: any) => <textarea {...props} className={cn('rounded border border-neutral-300 px-2 py-1.5 text-sm', className)} />;
const NativeCheckbox = ({ checked, onCheckedChange, ...props }: any) => <input {...props} type="checkbox" checked={Boolean(checked)} onChange={(event) => onCheckedChange?.(event.target.checked)} />;
const NativeFooter = ({ children, className, ...props }: any) => <div {...props} className={cn('flex justify-end gap-2 border-t px-5 py-4', className)}>{children}</div>;
const NativePopover = ({ children }: any) => <>{children}</>;
const NativePopoverContent = ({ children, className, ...props }: any) => <div {...props} className={cn('z-50 rounded border bg-white p-2 shadow-lg', className)}>{children}</div>;
const NativePopoverTrigger = ({ children }: any) => <>{children}</>;
const NativeTooltip = ({ children }: any) => <>{children}</>;
const NativeTooltipContent = ({ children, ...props }: any) => <span {...props}>{children}</span>;
const NativeTooltipProvider = ({ children }: any) => <>{children}</>;
const NativeTooltipTrigger = ({ children }: any) => <>{children}</>;

export const Checkbox = fallbackComponent('Checkbox', NativeCheckbox);
export const Dialog = fallbackComponent('Dialog', SkillsDialog);
export const DialogContent = fallbackComponent('DialogContent', SkillsDialogContent);
export const DialogFooter = fallbackComponent('DialogFooter', NativeFooter);
export const DialogTitle = fallbackComponent('DialogTitle', SkillsDialogTitle);
export const Input = fallbackComponent('Input', NativeInput);
export const Popover = fallbackComponent('Popover', NativePopover);
export const PopoverContent = fallbackComponent('PopoverContent', NativePopoverContent);
export const PopoverTrigger = fallbackComponent('PopoverTrigger', NativePopoverTrigger);
export const UISelect = fallbackComponent('UISelect', SkillsSelect);
export const SelectContent = fallbackComponent('SelectContent', SkillsSelectContent);
export const SelectItem = fallbackComponent('SelectItem', SkillsSelectItem);
export const SelectTrigger = fallbackComponent('SelectTrigger', SkillsSelectTrigger);
export const SelectValue = fallbackComponent('SelectValue', SkillsSelectValue);
export const Textarea = fallbackComponent('Textarea', NativeTextarea);
export const Tooltip = fallbackComponent('Tooltip', NativeTooltip);
export const TooltipContent = fallbackComponent('TooltipContent', NativeTooltipContent);
export const TooltipProvider = fallbackComponent('TooltipProvider', NativeTooltipProvider);
export const TooltipTrigger = fallbackComponent('TooltipTrigger', NativeTooltipTrigger);
export const UIButton = fallbackComponent('UIButton', SkillsButton);
export const AppHeader = fallbackComponent('AppHeader', ({ title, userName, children, ...props }: any) => <header {...props} className={cn('flex items-center justify-between px-5 py-4', props.className)}><strong>{title}</strong>{userName ? <span>{userName}</span> : children}</header>);
export const ConfirmDialog = fallbackComponent('ConfirmDialog', ({ open, title, description, onOpenChange, onConfirm, confirmText = '确认' }: any) => open ? <div role="dialog" className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4"><div className="rounded bg-white p-5"><h2>{title}</h2><p>{description}</p><div className="mt-4 flex gap-2"><button type="button" onClick={() => onOpenChange?.(false)}>取消</button><button type="button" onClick={onConfirm}>{confirmText}</button></div></div></div> : null);
export const CapabilityScopeBadge = fallbackComponent('CapabilityScopeBadge', ({ value }: any) => <span className="text-xs text-neutral-500">{String(value || '')}</span>);
export const CapabilityScopeControl = fallbackComponent('CapabilityScopeControl', ({ value, onChange }: any) => <input value={String(value || '')} onChange={(event) => onChange?.(event.target.value)} />);
export const ModelConfigDropdown = fallbackComponent('ModelConfigDropdown', ({ value, onValueChange, options = [] }: any) => <select value={value || ''} onChange={(event) => onValueChange?.(event.target.value)}><option value="">选择模型</option>{options.map((item: any) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select>);

const lucideIcons: Record<string, ComponentType<LucideProps>> = { ApiOutlined: Braces, ArrowLeftOutlined: ArrowLeft, BranchesOutlined: Braces, CheckCircleOutlined: CheckCircle, CheckOutlined: Check, CodeOutlined: Code2, CloseOutlined: X, CloseCircleOutlined: CircleX, DeleteOutlined: Trash2, DownOutlined: ChevronDown, FileTextOutlined: FileText, InfoCircleOutlined: Info, LoadingOutlined: LoaderCircle, PlusOutlined: Plus, RightOutlined: ChevronDown, SaveOutlined: Save, SendOutlined: Send, StopOutlined: Square, UploadOutlined: Upload, WarningOutlined: AlertCircle, MoreOutlined: MoreHorizontal, PlayOutlined: Play, ClipboardOutlined: Clipboard };
function icon(name: string) { return (props: LucideProps) => { const host = useDistillPageHost(); const Icon = host.icons?.[name] || lucideIcons[name] || FileText; return <Icon {...props} />; }; }
export const ApiOutlined = icon('ApiOutlined'); export const ArrowLeftOutlined = icon('ArrowLeftOutlined'); export const BranchesOutlined = icon('BranchesOutlined'); export const CheckCircleOutlined = icon('CheckCircleOutlined'); export const CheckOutlined = icon('CheckOutlined'); export const CodeOutlined = icon('CodeOutlined'); export const CloseOutlined = icon('CloseOutlined'); export const CloseCircleOutlined = icon('CloseCircleOutlined'); export const DeleteOutlined = icon('DeleteOutlined'); export const DownOutlined = icon('DownOutlined'); export const FileTextOutlined = icon('FileTextOutlined'); export const InfoCircleOutlined = icon('InfoCircleOutlined'); export const LoadingOutlined = icon('LoadingOutlined'); export const PlusOutlined = icon('PlusOutlined'); export const RightOutlined = icon('RightOutlined'); export const SaveOutlined = icon('SaveOutlined'); export const SendOutlined = icon('SendOutlined'); export const StopOutlined = icon('StopOutlined'); export const UploadOutlined = icon('UploadOutlined'); export const WarningOutlined = icon('WarningOutlined');
