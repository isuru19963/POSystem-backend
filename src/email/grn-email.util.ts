/**
 * Detect GRN-related inbound mail and pick the PDF to run through GRN extraction.
 * Used by IMAP monitor and manual fetch-from-email.
 */

export interface GrnEmailAttachmentLike {
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * Subject lines that indicate a GRN / goods receipt, not only the token "GRN".
 * (Vendors often use "Goods Received Note" without the letters G-R-N.)
 */
/** Cloudstore / Hyperpure-style PO numbers in subjects (CFFPO82657, CMPPO81293). */
const CLOUDSTORE_PO_IN_TEXT =
  /\b((?:CFF|CMP|CVPL|CVP|HP)PO\d{4,}[A-Z0-9-]*)\b/i;

export function subjectLooksLikeGrn(subject: string): boolean {
  const s = subject || '';
  if (/\bGRN\b/i.test(s) || /\bg\.r\.n\./i.test(s)) return true;
  if (/goods\s*received/i.test(s)) return true;
  if (/goods\s*receipt/i.test(s)) return true;
  if (/receipt\s*note/i.test(s)) return true;
  if (/delivery\s*challan/i.test(s)) return true;
  if (/\bgoods\s*return/i.test(s)) return true;
  if (/\binward\b/i.test(s) && /\b(receipt|received)\b/i.test(s)) return true;
  if (/\bGR\s*note\b/i.test(s)) return true;
  if (/received\s*against\s*po/i.test(s)) return true;
  if (/pod\s*submission|proof\s*of\s*delivery/i.test(s)) return true;
  if (
    CLOUDSTORE_PO_IN_TEXT.test(s) &&
    /\b(receipt|received|grn|challan|inward|delivery)\b/i.test(s)
  ) {
    return true;
  }
  return false;
}

export function attachmentLooksLikeGrnPdf(att: GrnEmailAttachmentLike): boolean {
  const fn = att.filename.toLowerCase();
  const isPdf =
    fn.endsWith('.pdf') ||
    (att.contentType || '').toLowerCase().includes('application/pdf');
  if (!isPdf) return false;
  if (fn.startsWith('grn_') || fn.startsWith('grn-')) return true;
  if (/^grn[^a-z0-9]/i.test(fn) || /^grn\./i.test(fn)) return true;
  // Underscores are word chars for \b — match "foo_grn_bar.pdf" etc.
  if (/grn/i.test(fn)) return true;
  if (fn.includes('goods_received') || fn.includes('goods-received')) return true;
  if (/goods[_\s-]*received/i.test(fn)) return true;
  if (/goods[_\s-]*receipt/i.test(fn)) return true;
  if (/delivery[_\s-]*challan/i.test(fn)) return true;
  if (/\breceipt\b/i.test(fn) && !/tax|invoice/i.test(fn)) return true;
  if (/\binward\b/i.test(fn)) return true;
  return false;
}

export function isPdfAttachment(att: GrnEmailAttachmentLike): boolean {
  const fn = att.filename.toLowerCase();
  return (
    fn.endsWith('.pdf') ||
    (att.contentType || '').toLowerCase().includes('application/pdf')
  );
}

export function listPdfAttachments(
  attachments: GrnEmailAttachmentLike[],
): GrnEmailAttachmentLike[] {
  return attachments.filter(isPdfAttachment);
}

export function isGrnInboundEmail(subject: string, attachments: GrnEmailAttachmentLike[]): boolean {
  if (subjectLooksLikeGrn(subject)) return true;
  if (attachments.some((a) => attachmentLooksLikeGrnPdf(a))) return true;
  // GRN PDFs are often named after the PO number (CFFPO82657.pdf) without "grn" in the name.
  if (
    attachments.some(
      (a) =>
        isPdfAttachment(a) &&
        CLOUDSTORE_PO_IN_TEXT.test(a.filename) &&
        !/purchase[\s_-]*order/i.test(a.filename),
    )
  ) {
    return true;
  }
  return false;
}

/** Inbox scan filter for manual GRN fetch — includes likely GRNs for PDF content sniff. */
export function isGrnInboxCandidate(
  subject: string,
  attachments: GrnEmailAttachmentLike[],
): boolean {
  if (isGrnInboundEmail(subject, attachments)) return true;
  const s = subject || '';
  if (/purchase\s*order|new\s*po\b|po\s*raised|po\s*approval/i.test(s)) {
    return false;
  }
  const pdfs = listPdfAttachments(attachments);
  if (!pdfs.length) return false;
  if (pdfs.some((p) => CLOUDSTORE_PO_IN_TEXT.test(p.filename))) return true;
  if (
    /hyperpure|cloudstore|goods|received|receipt|challan|grn|inward|delivered/i.test(
      s,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Prefer a filename that looks like a GRN report; otherwise if the subject references GRN
 * (or common GRN phrasing), use the first PDF attachment (one GRN per email in auto-ingest).
 */
export function pickPrimaryGrnPdf(
  subject: string,
  attachments: GrnEmailAttachmentLike[],
): GrnEmailAttachmentLike | undefined {
  const pdfs = listPdfAttachments(attachments);
  const grnNamed = pdfs.filter((a) => attachmentLooksLikeGrnPdf(a));
  if (grnNamed.length) return grnNamed[0];

  if (!subjectLooksLikeGrn(subject || '')) return undefined;

  const nonPoSchedule = pdfs.filter(
    (a) =>
      !/purchase[_\s-]*order|po[_\s-]*schedule|tax\s*invoice/i.test(a.filename),
  );
  if (nonPoSchedule.length) {
    const goods = nonPoSchedule.find((p) =>
      /goods|received|grn|challan|delivery/i.test(p.filename),
    );
    return goods ?? nonPoSchedule[nonPoSchedule.length - 1];
  }

  if (pdfs.length > 0) {
    const goods = pdfs.find((p) =>
      /goods|received|grn|challan|delivery/i.test(p.filename),
    );
    return goods ?? pdfs[pdfs.length - 1];
  }
  return undefined;
}
