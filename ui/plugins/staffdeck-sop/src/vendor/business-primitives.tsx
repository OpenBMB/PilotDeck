import {
  BusinessDataTable, BusinessResourceImportDialog, defaultResourceImportPrimitives,
  type DataTablePrimitives, type ResourceImportDialogProps, type ResourceImportPrimitives,
} from './SkillsPageHost';
import { PilotDeckDialog, PilotDeckDialogContent, PilotDeckDialogTitle } from '../../../staffdeck-shared/vendor/dialog-primitives';
import * as Primitive from '../../../staffdeck-shared/vendor/formal-primitives';

function classNames(base: string, extra?: string) { return `${base} ${extra || ''}`; }

const tablePrimitives: DataTablePrimitives = {
  Table: ({ children, className, ...props }: any) => <div className="relative w-full overflow-x-auto"><table {...props} className={classNames('w-full caption-bottom text-sm', className)}>{children}</table></div>,
  TableHeader: ({ children, className, ...props }: any) => <thead {...props} className={classNames('[&_tr]:border-b', className)}>{children}</thead>,
  TableBody: ({ children, className, ...props }: any) => <tbody {...props} className={classNames('[&_tr:last-child]:border-0', className)}>{children}</tbody>,
  TableRow: ({ children, className, ...props }: any) => <tr {...props} className={classNames('border-b transition-colors', className)}>{children}</tr>,
  TableHead: ({ children, className, ...props }: any) => <th {...props} className={classNames('h-10 px-2 text-left align-middle font-medium', className)}>{children}</th>,
  TableCell: ({ children, className, ...props }: any) => <td {...props} className={classNames('p-2 align-middle', className)}>{children}</td>,
};

export function PilotDeckDataTable(props: any) {
  return <BusinessDataTable {...props} primitives={tablePrimitives} />;
}

// The extracted formal layout uses a light palette for its labels and controls.
// Keep its surface consistent even when the surrounding PilotDeck page is dark.
const resourceImportPrimitives: ResourceImportPrimitives = {
  ...defaultResourceImportPrimitives,
  Select: Primitive.Select,
  SelectContent: Primitive.SelectContent,
  SelectItem: Primitive.SelectItem,
  SelectTrigger: Primitive.SelectTrigger,
  SelectValue: Primitive.SelectValue,
  Checkbox: Primitive.Checkbox,
  Button: Primitive.UIButton,
  Dialog: PilotDeckDialog,
  DialogContent: PilotDeckDialogContent,
  DialogTitle: PilotDeckDialogTitle,
};

export function PilotDeckResourceImportDialog(props: ResourceImportDialogProps) {
  return <BusinessResourceImportDialog {...props} primitives={resourceImportPrimitives} />;
}
