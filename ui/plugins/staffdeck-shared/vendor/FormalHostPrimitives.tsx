import { createContext, createElement, forwardRef, useContext, type ReactNode } from 'react';

type Primitives = Record<string, any>;
const Context = createContext<Primitives>({});
export function FormalHostPrimitiveProvider({ value, children }: { value: Primitives; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
function primitive(name: string) {
  return forwardRef<any, any>((props, ref) => {
    const injected = useContext(Context)[name];
    if (!injected) throw new Error(`Formal Host primitive is unavailable: ${name}`);
    return createElement(injected, { ...props, ref });
  });
}
export { cn } from './FormalUtils';
export const AlertDialog = primitive('AlertDialog');
export const AlertDialogContent = primitive('AlertDialogContent');
export const AlertDialogDescription = primitive('AlertDialogDescription');
export const AlertDialogTitle = primitive('AlertDialogTitle');
export const Button = primitive('Button');
export const Switch = primitive('Switch');
export const Tooltip = primitive('Tooltip');
export const TooltipProvider = primitive('TooltipProvider');
export const TooltipContent = primitive('TooltipContent');
export const TooltipTrigger = primitive('TooltipTrigger');
export const DropdownMenu = primitive('DropdownMenu');
export const DropdownMenuContent = primitive('DropdownMenuContent');
export const DropdownMenuItem = primitive('DropdownMenuItem');
export const DropdownMenuTrigger = primitive('DropdownMenuTrigger');
export const Pagination = primitive('Pagination');
export const PaginationContent = primitive('PaginationContent');
export const PaginationItem = primitive('PaginationItem');
export const InfoCircleOutlined = primitive('InfoCircleOutlined');
export const CheckOutlined = primitive('CheckOutlined');
export const IconChevronDown = primitive('IconChevronDown');
export const IconWarningFill = primitive('IconWarningFill');
