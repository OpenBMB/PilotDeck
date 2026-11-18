import { isTeamScope } from '../../../staffdeck-shared/vendor/FormalHostContractHelpers';
import {
  createContext,
  createElement,
  forwardRef,
  useContext,
  useMemo,
  useState,
  useEffect,
  type ComponentType,
  type ReactNode,
} from 'react';
import { ChevronDown, Clipboard, Edit3, Eye, FilePlus2, FileText, History, MoreHorizontal, RefreshCw, Search, Trash2 } from 'lucide-react';
import SopVersionDetailDialog from './SopVersionDetailDialog';

export type EnterpriseAuthUser = { id?: string; username?: string; tenant_id?: string; role?: string; is_admin?: boolean };
export type AgentProfileRead = Record<string, any> & { id: string; name?: string; is_overall?: boolean; active?: boolean };
export type SkillRead = Record<string, any> & { id: string; skill_id: string; name: string; version: string; status: 'draft' | 'published' | 'archived'; updated_at: string };
export type SkillVersionRead = Record<string, any> & { id: string; skill_id?: string; name: string; version: string; updated_at: string; content?: any };
export type BadgeTone = 'blue' | 'green' | 'gray' | 'orange' | 'red' | string;

type Api = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
  blob?(path: string): Promise<Blob>;
};

type DataColumn = { key: string; title: ReactNode; render?: (row: any, index: number) => ReactNode; dataIndex?: PropertyKey; width?: number | string; align?: 'left' | 'center' | 'right'; className?: string; headClassName?: string; sticky?: 'left' | 'right' };
type HostComponent = ComponentType<any>;

export type SkillsPageHost = {
  editorQuery?(row: SkillRead): Record<string, string>;
  api: Api;
  navigate(path: string): void;
  tenantId: string;
  notify: { success(message: string): void; warning(message: string): void; error(message: string): void };
  components?: Partial<Record<string, HostComponent>>;
  icons?: Partial<Record<string, HostComponent>>;
  isEnterpriseAdmin(user?: EnterpriseAuthUser): boolean;
  canManageEmployeeAgent(agent: AgentProfileRead, user?: EnterpriseAuthUser): boolean;
  openGalleryAgentId(agents: AgentProfileRead[]): string;
  openGalleryImportSourceOptions(agents: AgentProfileRead[], label: string): Array<{ value: string; label: string }>;
  resourceCreatorName(row: Record<string, any>): string;
  visibleEmployeeAgents(agents: AgentProfileRead[], user?: EnterpriseAuthUser, options?: Record<string, any>): AgentProfileRead[];
  readEmployeeScope(): string;
  isTeamScope(value: string): boolean;
  useClientPagination<T>(items: T[], pageSize: number, resetKey: unknown): { pagedItems: T[]; page: number; pageCount: number; setPage(page: number): void };
};

const defaultNotify = {
  success: (_message: string) => {},
  warning: (_message: string) => {},
  error: (_message: string) => {},
};

function joinClasses(...values: Array<string | false | null | undefined>): string { return values.filter(Boolean).join(' '); }

function DefaultAppHeader({ title, userName }: any) {
  return <header className="mx-auto flex max-w-6xl items-center justify-between px-6 pt-6 text-sm"><strong>{title}</strong>{userName ? <span className="text-neutral-500">{userName}</span> : null}</header>;
}

