/** Web and desktop use the built-in local user unless account login is enabled. */
export function isLocalAuthDisabled(value) {
  return value === undefined || value === '' || value === '1' || value === 'true';
}
