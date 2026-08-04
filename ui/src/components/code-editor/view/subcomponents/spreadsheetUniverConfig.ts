// Keep the workbench from taking DOM focus when a preview mounts. This protects
// surrounding inputs, such as the chat composer, without disabling sheet focus.
export const SPREADSHEET_UNIVER_UI_CONFIG = {
  header: false,
  toolbar: false,
  footer: false,
  contextMenu: false,
  headerMenu: false,
  disableAutoFocus: true,
} as const;

// Univer's wheel controller only scrolls while its internal FOCUSING_SHEET
// context is active, so sheet auto-focus must remain enabled here.
export const SPREADSHEET_UNIVER_SHEETS_UI_CONFIG = {
  formulaBar: false,
  footer: false,
  disableEdit: true,
  protectedRangeShadow: false,
} as const;
