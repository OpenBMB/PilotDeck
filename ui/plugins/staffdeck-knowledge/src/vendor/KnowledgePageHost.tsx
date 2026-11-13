import { createContext, createElement, forwardRef, useContext, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Check, ChevronDown, Download, FilePlus2, Folder, History, MoreHorizontal, Pause, Play, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
import KnowledgeGraphCanvas from './KnowledgeGraphCanvas';
import {
  Accordion as DefaultAccordion, AccordionContent as DefaultAccordionContent, AccordionItem as DefaultAccordionItem, AccordionTrigger as DefaultAccordionTrigger,
  ConfirmDialog as DefaultConfirmDialog, BusinessDataTable as DefaultDataTable, Dialog as DefaultDialog, DialogContent as DefaultDialogContent,
  DialogTitle as DefaultDialogTitle, DropdownMenu as DefaultDropdownMenu, DropdownMenuContent as DefaultDropdownMenuContent,
  DropdownMenuItem as DefaultDropdownMenuItem, DropdownMenuSeparator as DefaultDropdownMenuSeparator, DropdownMenuTrigger as DefaultDropdownMenuTrigger,
  Paginator as DefaultPaginator, ResourceImportDialog as DefaultResourceImportDialog, SelectContent as DefaultSelectContent,
  SelectItem as DefaultSelectItem, SelectTrigger as DefaultSelectTrigger, SelectValue as DefaultSelectValue,
  StatusBadge as DefaultStatusBadge, UIButton as DefaultUIButton,
} from '../../../staffdeck-sop/src/vendor/SkillsPageHost';

export type EnterpriseAuthUser = { id?: string; username?: string; tenant_id?: string; role?: string; is_admin?: boolean };
export type AgentProfileRead = Record<string, any> & { id: string; name?: string; is_overall?: boolean; active?: boolean };
export type CapabilityScope = Record<string, any> & { id?: string; name?: string };
export type KnowledgeBaseRead = Record<string, any> & { id: string; name?: string; description?: string; status?: string };
export type KnowledgeBucketRead = Record<string, any> & { id: string; title?: string; name?: string };
export type KnowledgeChunkRead = Record<string, any> & { id: string; content?: string; summary?: string };
export type KnowledgeConceptRead = Record<string, any> & { id: string; concept_id?: string; title?: string; concept_type?: string };
export type KnowledgeDiscoveryRead = Record<string, any> & { id: string; title?: string; status?: string };
export type KnowledgeDocumentRead = Record<string, any> & { id: string; title?: string; filename?: string; status?: string };
export type KnowledgeIngestJobRead = Record<string, any> & { id: string; status?: string };
export type KnowledgeSearchResponse = Record<string, any>;
export type ModelConfigRead = Record<string, any> & { id: string; name?: string };

type Api = { get<T>(path: string, options?: any): Promise<T>; post<T>(path: string, body?: unknown, options?: any): Promise<T>; put<T>(path: string, body?: unknown): Promise<T>; delete<T>(path: string): Promise<T>; blob(path: string): Promise<Blob> };
export type Host = {
  api: Api;
  navigate(path: string): void;
  tenantId: string;
  notify: { success(message: string): void; warning(message: string): void; error(message: string): void };
  isEnterpriseAdmin(user?: EnterpriseAuthUser): boolean;
  loadEmployeeDirectory(): Promise<AgentProfileRead[]>;
  agentScope: { read(): string; persist(value: string, userId?: string): void; clear(userId?: string): void; emit(value: string): void };
  visibleEmployeeAgents(agents: AgentProfileRead[], user?: EnterpriseAuthUser, options?: Record<string, any>): AgentProfileRead[];
  canManageEmployeeAgent(agent: AgentProfileRead, user?: EnterpriseAuthUser): boolean;
  openGalleryAgentId(agents: AgentProfileRead[]): string;
  openGalleryImportSourceOptions(agents: AgentProfileRead[], label: string): Array<{ value: string; label: string }>;
  resourceCreatorName(row: Record<string, any>): string;
  renderMarkdownBlocks(value: string): ReactNode;
  getDateLocale(): string;
  components?: Record<string, ComponentType<any>>;
  icons?: Record<string, ComponentType<any>>;
};

const defaultNotify = { success: (_message: string) => {}, warning: (_message: string) => {}, error: (_message: string) => {} };
const defaultHost: Host = {
  api: { get: async () => { throw new Error('StaffDeck Knowledge API is not configured'); }, post: async () => { throw new Error('StaffDeck Knowledge API is not configured'); }, put: async () => { throw new Error('StaffDeck Knowledge API is not configured'); }, delete: async () => { throw new Error('StaffDeck Knowledge API is not configured'); }, blob: async () => { throw new Error('StaffDeck Knowledge API is not configured'); } },
  navigate: (path) => { window.location.assign(path); },
  tenantId: 'tenant_demo', notify: defaultNotify, isEnterpriseAdmin: (user) => Boolean(user?.is_admin),
  loadEmployeeDirectory: async () => [], agentScope: { read: () => '', persist: () => {}, clear: () => {}, emit: () => {} },
  visibleEmployeeAgents: (agents, _user, options = {}) => agents.filter((agent) => !agent.is_overall && (!options.activeOnly || agent.active !== false) && agent.id !== options.excludeAgentId),
  canManageEmployeeAgent: () => true, openGalleryAgentId: (agents) => agents.find((agent) => agent.is_overall)?.id || '', openGalleryImportSourceOptions: (agents) => agents.map((agent) => ({ value: agent.id, label: agent.name || agent.id })), resourceCreatorName: (row) => String(row.created_by_name || row.creator_name || ''),
  renderMarkdownBlocks: (value) => <span>{value}</span>, getDateLocale: () => 'zh-CN',
};
const HostContext = createContext<Host>(defaultHost);
export function KnowledgePageHostProvider({ value, children }: { value: Host; children: ReactNode }) { return <HostContext.Provider value={value}>{children}</HostContext.Provider>; }
export function useKnowledgePageHost(): Host { return useContext(HostContext); }
export { ApiError } from '../../../staffdeck-shared/vendor/FormalApiError';
export * from '../../../staffdeck-shared/vendor/FormalHostContractHelpers';
export function hasApiErrorStatus(error: unknown, status: number): boolean {
  return error instanceof Error && 'status' in error && error.status === status;
}
export { cn } from '../../../staffdeck-shared/vendor/FormalUtils';
export { useClientPagination } from './FormalPagination';

const iconMap: Record<string, any> = { AuditOutlined: Check, CheckOutlined: Check, CloseOutlined: X, DatabaseOutlined: Folder, DeleteOutlined: Trash2, DownloadOutlined: Download, EditOutlined: FilePlus2, FileAddOutlined: FilePlus2, FileMarkdownOutlined: FilePlus2, HistoryOutlined: History, InboxOutlined: Folder, MoreOutlined: MoreHorizontal, PauseCircleOutlined: Pause, PlayCircleOutlined: Play, ReloadOutlined: RefreshCw, RightOutlined: ChevronDown, TeamOutlined: Folder, IconAdd: FilePlus2, IconChevronDown: ChevronDown, IconClear: X, IconFolder: Folder, IconRefresh: RefreshCw, IconSearch: Search };
function icon(name: string): ComponentType<any> { return (props: any) => { const host = useKnowledgePageHost(); const Icon = host.icons?.[name] || iconMap[name] || FilePlus2; return createElement(Icon, props); }; }
export const AuditOutlined = icon('AuditOutlined'); export const CheckOutlined = icon('CheckOutlined'); export const CloseOutlined = icon('CloseOutlined'); export const DatabaseOutlined = icon('DatabaseOutlined'); export const DeleteOutlined = icon('DeleteOutlined'); export const DownloadOutlined = icon('DownloadOutlined'); export const EditOutlined = icon('EditOutlined'); export const FileAddOutlined = icon('FileAddOutlined'); export const FileMarkdownOutlined = icon('FileMarkdownOutlined'); export const HistoryOutlined = icon('HistoryOutlined'); export const InboxOutlined = icon('InboxOutlined'); export const MoreOutlined = icon('MoreOutlined'); export const PauseCircleOutlined = icon('PauseCircleOutlined'); export const PlayCircleOutlined = icon('PlayCircleOutlined'); export const ReloadOutlined = icon('ReloadOutlined'); export const RightOutlined = icon('RightOutlined'); export const TeamOutlined = icon('TeamOutlined'); export const IconAdd = icon('IconAdd'); export const IconChevronDown = icon('IconChevronDown'); export const IconClear = icon('IconClear'); export const IconFolder = icon('IconFolder'); export const IconRefresh = icon('IconRefresh'); export const IconSearch = icon('IconSearch');

function passthrough(name: string, fallback: ComponentType<any> = ({ children, ...props }: any) => <div {...props}>{children}</div>): ComponentType<any> { return forwardRef<any, any>((props, ref) => { const host = useKnowledgePageHost(); const injected = host.components?.[name]; return createElement(injected || fallback, injected ? { ...props, ref } : props); }); }
function refPassthrough(name: string, fallback: ComponentType<any>): ComponentType<any> {
  return forwardRef<any, any>((props, ref) => {
    const host = useKnowledgePageHost();
    const injected = host.components?.[name];
    return createElement(injected || fallback, injected ? { ...props, ref } : props);
  });
}
export const AppHeader = passthrough('AppHeader'); export const CapabilityScopeLoading = passthrough('CapabilityScopeLoading'); export const CapabilityScopeBadge = passthrough('CapabilityScopeBadge'); export const CapabilityScopeControl = passthrough('CapabilityScopeControl'); export const ModelConfigDropdown = passthrough('ModelConfigDropdown'); export const StatCard = passthrough('StatCard'); export const Progress = passthrough('Progress'); export const Input = passthrough('Input', ({ ...props }: any) => <input {...props} />); export const Textarea = passthrough('Textarea', ({ ...props }: any) => <textarea {...props} />); export const UISelect = passthrough('UISelect');
export const Accordion = passthrough('Accordion', DefaultAccordion); export const AccordionContent = passthrough('AccordionContent', DefaultAccordionContent); export const AccordionItem = passthrough('AccordionItem', DefaultAccordionItem); export const AccordionTrigger = passthrough('AccordionTrigger', DefaultAccordionTrigger);
export const ConfirmDialog = passthrough('ConfirmDialog', DefaultConfirmDialog); export const DataTable = passthrough('DataTable', DefaultDataTable); export const Dialog = passthrough('Dialog', DefaultDialog); export const DialogContent = refPassthrough('DialogContent', DefaultDialogContent); export const DialogTitle = refPassthrough('DialogTitle', DefaultDialogTitle);
export const DropdownMenu = passthrough('DropdownMenu', DefaultDropdownMenu); export const DropdownMenuContent = passthrough('DropdownMenuContent', DefaultDropdownMenuContent); export const DropdownMenuItem = passthrough('DropdownMenuItem', DefaultDropdownMenuItem); export const DropdownMenuSeparator = passthrough('DropdownMenuSeparator', DefaultDropdownMenuSeparator); export const DropdownMenuTrigger = passthrough('DropdownMenuTrigger', DefaultDropdownMenuTrigger);
export const Paginator = passthrough('Paginator', DefaultPaginator); export const ResourceImportDialog = passthrough('ResourceImportDialog', DefaultResourceImportDialog); export const SelectContent = passthrough('SelectContent', DefaultSelectContent); export const SelectItem = passthrough('SelectItem', DefaultSelectItem); export const SelectTrigger = passthrough('SelectTrigger', DefaultSelectTrigger); export const SelectValue = passthrough('SelectValue', DefaultSelectValue); export const StatusBadge = passthrough('StatusBadge', DefaultStatusBadge); export const UIButton = passthrough('UIButton', DefaultUIButton);
export { KnowledgeGraphCanvas };
export { DIALOG_CANCEL_BUTTON_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { DIALOG_FOOTER_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { DIALOG_PRIMARY_BUTTON_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { MENU_CONTENT_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { MENU_ITEM_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { MENU_ITEM_DANGER_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { MOBILE_CARD_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { OUTLINE_ACTION_BUTTON_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { OUTLINE_ACTION_BUTTON_SM_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { SEARCH_COMBO_BUTTON_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { SEARCH_COMBO_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { SEARCH_COMBO_INPUT_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles'; export { SELECT_TRIGGER_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles';
export const KnowledgeGraphVisualization = passthrough('KnowledgeGraphVisualization');
