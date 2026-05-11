/** Normalize for dedupe / compare (strip angle brackets, lower-case). */
export function canonicalMessageId(id: string | undefined): string {
  return (id || '').replace(/^<|>$/g, '').trim().toLowerCase();
}

/** DB may store Message-ID with or without <> — match all common variants. */
export function messageIdSearchVariants(id: string | undefined): string[] {
  const raw = id?.trim();
  if (!raw) return [];
  const inner = raw.replace(/^<|>$/g, '').trim();
  const out = new Set<string>([raw]);
  if (inner) {
    out.add(inner);
    if (!raw.startsWith('<')) out.add(`<${inner}>`);
  }
  return [...out];
}
