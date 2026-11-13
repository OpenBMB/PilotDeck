/**
 * Apply to the smallest element that contains resource/user text, including its
 * title/alt/aria attributes. Keep adjacent product labels outside the boundary.
 * This is DOM metadata only: it adds no wrapper and preserves refs and layout.
 * data-i18n-ignore is the source-catalog contract; translate also protects the
 * same content from browser translation.
 */
export const USER_CONTENT_ATTRIBUTES = {
  'data-i18n-ignore': true,
  translate: 'no',
} as const;

/** Protect a user title on a mixed control without suppressing its product labels. */
export const USER_CONTENT_TITLE_ATTRIBUTES = {
  'data-i18n-ignore-title': true,
} as const;
