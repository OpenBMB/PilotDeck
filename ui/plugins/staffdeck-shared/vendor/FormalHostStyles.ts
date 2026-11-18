

/**
 * Shared Tailwind class tokens for the enterprise list pages (SOP, 技能, 定时任务,
 * 员工记忆, 对话日志 …). Keeping them in one place avoids copy-pasting the exact
 * same dropdown / select / card styling into every page.
 */

/** Dropdown menu item (icon + label, 12px muted text). */
export const MENU_ITEM_CLASS =
  'cursor-pointer gap-[6px] rounded-[10px] px-[12px] py-[6px] text-[12px] text-[#858b9c] focus:text-[#18181a] [&_svg]:size-[14px]';

/** Destructive (red) dropdown menu item. */
export const MENU_ITEM_DANGER_CLASS =
  'cursor-pointer gap-[6px] rounded-[10px] px-[12px] py-[6px] text-[12px] text-[#d20b0b] focus:bg-[#fce7e7] focus:text-[#d20b0b] focus:[&_svg]:text-[#d20b0b]! [&_svg]:size-[14px]';

/** Dropdown menu popover container (rounded white card + soft shadow). */
export const MENU_CONTENT_CLASS =
  'flex w-auto min-w-[140px] flex-col gap-[4px] rounded-[14px] border-0 bg-white p-[4px] shadow-[0px_0px_8px_rgba(0,0,0,0.1)] ring-0 [--accent:#F6F6F6] [--accent-foreground:#18181A]';

/** shadcn `Select` trigger styled to match the 34px filter controls. */
export const SELECT_TRIGGER_CLASS =
  'h-[34px] data-[size=default]:h-[34px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white text-[12px] text-[#464c5e] shadow-none data-placeholder:text-[#858b9c] hover:border-[#cbd3e6] focus-visible:border-[#18181a] focus-visible:ring-0';

/** Mobile (<768px) list card wrapper. */
export const MOBILE_CARD_CLASS =
  'min-w-0 rounded-[8px] border border-[#eceef1] bg-white p-[14px]';

/** Dialog footer bar — white background, top border, right-aligned actions. */
export const DIALOG_FOOTER_CLASS =
  'flex items-center justify-end gap-[8px] bg-white px-[24px] py-[12px]';

/** Standard dialog cancel button. */
export const DIALOG_CANCEL_BUTTON_CLASS =
  'h-[32px] min-w-[80px] rounded-[10px] border-[#e3e7f1] bg-white px-[12px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-[#18181a]';

/** Standard dialog primary confirm button. */
export const DIALOG_PRIMARY_BUTTON_CLASS =
  'h-[32px] min-w-[80px] rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]';

/** Standard outline action button (toolbar refresh, card actions, etc.). */
export const OUTLINE_ACTION_BUTTON_CLASS =
  'h-[34px] gap-[4px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[20px] text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6] hover:bg-white hover:text-[#18181a]';

/** Compact outline action button for inline card headers. */
export const OUTLINE_ACTION_BUTTON_SM_CLASS =
  'h-[32px] gap-[4px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[12px] text-[12px] font-normal text-[#464c5e] hover:border-[#cbd3e6] hover:bg-[#f6f6f6] hover:text-[#18181a] [&_svg:not([class*="size-"])]:size-[14px]';

/** Integrated search combo wrapper (input + submit button). */
export const SEARCH_COMBO_CLASS =
  'flex h-[32px] min-w-0 items-stretch overflow-hidden rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white transition-colors focus-within:border-[#18181a]';

/** Integrated search combo input field. */
export const SEARCH_COMBO_INPUT_CLASS =
  'min-w-0 flex-1 bg-transparent px-[14px] text-[14px] text-[#17191f] outline-none placeholder:text-[#c0c6d4]';

/** Integrated search combo submit button. */
export const SEARCH_COMBO_BUTTON_CLASS =
  'shrink-0 bg-[#18181a] px-[20px] text-[14px] font-normal text-white transition-colors hover:bg-[#303030] disabled:pointer-events-none disabled:opacity-50';


