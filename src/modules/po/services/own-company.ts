/**
 * Patterns that match the user's own company in PO documents.
 *
 * When a name on a PO matches one of these, we treat it as the *seller*
 * (us) and never as the customer / counterparty. Add new patterns here
 * if more company names or entities are introduced.
 */
export const OWN_COMPANY_PATTERNS: RegExp[] = [
  /deccan\s*agro/i,
];

export function isOwnCompanyName(name?: string | null): boolean {
  if (!name) return false;
  const trimmed = String(name).trim();
  if (!trimmed) return false;
  return OWN_COMPANY_PATTERNS.some((pattern) => pattern.test(trimmed));
}
