const cn = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ');

// Enterprise button + card patterns (match GeneralSkillsPage)
export const SECTION_CARD_CLASS =
  'flex flex-col gap-[24px] rounded-[20px_20px_0_0] bg-[#FFF] p-[18px] shadow-[0_-4px_16px_0_rgba(0,0,0,0.05)]';
export const SECTION_CARD_TITLE_CLASS = 'text-[14px] font-medium text-[#18181a]';
export const RETURN_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-5 text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6]! hover:bg-white! hover:text-[#18181a]! focus-visible:border-[#cbd3e6]! focus-visible:ring-0 aria-expanded:border-[#cbd3e6]! aria-expanded:bg-white! aria-expanded:text-[#18181a]! data-[state=open]:border-[#cbd3e6]! data-[state=open]:bg-white! data-[state=open]:text-[#18181a]!';
export const PRIMARY_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] bg-[#18181a] px-5 text-[12px] font-normal text-white hover:bg-[#303030]';

// Page layout — flex column so header + actions stay auto-sized and workbench fills the rest
export const DISTILL_PAGE_CLASS =
  'flex h-full min-h-0 flex-col overflow-hidden box-border px-[26px] pt-[10px] pb-[22px] max-[900px]:px-[4px]';
export const DISTILL_ACTIONS_CLASS = 'mt-[20px] mb-[16px] flex shrink-0 flex-wrap items-center justify-end gap-[16px]';
export const WORKBENCH_CLASS =
  'grid min-h-0 flex-1 grid-cols-1 gap-[20px] overflow-hidden xl:grid-cols-[minmax(320px,0.72fr)_minmax(0,1.28fr)] xl:items-stretch';

// Section cards
export const DISTILL_CARD_CLASS = cn(SECTION_CARD_CLASS, 'min-h-0 min-w-0 overflow-hidden');
export const DISTILL_CARD_BODY_CLASS = 'flex min-h-0 flex-1 flex-col overflow-hidden';
export const DISTILL_CARD_HEADER_CLASS =
  'flex shrink-0 items-center justify-between gap-[12px]';
export const CARD_OUTLINE_BUTTON_CLASS = RETURN_BUTTON_CLASS;

export const CHAT_CARD_CLASS = DISTILL_CARD_CLASS;
export const CHAT_CARD_BODY_CLASS = DISTILL_CARD_BODY_CLASS;
export const CHAT_CARD_DRAGGING_CLASS = 'ring-1 ring-[#18181a]/15';
export const CHAT_CARD_FULLSCREEN_CLASS =
  'fixed top-[77px] bottom-[19px] left-[19px] z-[96] h-auto! w-[min(380px,36vw)] gap-[12px] rounded-none! border-r border-[#e1e6ee] p-[14px]! shadow-none! sm:top-[83px] sm:bottom-[25px] sm:left-[25px]';
export const SOURCE_CARD_CLASS = DISTILL_CARD_CLASS;

// Chat panel
export const CHAT_PANEL_CLASS = 'relative flex h-full min-w-0 flex-col';
export const CHAT_UPLOAD_DROP_HINT_CLASS =
  'pointer-events-none absolute inset-0 z-[2] grid place-items-center rounded-[12px] border border-dashed border-[#d1d5db] bg-white/88 text-[14px] font-medium text-[#18181a] backdrop-blur-sm';
export const CHAT_MESSAGES_CLASS =
  'min-h-0 min-w-0 flex-1 overflow-auto bg-[#fbfcfd] px-[20px] py-[18px]';
export const CHAT_COMPOSER_SHELL_CLASS =
  'shrink-0 border-t border-[#eceef1] pt-[16px]';
export const CHAT_COMPOSER_CLASS = 'grid gap-[12px]';
export const CHAT_TEXTAREA_CLASS =
  'h-[112px] min-h-[96px] max-h-[160px] resize-none overflow-y-auto field-sizing-fixed rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-[#fafafa] px-[14px] py-[12px] text-[13px] leading-[1.65] text-[#18181a] shadow-none placeholder:text-[#c0c6d4] focus-visible:border-[#18181a] focus-visible:ring-0';
export const CHAT_ACTIONS_CLASS = 'flex flex-wrap items-center justify-between gap-[10px]';
export const CHAT_ACTIONS_GROUP_CLASS = 'flex flex-wrap items-center justify-end gap-[8px]';

export const CHAT_ROW_BASE_CLASS = 'mb-[16px] flex min-w-0';
export const CHAT_ROW_USER_CLASS = 'justify-end mb-[30px]';
export const CHAT_ROW_ASSISTANT_CLASS = '';

export const CHAT_BUBBLE_BASE_CLASS =
  'relative box-border max-w-[min(720px,92%)] min-w-0 rounded-[12px] border border-[#eceef1] bg-white px-[14px] py-[12px] text-[13px] leading-[1.65] whitespace-pre-wrap wrap-anywhere text-[#18181a]';
export const CHAT_BUBBLE_ASSISTANT_CLASS = 'border-transparent bg-white shadow-none';
export const CHAT_BUBBLE_USER_CLASS =
  'max-w-[min(620px,80%)] rounded-[16px] border-transparent bg-[#f0eee9] shadow-none';
export const CHAT_BUBBLE_USER_HAS_ATTACHMENTS_CLASS =
  'grid max-w-[min(620px,74%)] justify-items-end gap-[8px] rounded-none border-0 bg-transparent p-0 shadow-none';
export const CHAT_BUBBLE_USER_EDITING_CLASS =
  'min-w-[min(360px,72vw)] max-w-[84%] rounded-[16px] border-transparent bg-[#f0eee9] px-[14px] py-[12px]';
export const CHAT_BUBBLE_USER_EDITING_ATTACHMENTS_CLASS =
  'min-w-[min(520px,100%)] max-w-[min(620px,74%)] rounded-none border-0 bg-transparent p-0';

export const CHAT_CONTENT_CLASS = 'min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere';
export const CHAT_CONTENT_USER_ATTACHMENTS_CLASS =
  'max-w-full rounded-[18px] bg-[#f0eee9] px-[15px] py-[13px]';

export const CHAT_THINKING_BLOCK_CLASS = 'mb-[10px] min-w-0 max-w-full';
export const CHAT_THINKING_BUTTON_CLASS =
  'inline-flex cursor-pointer items-center gap-[7px] border-0 bg-transparent p-0 text-[13px] font-semibold leading-[1.5] text-[#62625e] hover:text-[#18181a]';
export const CHAT_THINKING_DETAILS_CLASS =
  'mb-[4px] mt-[10px] box-border grid max-w-full min-w-0 gap-[6px] rounded-[10px] border border-[#eceef1] bg-[#fafafa] p-[10px_12px] text-[12px] leading-[1.55] text-[#858b9c]';
export const CHAT_THINKING_DETAIL_CLASS =
  'relative min-w-0 pl-[14px] wrap-anywhere before:absolute before:left-0 before:top-[0.72em] before:size-[5px] before:rounded-full before:bg-[#d1d5db] before:content-[""]';

export const CHAT_FAILURE_CLASS =
  'mb-[10px] min-w-0 overflow-hidden rounded-[10px] border border-[#f1cccc] bg-[#fffafa] text-[12px] text-[#5f2525]';
export const CHAT_FAILURE_BUTTON_CLASS =
  'flex w-full cursor-pointer items-center gap-[8px] border-0 bg-transparent px-[11px] py-[9px] text-left transition-colors hover:bg-[#fff4f4]';
export const CHAT_FAILURE_ICON_CLASS =
  'inline-flex size-[20px] shrink-0 items-center justify-center rounded-full bg-[#fbe4e4] text-[12px] text-[#c93c3c]';
export const CHAT_FAILURE_SUMMARY_CLASS =
  'min-w-0 flex-1 truncate text-[12px] font-semibold text-[#9d3030]';
export const CHAT_FAILURE_STAGE_CLASS =
  'shrink-0 rounded-full border border-[#efd3d3] bg-white px-[7px] py-[2px] text-[10px] leading-[1.4] text-[#a95a5a]';
export const CHAT_FAILURE_DETAILS_CLASS =
  'grid gap-[9px] border-t border-[#f2dede] bg-white/70 px-[11px] py-[10px]';
export const CHAT_FAILURE_META_CLASS =
  'grid grid-cols-[54px_minmax(0,1fr)] gap-x-[8px] gap-y-[5px] text-[11px] leading-[1.5]';
export const CHAT_FAILURE_LABEL_CLASS = 'text-[#aa7777]';
export const CHAT_FAILURE_VALUE_CLASS = 'min-w-0 wrap-anywhere text-[#623838]';
export const CHAT_FAILURE_RAW_CLASS =
  'max-h-[180px] overflow-auto rounded-[7px] border border-[#f1dddd] bg-[#fffdfd] px-[9px] py-[8px] font-mono text-[11px] leading-[1.55] whitespace-pre-wrap wrap-anywhere text-[#6f3c3c]';
export const CHAT_FAILURE_COPY_CLASS =
  'inline-flex w-fit items-center gap-[5px] whitespace-nowrap rounded-[7px] border border-[#ead5d5] bg-white px-[8px] py-[5px] text-[11px] text-[#8d5151] transition-colors hover:border-[#d9b6b6] hover:text-[#6f3030] [&_svg]:size-[13px] [&_svg]:shrink-0 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.7]';

export const CHAT_ATTACHMENTS_CLASS = 'mb-[8px] grid gap-[7px]';
export const CHAT_ATTACHMENTS_USER_CLASS = 'mb-0 justify-items-end';
export const CHAT_ATTACHMENT_CLASS =
  'grid min-h-[46px] w-[min(260px,100%)] grid-cols-[32px_minmax(0,1fr)] items-center gap-[9px] rounded-[8px] border border-[#eceef1] bg-[#fbfaf8] px-[7px_10px_7px_7px] text-[#18181a] shadow-[0_5px_14px_rgba(45,39,30,0.035)]';
export const CHAT_ATTACHMENT_USER_CLASS = 'ml-auto bg-[#f8f7f3]';
export const CHAT_ATTACHMENT_ICON_CLASS =
  'inline-flex size-[32px] items-center justify-center rounded-[8px] bg-[#ef4444] text-[15px] text-white';
export const CHAT_ATTACHMENT_MAIN_CLASS = 'grid min-w-0 gap-px';
export const CHAT_ATTACHMENT_NAME_CLASS =
  'min-w-0 truncate text-[12px] font-semibold leading-[1.35]';
export const CHAT_ATTACHMENT_TYPE_CLASS = 'text-[11px] leading-[1.2] text-[#858b9c]';

export const CHAT_EDIT_PANEL_CLASS = 'grid gap-[10px]';
export const CHAT_EDIT_PANEL_USER_ATTACHMENTS_CLASS =
  'w-[min(520px,100%)] rounded-[16px] bg-[#f0eee9] px-[14px] py-[12px]';
export const CHAT_EDIT_TEXTAREA_CLASS =
  'min-h-[34px] resize-none border-0 bg-transparent p-0 text-[16px] leading-[1.65] text-[#18181a] shadow-none focus-visible:ring-0';
export const CHAT_EDIT_ACTIONS_CLASS = 'flex justify-end gap-[7px]';

export const CHAT_HOVER_ACTIONS_CLASS =
  'absolute right-[10px] bottom-[-26px] inline-flex items-center gap-[9px] text-[#858b9c] opacity-0 transition-opacity duration-150 group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100';
export const CHAT_TIME_CLASS = 'text-[12px] leading-none text-[#858b9c]';
export const CHAT_HOVER_BUTTON_CLASS =
  'inline-flex size-[17px] items-center justify-center border-0 bg-transparent p-0 text-[#858b9c] hover:text-[#18181a] disabled:cursor-not-allowed disabled:opacity-45';

export const CHAT_WARNING_CLASS =
  'mt-[12px] grid gap-[6px] rounded-[8px] border border-[#fed7aa] bg-[#fff7ed] p-[10px_12px] text-[12px] leading-[1.55] text-[#7c2d12]';
export const CHAT_WARNING_TITLE_CLASS =
  'inline-flex items-center gap-[6px] font-semibold text-[#9a3412]';
export const CHAT_WARNING_ITEM_CLASS =
  'relative whitespace-normal wrap-anywhere pl-[18px] before:absolute before:left-[6px] before:top-[0.72em] before:size-[4px] before:rounded-full before:bg-[#fb923c] before:content-[""]';

export const CHAT_CONFIRM_CLASS = 'mt-[12px] flex gap-[8px]';
export const CHAT_DECISION_CLASS = 'mt-[10px] text-[12px] text-[#858b9c]';

// Upload list
export const UPLOAD_LIST_CLASS =
  'grid max-h-[min(168px,30vh)] gap-[8px] overflow-y-auto overscroll-contain pr-[2px] [scrollbar-gutter:stable]';
export const UPLOAD_ITEM_BASE_CLASS =
  'grid min-h-[34px] min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-[8px] rounded-[10px] border border-[#eceef1] bg-[#fafafa] p-[6px_8px] text-[12px] text-[#18181a]';
export const UPLOAD_ITEM_ERROR_CLASS = 'border-[#fecaca] bg-[#fef2f2] text-[#d20b0b]';
export const UPLOAD_NAME_CLASS = 'min-w-0 truncate';
export const UPLOAD_STATUS_CLASS = 'max-w-[160px] truncate whitespace-nowrap text-[#858b9c]';

// Tool suggestions
export const TOOL_SUGGESTIONS_CLASS = 'mt-[12px] grid w-full min-w-0 max-w-full gap-[8px]';
export const TOOL_SUGGESTION_CLASS =
  'relative box-border max-w-full min-w-0 rounded-[10px] border border-[#eceef1] bg-[#fffdf9] px-[12px] py-[11px] shadow-[0_6px_16px_rgba(45,39,30,0.026)]';
export const TOOL_SUGGESTION_MAIN_CLASS = 'min-w-0 max-w-full pr-[118px]';
export const TOOL_SUGGESTION_HEAD_CLASS = 'mb-[4px] flex min-w-0 items-center gap-[7px]';
export const TOOL_SUGGESTION_TITLE_CLASS =
  'min-w-0 truncate text-[13px] font-semibold text-[#18181a]';
export const TOOL_SUGGESTION_DESC_CLASS =
  'min-w-0 text-[12px] leading-[1.55] wrap-anywhere text-[#858b9c]';
export const TOOL_SUGGESTION_META_CLASS =
  'mt-[7px] flex min-w-0 max-w-full items-center gap-[6px] text-[11px] text-[#858b9c]';
export const TOOL_METHOD_CLASS =
  'min-w-[44px] shrink-0 rounded-full border border-[#eceef1] bg-white px-[7px] py-px text-center text-[11px] font-semibold text-[#18181a]';
export const TOOL_SUGGESTION_ACTIONS_CLASS = 'absolute right-[12px] top-[10px] inline-flex items-center justify-end gap-[8px]';
export const TOOL_ACTION_GROUP_CLASS =
  'inline-flex items-center justify-center gap-[4px] rounded-full border border-[#e2dacd]/90 bg-white/78 p-[2px] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]';
export const TOOL_ACTION_GROUP_DETAIL_CLASS = 'size-[32px]';
export const TOOL_ACTION_BUTTON_CLASS =
  'size-[26px] min-w-[26px] rounded-full p-0 text-[#858b9c] hover:bg-[#f3f1eb] hover:text-[#18181a]';
export const TOOL_ACTION_CONFIRM_CLASS = 'text-[#166534] hover:bg-[#dcfce7] hover:text-[#14532d] disabled:text-[#166534]/32';
export const TOOL_ACTION_REJECT_CLASS = 'text-[#991b1b] hover:bg-[#fee2e2] hover:text-[#7f1d1d]';

export type ToolStatusBadgeVariant = 'success' | 'error' | 'running' | 'pending' | 'muted';

const TOOL_STATUS_BADGE_VARIANTS: Record<ToolStatusBadgeVariant, string> = {
  success: 'text-[#166534] bg-[#f0fdf4] border-[#bbf7d0]',
  error: 'text-[#991b1b] bg-[#fef2f2] border-[#fecaca]',
  running: 'text-[#854d0e] bg-[#fefce8] border-[#fde68a]',
  pending: 'text-[#92400e] bg-[#fffbeb] border-[#fed7aa]',
  muted: 'text-[#858b9c] bg-[#f7f5ef] border-[#eceef1]',
};

export const TOOL_STATUS_BADGE_BASE_CLASS =
  'inline-flex shrink-0 items-center rounded-full border px-[7px] py-px text-[11px] font-semibold leading-[1.45]';

export function toolStatusBadgeClass(status: ToolStatusBadgeVariant): string {
  return cn(TOOL_STATUS_BADGE_BASE_CLASS, TOOL_STATUS_BADGE_VARIANTS[status]);
}

// Rewrite model button (DropdownMenuTrigger — override outline variant ring/expanded state)
export const REWRITE_MODEL_BUTTON_CLASS =
  'inline-flex h-8 max-w-[220px] min-w-0 items-center gap-2 rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[12px] text-[12px] font-normal text-[#757f9c] shadow-none hover:border-[#cbd3e6]! hover:bg-white! hover:text-[#18181a]! focus-visible:border-[#cbd3e6]! focus-visible:ring-0 aria-expanded:border-[#cbd3e6]! aria-expanded:bg-white! aria-expanded:text-[#18181a]! data-[state=open]:border-[#cbd3e6]! data-[state=open]:bg-white! data-[state=open]:text-[#18181a]! [&>span:first-child]:min-w-0 [&>span:first-child]:truncate';

// Source toolbar + editor
export const SOURCE_TOOLBAR_CLASS =
  'mb-[12px] flex shrink-0 flex-wrap items-center gap-[8px] rounded-[10px] bg-[#fafafa] p-[8px]';
export const SOURCE_EMPTY_STATE_CLASS =
  'flex min-h-[240px] flex-1 flex-col items-center justify-center gap-[10px] rounded-[12px] border border-dashed border-[#e3e7f1] bg-[#fbfcfd] px-[24px] py-[32px] text-center';
export const SOURCE_EMPTY_TEXT_CLASS = 'text-[13px] leading-[20px] text-[#858b9c]';
export const SOURCE_MD_CLASS =
  'box-border grid min-h-0 min-w-0 w-full max-w-full flex-1 content-start gap-[14px] self-stretch overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable] pr-[clamp(6px,1vw,14px)]';
export const SOURCE_GROUP_TITLE_CLASS =
  'my-[2px_-2px] text-[13px] font-semibold text-[#18181a]';
export const SOURCE_STEPS_CLASS = 'grid gap-[12px]';
export const SOURCE_STEP_BLOCK_CLASS = 'grid gap-[10px]';

export const SOURCE_SECTION_CLASS =
  'relative box-border w-full cursor-pointer rounded-[10px] border border-[#eceef1] bg-white p-[16px] text-left select-text hover:border-[#04756f] hover:shadow-[0_8px_22px_rgba(4,117,111,0.08)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#18181a]';
export const SOURCE_SECTION_ACTIVE_CLASS = 'border-[#04756f] bg-[#f3fbf8] shadow-[0_8px_22px_rgba(4,117,111,0.08)]';
export const SOURCE_SECTION_CHANGED_CLASS =
  'border-[#04756f] bg-[#effaf6] shadow-[0_12px_30px_rgba(4,117,111,0.12)] transition-[background,border-color,box-shadow] duration-450';
export const SOURCE_SECTION_DIRTY_CLASS = 'bg-[#fffdf8] shadow-[inset_3px_0_0_#d8c7a4]';
export const SOURCE_SECTION_UPDATING_CLASS = 'animate-pulse';

export const SOURCE_RENDERED_CLASS = 'grid gap-[12px] text-[13px] leading-[1.7] text-[#18181a]';
export const SOURCE_META_LIST_CLASS = 'grid gap-[7px]';
export const SOURCE_STEP_HEADER_CLASS =
  'flex min-w-0 items-start justify-between gap-[12px] pr-[6px]';
export const SOURCE_LINE_CLASS =
  'grid min-h-[1.7em] min-w-0 max-w-full grid-cols-[132px_minmax(0,1fr)] items-start gap-[10px] max-[760px]:grid-cols-1';
export const SOURCE_LINE_COLLAPSIBLE_CLASS = '[&_.source-edit-field]:w-full';
export const SOURCE_LINE_READONLY_CLASS = '';
export const SOURCE_KEY_CLASS = 'text-[12px] font-semibold text-[#858b9c]';
export const SOURCE_VALUE_CLASS = 'min-w-0 w-full max-w-full whitespace-pre-wrap text-[#18181a]';
export const SOURCE_READONLY_VALUE_CLASS = 'block';
export const SOURCE_JSON_INLINE_CLASS =
  'm-0 max-w-full rounded-[8px] border border-[#eceef1] bg-[#f8f6ef]/72 p-[8px_10px] whitespace-pre-wrap wrap-anywhere text-[#18181a]';
export const SOURCE_EDIT_FIELD_CLASS = 'flex min-w-0 w-full max-w-full items-start';

const PILL_OUTLINE_BUTTON_BASE =
  'inline-flex cursor-pointer items-center justify-center gap-1 rounded-full border-[0.5px] border-[#e3e7f1] bg-white text-[12px] font-normal leading-none text-[#858b9c] shadow-none transition-colors hover:border-[#04756f]! hover:bg-white! hover:text-[#18181a]! focus-visible:border-[#04756f]! focus-visible:ring-0 focus-visible:outline-none focus-visible:text-[#18181a]! [&_.anticon]:inline-flex [&_.anticon]:shrink-0 [&_.anticon]:items-center [&_.anticon]:justify-center [&_.anticon_svg]:block';

export const NODE_INSERT_ROW_CLASS = 'flex justify-center';
export const NODE_INSERT_ROW_EDGE_CLASS = 'my-[2px]';
export const PILL_OUTLINE_BUTTON_CLASS = cn(PILL_OUTLINE_BUTTON_BASE, 'h-7 px-3');
export const PILL_OUTLINE_BUTTON_SM_CLASS = cn(PILL_OUTLINE_BUTTON_BASE, 'h-6 px-2');
export const NODE_INSERT_BUTTON_CLASS = PILL_OUTLINE_BUTTON_CLASS;

export const SOURCE_TITLE_INPUT_CLASS =
  'max-w-full rounded-[6px] border-transparent bg-transparent px-[6px] py-0 text-[18px] font-semibold leading-[1.5] shadow-none hover:border-[#eceef1] hover:bg-white focus-visible:border-[#eceef1] focus-visible:bg-white focus-visible:ring-0';
export const SOURCE_STEP_TITLE_EDIT_CLASS =
  'inline-grid w-full max-w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[6px] text-[15px] font-semibold [&>span:first-child]:whitespace-nowrap [&>span:first-child]:text-[#18181a]';
export const SOURCE_EDIT_INPUT_CLASS =
  'box-border min-w-0 max-w-full resize-none overflow-x-hidden overflow-y-hidden rounded-[6px] border-transparent bg-transparent px-[6px] py-[2px] leading-[1.65] wrap-anywhere shadow-none field-sizing-fixed hover:border-[#eceef1] hover:bg-white focus-visible:border-[#eceef1] focus-visible:bg-white focus-visible:ring-0';

export const SOURCE_COLLAPSIBLE_EDITOR_CLASS = 'grid min-w-0 w-full max-w-full gap-[8px]';
export const SOURCE_COLLAPSIBLE_HEAD_CLASS =
  'grid min-h-[38px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-[10px] rounded-[10px] border border-[#eceef1] bg-linear-to-b from-[#f8f7f4]/96 to-[#f4f2ed]/78 px-[12px] py-[6px] text-left text-[#858b9c] shadow-[inset_0_1px_0_rgba(255,255,255,0.74)] hover:border-[#d1d5db] hover:bg-white hover:text-[#18181a] focus-visible:outline-none';
export const SOURCE_COLLAPSIBLE_PREVIEW_CLASS = 'min-w-0 truncate text-[12px] leading-[1.5]';
export const SOURCE_COLLAPSIBLE_PREVIEW_MUTED_CLASS = 'text-[#858b9c]';
export const SOURCE_COLLAPSIBLE_TOGGLE_CLASS =
  'inline-flex h-[26px] shrink-0 items-center gap-[5px] rounded-full border border-[#eceef1] bg-white px-[9px] text-[12px] font-semibold leading-none text-[#858b9c]';

export const SOURCE_ACTION_EDITOR_CLASS = 'grid w-[min(820px,100%)] gap-[6px]';
export const SOURCE_ACTION_LIST_CLASS = 'flex max-h-[84px] flex-wrap gap-[6px] overflow-auto';
export const SOURCE_ACTION_LIST_EDITABLE_CLASS = 'min-w-0 flex-1 items-center';
export const SOURCE_ACTION_TOKEN_CLASS = 'group/token relative my-[2px] mr-[4px] inline-flex max-w-[min(100%,320px)] items-center';
export const SOURCE_ACTION_EDIT_BUTTON_CLASS =
  'inline-flex min-w-0 cursor-text items-center border-0 bg-transparent p-0 text-inherit focus-visible:rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#18181a]';
export const SOURCE_ACTION_REMOVE_CLASS =
  'absolute top-1/2 right-[5px] grid size-[14px] -translate-y-1/2 place-items-center rounded-full border-0 bg-transparent p-0 leading-none text-[#9399a8] opacity-0 transition-[color,background,opacity] duration-140 group-hover/token:opacity-100 group-focus-within/token:opacity-100 hover:bg-black/[0.055] hover:text-[#d20b0b] focus-visible:opacity-100 focus-visible:text-[#d20b0b] focus-visible:outline-none [&_svg]:block [&_svg]:size-[9px]';
export const SOURCE_ACTION_EMPTY_CLASS =
  'flex min-h-[42px] w-full min-w-0 items-center justify-between gap-[10px] rounded-[10px] border border-dashed border-[#dfe4eb] bg-[#fafbfc] px-[11px] py-[7px] text-[11px] leading-[1.45] text-[#858b9c]';
export const SOURCE_ACTION_ADD_CLASS = PILL_OUTLINE_BUTTON_SM_CLASS;
export const SOURCE_ACTION_PICKER_CLASS = 'inline-flex min-w-[min(280px,100%)] max-w-full';
export const SOURCE_ACTION_SELECT_CLASS =
  'h-[26px] min-w-0 w-full max-w-full rounded-full border border-[#eceef1] bg-white px-2 text-[12px] leading-[1.4] shadow-none';
export const SOURCE_EDIT_HINT_CLASS =
  'shrink-0 text-[11px] text-[#858b9c] opacity-0 group/action-editor:opacity-100';

export const SOURCE_SELECT_CLASS = 'min-w-[168px]';
export const CONDITION_EDITOR_CLASS =
  'grid min-w-0 w-full max-w-full grid-cols-1 items-start gap-x-[10px] gap-y-[8px]';
export const CONDITION_READABLE_CLASS =
  'col-span-full text-[12px] leading-[1.55] text-[#858b9c]';
export const CONDITION_PRESET_CLASS = 'min-w-[168px]';
export const CONDITION_INPUT_CLASS = 'w-full! min-w-0';

export const RETRY_POLICY_EDITOR_CLASS =
  'grid min-w-0 w-full max-w-full grid-cols-1 items-start gap-x-[10px] gap-y-[8px]';
export const RETRY_POLICY_FIELD_CLASS = 'grid min-w-0 gap-[4px] [&>span]:text-[11px] [&>span]:font-semibold [&>span]:leading-[1.3] [&>span]:text-[#858b9c]';

export const FLOW_RULE_EDITOR_CLASS = 'grid w-[min(1120px,100%)] gap-[10px]';
export const FLOW_RULE_HEAD_CLASS =
  'flex flex-wrap items-center justify-between gap-2 text-[12px] font-semibold text-[#858b9c]';
export const FLOW_RULE_LIST_CLASS = 'grid gap-[10px]';
export const FLOW_RULE_ITEM_CLASS =
  'grid min-w-0 max-w-full gap-x-[10px] gap-y-[10px] rounded-[14px] border border-[#e5e8ee] bg-[#fbfcfd] p-[12px] shadow-[0_4px_14px_rgba(24,31,45,0.035)] [grid-template-areas:"target_delete"_"label_label"_"priority_priority"_"condition_condition"] [grid-template-columns:minmax(0,1fr)_32px]';
export const FLOW_RULE_FIELD_CLASS = 'grid min-w-0 gap-[4px] [&>span]:text-[11px] [&>span]:font-semibold [&>span]:leading-[1.3] [&>span]:text-[#858b9c]';
export const FLOW_RULE_FIELD_TARGET_CLASS = '[grid-area:target]';
export const FLOW_RULE_FIELD_LABEL_CLASS = '[grid-area:label]';
export const FLOW_RULE_FIELD_CONDITION_CLASS = '[grid-area:condition] [&_em]:text-[11px] [&_em]:not-italic [&_em]:leading-[1.45] [&_em]:text-[#858b9c]';
export const FLOW_RULE_FIELD_PRIORITY_CLASS = '[grid-area:priority]';
export const FLOW_RULE_CONDITION_CONTROLS_CLASS =
  'grid min-w-0 max-w-full grid-cols-1 items-start gap-[8px]';
export const FLOW_RULE_TARGET_CLASS = 'w-full min-w-0';
export const FLOW_RULE_LABEL_INPUT_CLASS = 'w-full min-w-0';
export const FLOW_RULE_CONDITION_INPUT_CLASS = 'w-full min-w-0 resize-none';
export const FLOW_RULE_PRIORITY_CLASS = 'w-full min-w-0';
export const FLOW_RULE_DELETE_CLASS = '[grid-area:delete] mt-[19px] self-start';
export const FLOW_RULE_EMPTY_CLASS =
  'rounded-[12px] border border-dashed border-[#eceef1] bg-[#fafafa] p-[10px_12px] text-[12px] text-[#858b9c]';

export const NODE_DELETE_CONFIRM_CLASS = 'grid gap-[8px] [&_p]:m-0 [&_ul]:m-0 [&_ul]:pl-[18px]';

// Flow diagram
export const FLOW_VIEWER_CLASS = 'flex min-h-0 flex-1 flex-col';
export const FLOW_VIEWER_FULLSCREEN_CLASS =
  'fixed inset-0 z-[80] bg-[#f7f8fa] p-[18px] sm:p-[24px] animate-in fade-in-0 duration-150';
export const FLOW_VIEWER_FULLSCREEN_PANEL_CLASS =
  'min-h-0 flex-1 overflow-hidden rounded-[18px] border border-[#e3e7f1] bg-white shadow-[0_24px_72px_rgba(24,31,45,0.16)]';
export const FLOW_VIEWER_BODY_CLASS = 'flex min-h-0 flex-1 overflow-hidden max-sm:flex-col';
export const FLOW_VIEWER_TITLE_CLASS = 'flex min-w-0 items-center gap-[10px]';
export const FLOW_VIEWER_TITLE_MARK_CLASS =
  'grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-[#edf8f5] text-[#04756f]';
export const FLOW_VIEWER_TITLE_META_CLASS =
  'min-w-0 truncate text-[11px] font-normal text-[#858b9c]';
export const FLOW_ZOOM_TOOLBAR_CLASS =
  '-mt-[2px] mb-[12px] flex min-h-[40px] shrink-0 flex-wrap items-center gap-[8px] text-[12px] text-[#858b9c]';
export const FLOW_ZOOM_TOOLBAR_FULLSCREEN_CLASS =
  'm-0 min-h-[58px] justify-between border-b border-[#eceef1] px-[18px] py-[10px]';
export const FLOW_ZOOM_CONTROLS_CLASS = 'flex flex-wrap items-center gap-[8px]';

const FLOW_ZOOM_BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center rounded-[9px] border-[0.5px] border-[#e3e7f1] bg-white text-[12px] font-normal leading-none text-[#757f9c] shadow-none transition-colors hover:border-[#cbd3e6]! hover:bg-white! hover:text-[#18181a]! focus-visible:border-[#cbd3e6]! focus-visible:ring-0 focus-visible:outline-none aria-pressed:border-[#04756f]! aria-pressed:bg-[#f3fbf8]! aria-pressed:font-medium aria-pressed:text-[#18181a]!';

export const FLOW_ZOOM_STEP_BUTTON_CLASS = cn(FLOW_ZOOM_BUTTON_BASE, 'size-7 min-w-[34px] px-0');
export const FLOW_ZOOM_PRESET_BUTTON_CLASS = cn(FLOW_ZOOM_BUTTON_BASE, 'h-7 min-w-[34px] px-2.5');

export function flowZoomPresetButtonClass(active: boolean): string {
  return cn(
    FLOW_ZOOM_PRESET_BUTTON_CLASS,
    active && 'border-[#04756f]! bg-[#f3fbf8]! font-medium text-[#18181a]!',
  );
}

export const FLOW_ZOOM_VALUE_CLASS =
  'inline-flex h-7 min-w-[42px] items-center justify-center rounded-[9px] bg-[#fafafa] px-2 text-center font-mono text-[12px] leading-none text-[#18181a]';
export const FLOW_CLASS =
  'block min-h-0 flex-1 overflow-auto px-[clamp(18px,3vw,40px)] py-[clamp(18px,2.8vw,34px)] pb-16';
export const FLOW_FULLSCREEN_CLASS =
  'relative min-w-0 overflow-hidden! bg-[#fbfcfd] bg-[linear-gradient(90deg,rgba(205,213,222,0.34)_1px,transparent_1px),linear-gradient(rgba(205,213,222,0.34)_1px,transparent_1px)] p-0! [background-size:48px_48px]';
export const FLOW_FULLSCREEN_WITH_AI_CLASS =
  'ml-[min(380px,36vw)]';
export const FLOW_FULLSCREEN_PANNABLE_CLASS = 'cursor-grab select-none active:cursor-grabbing';
export const FLOW_INSPECTOR_CLASS =
  'flex w-[min(500px,42vw)] min-w-[380px] shrink-0 flex-col border-l border-[#e1e6ee] bg-[#f8fafb] max-sm:h-[55%] max-sm:w-full max-sm:min-w-0 max-sm:border-l-0 max-sm:border-t';
export const FLOW_INSPECTOR_HEADER_CLASS =
  'flex shrink-0 items-start justify-between gap-[12px] border-b border-[#eceef1] px-[18px] py-[14px]';
export const FLOW_INSPECTOR_BODY_CLASS = 'min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-[16px] py-[16px]';
export const FLOW_INSPECTOR_EMPTY_CLASS =
  'grid min-h-0 flex-1 place-items-center px-[28px] text-center text-[13px] leading-[1.7] text-[#858b9c]';
export const FLOW_NODE_CONNECT_HANDLE_CLASS =
  'absolute bottom-[-9px] left-1/2 z-[12] grid size-[18px] cursor-crosshair place-items-center rounded-full border-2 border-white bg-[#04756f] text-[10px] text-white shadow-[0_3px_10px_rgba(4,117,111,0.26)] transition-[background,box-shadow,transform] hover:bg-[#035f5a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#04756f]';
export const FLOW_NODE_CONNECT_HANDLE_ACTIVE_CLASS = 'bg-[#18181a] shadow-[0_0_0_4px_rgba(4,117,111,0.18)]';
export const FLOW_CONNECTION_PREVIEW_CLASS =
  'pointer-events-none fixed inset-0 z-[110] h-screen w-screen overflow-visible';
export const FLOW_ZOOM_SHELL_CLASS = 'relative mx-0 min-w-full';
export const FLOW_GRAPH_CANVAS_CLASS =
  'absolute top-0 left-0 origin-top-left rounded-[18px] bg-[radial-gradient(circle_at_40px_40px,rgba(18,128,115,0.05),transparent_240px),linear-gradient(90deg,rgba(218,211,199,0.38)_1px,transparent_1px),linear-gradient(rgba(218,211,199,0.26)_1px,transparent_1px)] [background-size:auto,72px_72px,72px_72px] box-border';
export const FLOW_EDGES_CLASS = 'pointer-events-none absolute top-0 left-0 z-[2] overflow-visible';
export const FLOW_EDGE_PATH_CLASS =
  'fill-none stroke-[#547772] [stroke-width:1.8] [vector-effect:non-scaling-stroke] [stroke-linecap:round] [stroke-linejoin:round] opacity-88 transition-[stroke,stroke-width,opacity]';
export const FLOW_EDGE_LABEL_BASE_CLASS =
  'pointer-events-none absolute z-[4] max-w-[176px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#cbdad7] bg-white/98 px-[9px] py-[4px] text-[11px] leading-[1.35] text-ellipsis whitespace-nowrap text-[#486762] shadow-[0_5px_14px_rgba(30,71,65,0.1)]';
export const FLOW_ROOT_POSITION_CLASS = 'absolute z-[6]';
export const FLOW_NODE_POSITION_CLASS = 'absolute z-[7] cursor-grab touch-none active:cursor-grabbing';
export const FLOW_NODE_SHELL_CLASS =
  'grid h-full w-full max-w-none justify-items-stretch gap-[8px]';

export const FLOW_NODE_CLASS =
  'relative isolate box-border grid h-full min-h-0 w-full cursor-pointer content-start auto-rows-max gap-[7px] overflow-hidden rounded-[12px] border border-[#e4e8ee] bg-[#fffefd] p-[14px_15px] text-left select-text text-[#18181a] shadow-[0_8px_22px_rgba(24,31,45,0.045)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#18181a]';
export const FLOW_NODE_ROOT_CLASS =
  'relative z-[1] h-full min-h-0 w-full justify-self-start bg-[#f2f0eb] shadow-[0_14px_34px_rgba(37,32,24,0.08)]';
export const FLOW_NODE_ACTIVE_CLASS = 'border-[#04756f] shadow-[0_8px_22px_rgba(4,117,111,0.08)]';
export const FLOW_NODE_CHANGED_CLASS =
  'border-[#04756f] bg-[#effaf6] shadow-[0_12px_30px_rgba(4,117,111,0.12)] transition-[background,border-color,box-shadow] duration-450';
export const FLOW_NODE_DIRTY_CLASS = 'bg-[#fffdf8] shadow-[inset_3px_0_0_#d8c7a4]';
export const FLOW_NODE_UPDATING_CLASS = 'animate-pulse';

export const FLOW_NODE_BADGES_CLASS = 'flex flex-wrap gap-[6px]';
export const FLOW_NODE_SUMMARY_CLASS =
  'm-[2px_0_0] whitespace-pre-wrap text-[13px] leading-[1.55] wrap-anywhere text-[#687184]!';
export const FLOW_COMPACT_META_CLASS = 'grid min-h-0 content-start gap-[7px]';
export const FLOW_COMPACT_ROW_CLASS =
  'grid min-w-0 grid-cols-[34px_minmax(0,1fr)] items-start gap-[8px] [&>span:first-child]:text-[12px] [&>span:first-child]:font-semibold [&>span:first-child]:leading-[24px] [&>span:first-child]:text-[#858b9c]';
export const FLOW_ROUTE_COUNT_CLASS =
  'w-fit rounded-full border border-dashed border-[#eceef1] bg-[#fafafa] px-2 py-[3px] text-[11px] leading-[1.3] text-[#858b9c]';
export const FLOW_META_CLASS = 'mt-[6px] grid gap-[8px]';
export const FLOW_META_ROW_CLASS = 'grid gap-[5px]';
export const FLOW_META_LABEL_CLASS = 'text-[11px] font-semibold text-[#858b9c]';
export const FLOW_CHIP_LIST_CLASS = 'flex flex-wrap gap-[6px]';
export const FLOW_CHIP_CLASS =
  'max-w-full overflow-hidden rounded-full border border-[#eceef1] bg-[#fafafa] px-2 py-[4px] text-[11px] leading-[1.4] wrap-anywhere text-[#858b9c]';
export const FLOW_CHIP_MUTED_CLASS = 'text-[#858b9c]';
export const FLOW_CHIP_TERMINAL_CLASS = '';

// Action chips
export const ACTION_LIST_CLASS = 'flex max-h-[84px] flex-wrap gap-[6px] overflow-auto';
export const ACTION_EMPTY_CLASS = 'text-[#858b9c]';
export const ACTION_CHIP_BASE_CLASS =
  'max-w-full overflow-hidden rounded-full border border-[#eceef1] bg-[#fafafa] px-2 py-[4px] text-[11px] leading-[1.4] wrap-anywhere text-[#858b9c]';
export const ACTION_CHIP_TOOL_CLASS = 'cursor-help border-[#b9ded5] bg-[#e9f6f2] text-[#075f59]';
export const ACTION_CHIP_TOOL_EXISTING_CLASS = 'border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]';
export const ACTION_CHIP_TOOL_PENDING_CLASS = 'border-[#fed7aa] bg-[#fffbeb] text-[#92400e]';
export const ACTION_CHIP_TOOL_REJECTED_CLASS = 'border-[#fecaca] bg-[#fef2f2] text-[#991b1b]';
export const ACTION_CHIP_TOOL_INCOMPLETE_CLASS = 'border-[#eceef1] bg-[#f7f5ef] text-[#858b9c]';
export const ACTION_CHIP_ADDED_CLASS = 'border-[#9bd3b0] bg-[#e8f6ee] text-[#135f36]';
export const ACTION_CHIP_ADDED_TYPING_CLASS = 'shadow-[inset_0_-2px_0_rgba(19,95,54,0.22)]';
export const ACTION_CHIP_ADDED_SETTLED_CLASS = 'bg-[#eef9f2]';
export const ACTION_CHIP_REMOVED_CLASS = 'border-[#f0b7b2] bg-[#fff1f0] text-[#8c2b2b]';

export const INLINE_REMOVE_CLASS =
  'rounded-[4px] bg-[#fef3c7] px-[2px] py-px font-semibold text-[#713f12] animate-[skill-inline-remove_520ms_ease_both]';
export const INLINE_ADD_CLASS = 'rounded-[4px] bg-[#dcfce7] px-[2px] py-px font-semibold text-[#14532d]';
export const INLINE_ADD_SETTLED_CLASS = 'bg-[#dcfce7]';

export const SELECTION_MARK_CLASS =
  'absolute right-[10px] bottom-[10px] inline-grid size-[22px] place-items-center rounded-full bg-[#04756f] text-[12px] text-white';

// Save review + tool detail dialogs
export const SAVE_REVIEW_FORM_CLASS =
  'mb-[16px] grid grid-cols-3 gap-[12px] min-[0px]:max-[640px]:grid-cols-1';
export const SAVE_REVIEW_FORM_LABEL_CLASS =
  'grid gap-[6px] text-[12px] text-[#858b9c]';
export const SAVE_REVIEW_DIFF_CLASS = 'grid max-h-[420px] gap-[10px] overflow-auto';
export const SAVE_REVIEW_DIFF_ROW_CLASS =
  'rounded-[10px] border border-[#eceef1] bg-[#fafafa] p-[10px_12px]';
export const SAVE_REVIEW_DIFF_PATH_CLASS =
  'mb-[6px] text-[12px] font-semibold text-[#858b9c]';
export const SAVE_REVIEW_ACTION_DIFF_CLASS = 'mt-[4px] flex items-start gap-[8px]';
export const SAVE_REVIEW_ACTION_DIFF_OLD_CLASS = '';
export const SAVE_REVIEW_ACTION_DIFF_NEW_CLASS = '';
export const SAVE_REVIEW_DIFF_SIGN_CLASS = 'w-3 shrink-0 font-mono text-[13px] font-semibold leading-[24px]';
export const SAVE_REVIEW_DIFF_SIGN_OLD_CLASS = 'text-[#991b1b]';
export const SAVE_REVIEW_DIFF_SIGN_NEW_CLASS = 'text-[#166534]';
export const DIFF_OLD_CLASS = 'font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-[#991b1b]';
export const DIFF_NEW_CLASS = 'font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-[#166534]';

export const TOOL_SUGGESTION_DETAIL_CLASS = 'grid gap-[10px]';
export const TOOL_SUGGESTION_DETAIL_FOOTER_CLASS = 'flex w-full flex-wrap justify-end gap-[8px]';
export const TOOL_SUGGESTION_DETAIL_PRE_CLASS =
  'm-0 max-h-[220px] overflow-auto rounded-[10px] border border-[#eceef1] bg-[#fafafa] p-[12px] text-[12px]';

// Inline editable source inputs (replaces ant-input)
export const SOURCE_INPUT_CLASS =
  'box-border h-auto min-h-0 min-w-0 w-full max-w-full rounded-[6px] border border-transparent bg-transparent px-[6px] py-[2px] text-[13px] leading-[1.65] text-[#18181a] shadow-none transition-colors field-sizing-fixed hover:border-[#eceef1] hover:bg-white focus-visible:border-[#eceef1] focus-visible:bg-white focus-visible:ring-0';

// Helper functions
export function chatRowClass(role: 'user' | 'assistant'): string {
  return cn(CHAT_ROW_BASE_CLASS, role === 'user' ? CHAT_ROW_USER_CLASS : CHAT_ROW_ASSISTANT_CLASS);
}

export function chatBubbleClass({
  role,
  editing = false,
  hasAttachments = false,
}: {
  role: 'user' | 'assistant';
  editing?: boolean;
  hasAttachments?: boolean;
}): string {
  if (role === 'user') {
    if (hasAttachments && editing) {
      return cn(CHAT_BUBBLE_BASE_CLASS, CHAT_BUBBLE_USER_EDITING_ATTACHMENTS_CLASS, 'group/bubble');
    }
    if (hasAttachments) {
      return cn(CHAT_BUBBLE_BASE_CLASS, CHAT_BUBBLE_USER_HAS_ATTACHMENTS_CLASS, 'group/bubble');
    }
    if (editing) {
      return cn(CHAT_BUBBLE_BASE_CLASS, CHAT_BUBBLE_USER_CLASS, CHAT_BUBBLE_USER_EDITING_CLASS, 'group/bubble');
    }
    return cn(CHAT_BUBBLE_BASE_CLASS, CHAT_BUBBLE_USER_CLASS, 'group/bubble');
  }
  return cn(CHAT_BUBBLE_BASE_CLASS, CHAT_BUBBLE_ASSISTANT_CLASS, editing && 'ring-1 ring-[#04756f]/30');
}

export function uploadItemClass(status: 'uploading' | 'ready' | 'error'): string {
  return cn(UPLOAD_ITEM_BASE_CLASS, status === 'error' && UPLOAD_ITEM_ERROR_CLASS);
}

export function distillSourceSectionClass(
  path: string,
  selectedPaths: string[],
  highlightedPaths: string[],
  updatingPaths: string[],
  dirtyPaths: string[],
): string {
  return cn(
    SOURCE_SECTION_CLASS,
    selectedPaths.includes(path) && SOURCE_SECTION_ACTIVE_CLASS,
    highlightedPaths.includes(path) && SOURCE_SECTION_CHANGED_CLASS,
    updatingPaths.includes(path) && SOURCE_SECTION_UPDATING_CLASS,
    dirtyPaths.includes(path) && SOURCE_SECTION_DIRTY_CLASS,
  );
}

export function distillFlowNodeClass(
  path: string,
  isRoot: boolean,
  selectedPaths: string[],
  highlightedPaths: string[],
  updatingPaths: string[],
  dirtyPaths: string[],
): string {
  return cn(
    FLOW_NODE_CLASS,
    isRoot && FLOW_NODE_ROOT_CLASS,
    selectedPaths.includes(path) && FLOW_NODE_ACTIVE_CLASS,
    highlightedPaths.includes(path) && FLOW_NODE_CHANGED_CLASS,
    updatingPaths.includes(path) && FLOW_NODE_UPDATING_CLASS,
    dirtyPaths.includes(path) && FLOW_NODE_DIRTY_CLASS,
  );
}

export function flowEdgeLabelClass(tone?: string): string {
  return cn(
    FLOW_EDGE_LABEL_BASE_CLASS,
    tone === 'branch' && 'max-w-[232px] opacity-94',
    tone === 'parallel' && 'max-w-[232px] border-[#0f766e]/24 bg-[#ecfdf5]/96 text-[#0f766e]',
    tone === 'return' && 'border-dashed opacity-88',
  );
}

export function actionChipClass({
  toolName,
  status,
  variant,
}: {
  toolName?: string;
  status?: string;
  variant?: 'added' | 'removed' | 'typing' | 'settled' | 'marked';
}): string {
  const toolVariant =
    status === 'existing' || status === 'accepted' || status === 'created'
      ? ACTION_CHIP_TOOL_EXISTING_CLASS
      : status === 'pending'
        ? ACTION_CHIP_TOOL_PENDING_CLASS
        : status === 'rejected'
          ? ACTION_CHIP_TOOL_REJECTED_CLASS
          : status === 'incomplete'
            ? ACTION_CHIP_TOOL_INCOMPLETE_CLASS
            : ACTION_CHIP_TOOL_CLASS;

  return cn(
    ACTION_CHIP_BASE_CLASS,
    toolName && toolVariant,
    variant === 'removed' && ACTION_CHIP_REMOVED_CLASS,
    variant === 'added' && ACTION_CHIP_ADDED_CLASS,
    variant === 'typing' && ACTION_CHIP_ADDED_TYPING_CLASS,
    variant === 'settled' && ACTION_CHIP_ADDED_SETTLED_CLASS,
  );
}
