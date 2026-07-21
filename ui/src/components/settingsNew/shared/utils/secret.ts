const MASK = "********";

export function isMaskedSecret(value: string | undefined): boolean {
  return value === MASK;
}

export function secretDisplayValue(value: string | undefined): string {
  if (!value) return "";
  if (isMaskedSecret(value)) return "";
  if (value === "PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE") return "";
  if (value.startsWith("PLACEHOLDER_")) return "";
  return value;
}

export function hasUsableSecret(value: string | undefined): boolean {
  const shown = secretDisplayValue(value).trim();
  return shown.length > 0;
}
