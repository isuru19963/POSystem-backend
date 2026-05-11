/**
 * Detect GRN-related inbound mail and pick the PDF to run through GRN extraction.
 * Used by IMAP monitor and manual fetch-from-email.
 */

export interface GrnEmailAttachmentLike {
  filename: string;
  contentType: string;
  content: Buffer;
}

export function attachmentLooksLikeGrnPdf(att: GrnEmailAttachmentLike): boolean {
  const fn = att.filename.toLowerCase();
  const isPdf =
    fn.endsWith('.pdf') ||
    (att.contentType || '').toLowerCase().includes('application/pdf');
  if (!isPdf) return false;
  if (fn.startsWith('grn_') || fn.startsWith('grn-')) return true;
  if (/^grn[^a-z0-9]/i.test(fn) || /^grn\./i.test(fn)) return true;
  if (fn.includes('goods_received') || fn.includes('goods-received')) return true;
  return false;
}

export function isGrnInboundEmail(subject: string, attachments: GrnEmailAttachmentLike[]): boolean {
  const sub = subject || '';
  if (/\bGRN\b/i.test(sub) || /\bg\.r\.n\./i.test(sub)) return true;
  return attachments.some((a) => attachmentLooksLikeGrnPdf(a));
}

/**
 * Prefer a filename that looks like a GRN report; otherwise if the subject references GRN,
 * use the first PDF attachment (one GRN per email in auto-ingest).
 */
export function pickPrimaryGrnPdf(
  subject: string,
  attachments: GrnEmailAttachmentLike[],
): GrnEmailAttachmentLike | undefined {
  const pdfs = attachments.filter(
    (a) =>
      a.filename.toLowerCase().endsWith('.pdf') ||
      (a.contentType || '').toLowerCase().includes('application/pdf'),
  );
  const grnNamed = pdfs.filter((a) => attachmentLooksLikeGrnPdf(a));
  if (grnNamed.length) return grnNamed[0];
  if (/\bGRN\b/i.test(subject || '') && pdfs.length > 0) return pdfs[0];
  return undefined;
}