function DefaultButton({ children, variant: _variant, ...props }: any) { return <button type="button" {...props}>{children}</button>; }
function DefaultStatusBadge({ children, tone }: any) { return <span data-tone={tone} className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">{children}</span>; }
function DefaultDetailField({ label, children }: any) { return <div className="flex flex-col gap-1"><span className="text-xs text-neutral-500">{label}</span><strong className="text-sm">{children}</strong></div>; }

export type DataTablePrimitives = {
  Table: HostComponent;
  TableHeader: HostComponent;
  TableBody: HostComponent;
  TableRow: HostComponent;
  TableHead: HostComponent;
  TableCell: HostComponent;
};

function DefaultTable({ children, className, ...props }: any) {
  return <div data-slot="table-container" className="relative w-full overflow-x-auto"><table data-slot="table" {...props} className={joinClasses('w-full caption-bottom text-sm', className)}>{children}</table></div>;
}
function DefaultTableHeader({ children, className, ...props }: any) { return <thead data-slot="table-header" {...props} className={joinClasses('[&_tr]:border-b', className)}>{children}</thead>; }
function DefaultTableBody({ children, className, ...props }: any) { return <tbody data-slot="table-body" {...props} className={joinClasses('[&_tr:last-child]:border-0', className)}>{children}</tbody>; }
function DefaultTableRow({ children, className, ...props }: any) { return <tr data-slot="table-row" {...props} className={joinClasses('border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted', className)}>{children}</tr>; }
function DefaultTableHead({ children, className, ...props }: any) { return <th data-slot="table-head" {...props} className={joinClasses('h-10 px-2 text-left align-middle font-medium text-foreground', className)}>{children}</th>; }
function DefaultTableCell({ children, className, ...props }: any) { return <td data-slot="table-cell" {...props} className={joinClasses('p-2 align-middle', className)}>{children}</td>; }

export const defaultDataTablePrimitives: DataTablePrimitives = {
  Table: DefaultTable, TableHeader: DefaultTableHeader, TableBody: DefaultTableBody,
  TableRow: DefaultTableRow, TableHead: DefaultTableHead, TableCell: DefaultTableCell,
};

const TABLE_ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;
const TABLE_HEAD = 'h-[36px] bg-[#f2f3f7] px-[16px] py-[12px] align-middle text-[12px] font-normal text-[#464c5e]';
const TABLE_BODY = 'px-[16px] py-[12px] align-middle text-[12px] text-[#858b9c]';
const TABLE_HEIGHT = { default: 'min-h-[64px]', compact: 'min-h-[46px]' } as const;
const TABLE_BORDER = 'border border-[#f2f3f7]';
const STICKY_HEAD = { left: 'sticky left-0 z-20 border-r border-[#e3e6ed] bg-[#f2f3f7]', right: 'sticky right-0 z-20 border-l border-[#e3e6ed] bg-[#f2f3f7]' } as const;
const STICKY_BODY = { left: 'sticky left-0 z-10 border-r border-[#e3e6ed]', right: 'sticky right-0 z-10 border-l border-[#e3e6ed]' } as const;

export function BusinessDataTable({
  columns = [], data = [], rowKey, loading = false, emptyText = '暂无数据', loadingText = '加载中…',
  onRowClick, size = 'default', striped = false, bordered = false, className, 'aria-label': ariaLabel,
  primitives = defaultDataTablePrimitives,
}: { columns?: DataColumn[]; data?: any[]; rowKey?: (row: any, index: number) => string | number; loading?: boolean; emptyText?: ReactNode; loadingText?: ReactNode; onRowClick?: (row: any, index: number) => void; size?: 'default' | 'compact'; striped?: boolean; bordered?: boolean; className?: string; 'aria-label'?: string; primitives?: DataTablePrimitives }) {
  const { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } = primitives;
  const fixedWidth = columns.every((column) => typeof column.width === 'number')
    ? columns.reduce((total, column) => total + (column.width as number), 0) : undefined;
  return <div className={joinClasses('overflow-hidden rounded-[14px] border border-[#f2f3f7]', className)}>
    <Table className="w-full table-fixed text-[12px]" style={fixedWidth ? { minWidth: fixedWidth } : undefined} aria-label={ariaLabel}>
      <TableHeader><TableRow className="border-0 hover:bg-transparent">{columns.map((column) => <TableHead
        key={column.key} style={column.width ? { width: column.width } : undefined}
        className={joinClasses(TABLE_HEAD, bordered && TABLE_BORDER, TABLE_ALIGN[column.align ?? 'left'], column.sticky && STICKY_HEAD[column.sticky], column.headClassName)}
      >{column.title}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{data.length > 0 ? data.map((row, index) => <TableRow
        key={rowKey?.(row, index) ?? row.id ?? index}
        onClick={onRowClick ? () => onRowClick(row, index) : undefined}
        className={joinClasses('group has-aria-expanded:bg-transparent', bordered ? 'border-0' : 'border-b border-[#f2f3f7] last:border-0', striped ? index % 2 === 1 ? 'bg-[#fbfbfb] hover:bg-[#f2f3f7]' : 'bg-white hover:bg-[#f2f3f7]' : 'hover:bg-[#fafbfc]', onRowClick && 'cursor-pointer')}
      >{columns.map((column) => <TableCell
        key={column.key}
        className={joinClasses(TABLE_BODY, TABLE_HEIGHT[size], bordered && TABLE_BORDER, TABLE_ALIGN[column.align ?? 'left'], column.sticky && STICKY_BODY[column.sticky], column.sticky && (striped && index % 2 === 1 ? 'bg-[#fbfbfb] group-hover:bg-[#f2f3f7]' : 'bg-white group-hover:bg-[#fafbfc]'), column.className)}
      >{column.render ? column.render(row, index) : column.dataIndex != null ? row[column.dataIndex] : null}</TableCell>)}</TableRow>)
        : <TableRow className="hover:bg-transparent"><TableCell colSpan={columns.length} className="h-[160px] text-center align-middle text-[13px] text-[#858b9c]">{loading ? loadingText : emptyText}</TableCell></TableRow>}</TableBody>
    </Table>
  </div>;
}

function DefaultPaginator({ page, pageCount, onChange, ...props }: any) {
  if (!pageCount || pageCount < 2) return null;
  return <nav {...props} className={joinClasses('flex items-center gap-2 text-xs', props.className)}><button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button><span>{page} / {pageCount}</span><button type="button" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>下一页</button></nav>;
}

function DefaultConfirmDialog({ open, title, description, confirmText = '确认', onOpenChange, onConfirm, loading }: any) {
  if (!open) return null;
  return <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4"><section className="w-[min(460px,100%)] rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900"><h2 className="font-semibold">{title}</h2><p className="mt-2 text-sm text-neutral-600">{description}</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => onOpenChange?.(false)}>取消</button><button type="button" disabled={loading} onClick={onConfirm}>{confirmText}</button></div></section></div>;
}

function DefaultDialog({ open, onOpenChange, children }: any) { return open ? <div role="dialog" aria-modal="true" className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4" onMouseDown={(event) => event.target === event.currentTarget && onOpenChange?.(false)}>{children}</div> : null; }
function DefaultDialogContent({ children, className }: any) { return <section className={joinClasses('max-h-[calc(100dvh-2rem)] w-[min(960px,100%)] overflow-auto rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900', className)}>{children}</section>; }
function DefaultDialogTitle({ children, className }: any) { return <h2 className={joinClasses('text-base font-semibold', className)}>{children}</h2>; }

type DropdownContextValue = { open: boolean; setOpen(open: boolean): void };
const DropdownContext = createContext<DropdownContextValue | null>(null);
function DefaultDropdownMenu({ children }: any) { const [open, setOpen] = useState(false); return <DropdownContext.Provider value={{ open, setOpen }}><div className="relative inline-flex">{children}</div></DropdownContext.Provider>; }
function DefaultDropdownTrigger({ children, asChild: _asChild, onClick, ...props }: any) { const state = useContext(DropdownContext); return <button type="button" {...props} onClick={(event) => { onClick?.(event); state?.setOpen(!state.open); }}>{children}</button>; }
function DefaultDropdownContent({ children, className }: any) { const state = useContext(DropdownContext); if (!state?.open) return null; return <div className={joinClasses('absolute right-0 top-full z-50 mt-1 min-w-44 rounded-md border bg-white p-1 shadow-lg dark:bg-neutral-900', className)}>{children}</div>; }
function DefaultDropdownItem({ children, onSelect, disabled, className, variant: _variant }: any) { const state = useContext(DropdownContext); return <button type="button" disabled={disabled} className={joinClasses('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800', className)} onClick={() => { onSelect?.(); state?.setOpen(false); }}>{children}</button>; }
function DefaultDropdownSeparator({ className }: any) { return <div className={joinClasses('my-1 h-px bg-neutral-200', className)} />; }

type SelectContextValue = { value: string; label: string; setLabel(label: string): void; onValueChange?(value: string): void; open: boolean; setOpen(open: boolean): void };
const SelectContext = createContext<SelectContextValue | null>(null);
function DefaultSelect({ value, onValueChange, children }: any) { const [open, setOpen] = useState(false); const [label, setLabel] = useState(''); return <SelectContext.Provider value={{ value, label, setLabel, onValueChange, open, setOpen }}><div className="relative inline-flex">{children}</div></SelectContext.Provider>; }
function DefaultSelectTrigger({ children, className, ...props }: any) { const state = useContext(SelectContext); return <button type="button" role="combobox" aria-expanded={Boolean(state?.open)} aria-haspopup="listbox" {...props} className={joinClasses('inline-flex h-9 items-center justify-between gap-2 rounded border px-3 text-sm', className)} onClick={() => state?.setOpen(!state.open)}>{children}<ChevronDown className="size-3.5" /></button>; }
function DefaultSelectValue({ placeholder }: any) { const state = useContext(SelectContext); return <span>{state?.label || state?.value || placeholder}</span>; }
function DefaultSelectContent({ children, className }: any) { const state = useContext(SelectContext); return state?.open ? <div role="listbox" className={joinClasses('absolute left-0 top-full z-50 mt-1 min-w-full rounded border bg-white p-1 shadow-lg dark:bg-neutral-900', className)}>{children}</div> : null; }
function DefaultSelectItem({ value, children, className }: any) { const state = useContext(SelectContext); return <button type="button" role="option" aria-selected={state?.value === value} className={joinClasses('block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800', className)} onClick={() => { state?.setLabel(String(children)); state?.onValueChange?.(value); state?.setOpen(false); }}>{children}</button>; }

export type ImportSourceOption = { value: string; label: string };
export type ImportChoiceItem = { id: string; label: ReactNode };

export type ResourceImportDialogProps = {
  open: boolean;
  loading: boolean;
  icon: ReactNode;
  title: string;
  targetPlaceholder?: string;
  targetLabel?: string;
  targets?: ImportSourceOption[];
  targetId?: string;
  sourcePlaceholder: string;
  sources: ImportSourceOption[];
  sourceId: string;
  itemsLabel: string;
  items: ImportChoiceItem[];
  selectedIds: string[];
  emptyText: string;
  emptySourceText?: string;
  note: ReactNode;
  submitText?: string;
  onTargetChange?: (value: string) => void;
  onSourceChange: (value: string) => void;
  onSelectedChange: (ids: string[]) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export type ResourceImportPrimitives = {
  Dialog: HostComponent;
  DialogContent: HostComponent;
  DialogTitle: HostComponent;
  Select: HostComponent;
  SelectTrigger: HostComponent;
  SelectValue: HostComponent;
  SelectContent: HostComponent;
  SelectItem: HostComponent;
  Checkbox: HostComponent;
  Button: HostComponent;
};

function DefaultCheckbox({ checked, onCheckedChange }: any) {
  return <input type="checkbox" checked={checked} onChange={(event) => onCheckedChange?.(event.target.checked)} />;
}

export const defaultResourceImportPrimitives: ResourceImportPrimitives = {
  Dialog: DefaultDialog, DialogContent: DefaultDialogContent, DialogTitle: DefaultDialogTitle,
  Select: DefaultSelect, SelectTrigger: DefaultSelectTrigger, SelectValue: DefaultSelectValue,
  SelectContent: DefaultSelectContent, SelectItem: DefaultSelectItem,
  Checkbox: DefaultCheckbox, Button: DefaultButton,
};

const IMPORT_SELECT_TRIGGER_CLASS = 'h-[34px] data-[size=default]:h-[34px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white text-[12px] text-[#464c5e] shadow-none data-placeholder:text-[#858b9c] hover:border-[#cbd3e6] focus-visible:border-[#18181a] focus-visible:ring-0';

export function BusinessResourceImportDialog({
  primitives = defaultResourceImportPrimitives,
  open, loading, icon, title, targetPlaceholder, targetLabel = '复制到', targets, targetId,
  sourcePlaceholder, sources, sourceId, itemsLabel, items, selectedIds, emptyText,
  emptySourceText = '请先选择复制来源', note, submitText = '复制',
  onTargetChange, onSourceChange, onSelectedChange, onClose, onSubmit,
}: ResourceImportDialogProps & { primitives?: ResourceImportPrimitives }) {
  const { Dialog, DialogContent, DialogTitle, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Checkbox, Button } = primitives;
  const showTargetSelect = Boolean(targets && onTargetChange);
  const effectiveSourceId = sourceId || (sources.length === 1 ? sources[0].value : '');

  useEffect(() => {
    if (!open || sourceId || sources.length !== 1) return;
    onSourceChange(sources[0].value);
  }, [onSourceChange, open, sourceId, sources]);

  const toggle = (id: string, checked: boolean) => {
    onSelectedChange(checked ? [...selectedIds, id] : selectedIds.filter((value) => value !== id));
  };

  return <Dialog open={open} onOpenChange={(next: boolean) => !next && onClose()}>
    <DialogContent aria-describedby={undefined} className="flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[640px]">
      <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
        {icon}
        <DialogTitle className="text-[14px] font-normal leading-none text-[#757f9c]">{title}</DialogTitle>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto px-[12px]">
        {showTargetSelect && <div className="flex flex-col gap-[6px]">
          <span className="text-[11px] font-semibold text-[#858b9c]">{targetLabel}</span>
          <Select value={targetId || undefined} onValueChange={onTargetChange}>
            <SelectTrigger aria-label={targetLabel} className={joinClasses(IMPORT_SELECT_TRIGGER_CLASS, 'w-full')}>
              <SelectValue placeholder={targetPlaceholder || targetLabel} />
            </SelectTrigger>
            <SelectContent>{(targets || []).map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>}
        <div className="flex flex-col gap-[6px]">
          <span className="text-[11px] font-semibold text-[#858b9c]">复制来源</span>
          <div className="relative">
            <select value={effectiveSourceId} onChange={(event) => onSourceChange(event.target.value)} className={joinClasses(IMPORT_SELECT_TRIGGER_CLASS, 'w-full appearance-none px-3 pr-9 outline-none disabled:cursor-not-allowed disabled:opacity-60')}>
              <option value="" disabled>{sourcePlaceholder}</option>
              {sources.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[#858b9c]" />
          </div>
        </div>
        <div className="flex flex-col gap-[6px]">
          <span className="text-[11px] font-semibold text-[#858b9c]">{itemsLabel}</span>
          <div className="max-h-[300px] overflow-y-auto rounded-[10px] border border-[#eef0f4] p-[6px]">
            {items.length === 0 ? <div className="py-[28px] text-center text-[12px] text-[#858b9c]">{sourceId ? emptyText : emptySourceText}</div>
              : items.map((item) => <label key={item.id} className="flex cursor-pointer items-center gap-[10px] rounded-[8px] px-[8px] py-[7px] hover:bg-[#f6f6f6]">
                <Checkbox checked={selectedIds.includes(item.id)} onCheckedChange={(checked: boolean) => toggle(item.id, checked === true)} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[#18181a]">{item.label}</span>
              </label>)}
          </div>
        </div>
        <p className="text-[12px] leading-[1.6] text-[#858b9c]">{note}</p>
      </div>
      <div className="flex items-center justify-end gap-[8px] px-[12px]">
        <Button variant="outline" disabled={loading} onClick={onClose} className="h-[32px] w-[80px] rounded-[10px] border-[#e3e7f1] bg-white px-[12px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-[#18181a]">取消</Button>
        <Button disabled={loading} onClick={onSubmit} className="h-[32px] w-[80px] rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]">{submitText}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

function DefaultHostIcon({ name, ...props }: { name: string; [key: string]: any }) { const icons: Record<string, any> = { IconAdd: FilePlus2, IconChevronDown: ChevronDown, IconClear: Search, IconClipboard: Clipboard, IconEdit: Edit3, IconHistory: History, IconMore: MoreHorizontal, IconRefresh: RefreshCw, IconSearch: Search, IconSkill: FileText, IconTrash: Trash2 }; const Icon = icons[name] || FileText; return <Icon {...props} />; }

const defaultHost: SkillsPageHost = {
  api: { get: async () => { throw new Error('StaffDeck Skills API is not configured'); }, post: async () => { throw new Error('StaffDeck Skills API is not configured'); }, put: async () => { throw new Error('StaffDeck Skills API is not configured'); }, delete: async () => { throw new Error('StaffDeck Skills API is not configured'); } },
  navigate: (path) => { window.location.assign(path); },
  tenantId: 'tenant_demo', notify: defaultNotify,
  isEnterpriseAdmin: (user) => Boolean(user?.is_admin), canManageEmployeeAgent: () => true,
  openGalleryAgentId: (agents) => agents.find((agent) => agent.is_overall)?.id || '', openGalleryImportSourceOptions: (agents) => agents.filter((agent) => agent.is_overall).map((agent) => ({ value: agent.id, label: agent.name || agent.id })),
  resourceCreatorName: (row) => String(row.created_by_name || row.creator_name || ''), visibleEmployeeAgents: (agents, _user, options = {}) => agents.filter((agent) => !agent.is_overall && (!options.activeOnly || agent.active !== false) && agent.id !== options.excludeAgentId), readEmployeeScope: () => '', isTeamScope,
  useClientPagination: <T,>(items: T[], pageSize: number, _resetKey: unknown) => { const [page, setPage] = useState(1); const pageCount = Math.max(1, Math.ceil(items.length / pageSize)); return { page: Math.min(page, pageCount), setPage, pageCount, pagedItems: items.slice((Math.min(page, pageCount) - 1) * pageSize, Math.min(page, pageCount) * pageSize) }; },
};

const HostContext = createContext<SkillsPageHost>(defaultHost);

export function SkillsPageHostProvider({ value, children }: { value: SkillsPageHost; children: ReactNode }) { return <HostContext.Provider value={value}>{children}</HostContext.Provider>; }
export function useSkillsPageHost(): SkillsPageHost { return useContext(HostContext); }
export { cn } from '../../../staffdeck-shared/vendor/FormalUtils';
export { MENU_CONTENT_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles';
export { MENU_ITEM_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles';
export { MENU_ITEM_DANGER_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles';
export { MOBILE_CARD_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles';
export { SELECT_TRIGGER_CLASS } from '../../../staffdeck-shared/vendor/FormalHostStyles';

const componentDefaults: Record<string, HostComponent> = {
  AppHeader: DefaultAppHeader, ConfirmDialog: DefaultConfirmDialog, DataTable: BusinessDataTable, DetailField: DefaultDetailField, Dialog: DefaultDialog, DialogContent: DefaultDialogContent, DialogTitle: DefaultDialogTitle,
  DropdownMenu: DefaultDropdownMenu, DropdownMenuContent: DefaultDropdownContent, DropdownMenuItem: DefaultDropdownItem, DropdownMenuSeparator: DefaultDropdownSeparator, DropdownMenuTrigger: DefaultDropdownTrigger,
  Paginator: DefaultPaginator, ResourceImportDialog: BusinessResourceImportDialog, Select: DefaultSelect, SelectContent: DefaultSelectContent, SelectItem: DefaultSelectItem, SelectTrigger: DefaultSelectTrigger, SelectValue: DefaultSelectValue,
  StatusBadge: DefaultStatusBadge, UIButton: DefaultButton,
  Accordion: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  AccordionItem: ({ children, ...props }: any) => <details {...props}>{children}</details>,
  AccordionTrigger: ({ children, ...props }: any) => <summary {...props}>{children}</summary>,
  AccordionContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
};

function component(name: string): HostComponent {
  return refComponent(name);
}
function refComponent(name: string): HostComponent {
  return forwardRef<any, any>((props, ref) => {
    const host = useSkillsPageHost();
    const injected = host.components?.[name];
    return createElement(injected || componentDefaults[name], injected ? { ...props, ref } : props);
  });
}

export const AppHeader = component('AppHeader');
export const ConfirmDialog = component('ConfirmDialog');
export const DataTable = component('DataTable');
export const DetailField = component('DetailField');
export const Dialog = component('Dialog');
export const DialogContent = refComponent('DialogContent');
export const DialogTitle = refComponent('DialogTitle');
export const DropdownMenu = component('DropdownMenu');
export const DropdownMenuContent = component('DropdownMenuContent');
export const DropdownMenuItem = component('DropdownMenuItem');
export const DropdownMenuSeparator = component('DropdownMenuSeparator');
export const DropdownMenuTrigger = component('DropdownMenuTrigger');
export const Paginator = component('Paginator');
export const ResourceImportDialog = component('ResourceImportDialog');
export const Select = component('Select');
export const SelectContent = component('SelectContent');
export const SelectItem = component('SelectItem');
export const SelectTrigger = component('SelectTrigger');
export const SelectValue = component('SelectValue');
export const StatusBadge = component('StatusBadge');
export const UIButton = component('UIButton');
export const Accordion = component('Accordion');
export const AccordionItem = component('AccordionItem');
export const AccordionTrigger = component('AccordionTrigger');
export const AccordionContent = component('AccordionContent');

function icon(name: string): HostComponent { return (props: any) => { const host = useSkillsPageHost(); return createElement(host.icons?.[name] || DefaultHostIcon, { name, ...props }); }; }
export const IconAdd = icon('IconAdd');
export const IconChevronDown = icon('IconChevronDown');
export const IconClear = icon('IconClear');
export const IconClipboard = icon('IconClipboard');
export const IconEdit = icon('IconEdit');
export const IconHistory = icon('IconHistory');
export const IconMore = icon('IconMore');
export const IconRefresh = icon('IconRefresh');
export const IconSearch = icon('IconSearch');
export const IconSkill = icon('IconSkill');
export const IconTrash = icon('IconTrash');
export { SopVersionDetailDialog };
