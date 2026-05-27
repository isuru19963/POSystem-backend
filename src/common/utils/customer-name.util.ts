/**
 * Normalize buyer / customer names from PO PDFs, XLS, and email imports.
 * Strips field labels ("Buyer Name:", "PO No :") and detects junk rows.
 */

function normalizeWhitespace(raw: string): string {
  return raw
    .trim()
    .replace(/\uFF1A/g, ':')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Remove leading field labels; return company name only. */
export function stripCustomerNameLabel(raw: string): string {
  let t = normalizeWhitespace(raw);
  if (!t) return '';

  for (let i = 0; i < 3; i++) {
    let changed = false;
    const patterns = [
      /^(?:buyer|customer|vendor|consignee)\s*name\s*:\s*(.+)$/i,
      /^(?:bill(?:ing)?\s*to|ship(?:ping)?\s*to)\s*:\s*(.+)$/i,
      /^(?:buyer|customer|vendor|consignee)\s*:\s*(.+)$/i,
    ];
    for (const re of patterns) {
      const m = t.match(re);
      const body = m?.[1]?.trim();
      if (body && body.length > 1) {
        t = body;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return t;
}

/** True when the string is a PDF/XLS label, not a legal entity name. */
export function isGarbageCustomerLabel(name: string): boolean {
  const raw = normalizeWhitespace(name);
  const t = stripCustomerNameLabel(raw);
  const check = (s: string) => {
    if (!s || s.length < 2) return true;
    if (/^PO\s*No\.?\s*:?\s*$/i.test(s)) return true;
    if (/^PO\s*No\.?\s*:\s*[\dA-Z-]+$/i.test(s)) return true;
    if (/^PO\s*Number\s*:?\s*$/i.test(s)) return true;
    if (/^P\.?O\.?\s*No\.?\s*:?\s*$/i.test(s)) return true;
    if (/^Purchase\s*Order\s*No\.?\s*:?\s*$/i.test(s)) return true;
    if (/^PO\s*Date\s*:?\s*$/i.test(s)) return true;
    if (/^Expected\s*Delivery/i.test(s)) return true;
    if (/^GSTIN\s*:?\s*$/i.test(s)) return true;
    if (/^PAN\s*:?\s*$/i.test(s)) return true;
    if (/^Address\s*:?\s*$/i.test(s)) return true;
    if (/^Vendor\s*Name\s*:?\s*$/i.test(s)) return true;
    if (/^Billing\s*Address\s*:?\s*$/i.test(s)) return true;
    if (/^Ship(?:ping)?\s*(?:To|From)\s*:?\s*$/i.test(s)) return true;
    if (/^(?:buyer|customer|vendor|consignee|bill\s*to)\s*name\s*:?\s*$/i.test(s)) return true;
    if (/^(?:buyer|customer|vendor|consignee|bill\s*to)\s*:?\s*$/i.test(s)) return true;
    return false;
  };
  return check(raw) || check(t);
}

/** Vendor row looks like a mistaken PO import (Admin “misimports” list). */
export function looksLikeMisimportedVendorName(name: string, code?: string): boolean {
  const raw = normalizeWhitespace(name);
  if (!raw) return true;
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      raw,
    )
  ) {
    return true;
  }
  if (isGarbageCustomerLabel(raw)) return true;
  if (/PO\s*No\.?\s*:/i.test(raw)) return true;
  if (/PO\s*Date/i.test(raw)) return true;
  if (/Purchase\s+Order/i.test(raw) && raw.length > 50) return true;
  if (
    /^\s*-\s+/.test(raw) &&
    /(CFFPO|CFFP|BLRP|BLRPO|CMPPO|CPCAP|P\d{6,}|PO\s)/i.test(raw)
  ) {
    return true;
  }
  if (/^(?:buyer|customer|vendor|consignee)\s*name\s*:/i.test(raw)) return true;
  if (/^(?:bill(?:ing)?\s*to|ship(?:ping)?\s*to)\s*:/i.test(raw)) return true;
  if (code && /^PO_No/i.test(code.replace(/\s/g, '_'))) return true;
  return false;
}

/** Use before saving vendor on PO import. Returns '' if only junk. */
export function sanitizeVendorNameForImport(raw?: string | null): string {
  if (!raw) return '';
  const stripped = stripCustomerNameLabel(String(raw));
  if (isGarbageCustomerLabel(stripped)) return '';
  return stripped;
}
