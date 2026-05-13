import {
  attachmentLooksLikeGrnPdf,
  isGrnInboundEmail,
  pickPrimaryGrnPdf,
  subjectLooksLikeGrn,
} from './grn-email.util';

const pdf = (name: string) => ({
  filename: name,
  contentType: 'application/pdf',
  content: Buffer.alloc(0),
});

describe('grn-email.util', () => {
  it('subjectLooksLikeGrn matches Goods Received Note without word GRN', () => {
    expect(subjectLooksLikeGrn('Goods Received Note - Hyperpure')).toBe(true);
  });

  it('isGrnInboundEmail is true for goods-received subject and generic PDF name', () => {
    const attachments = [pdf('CPCAP27-GRN-123.pdf'), pdf('logo.png')];
    expect(isGrnInboundEmail('Shipment update', attachments)).toBe(true);
    attachments[0] = pdf('random-document.pdf');
    expect(isGrnInboundEmail('Goods Received Note for PO 123', attachments)).toBe(true);
  });

  it('pickPrimaryGrnPdf falls back to first PDF when subject is GRN-like but filenames are generic', () => {
    const attachments = [pdf('invoice.pdf'), pdf('statement.pdf')];
    const picked = pickPrimaryGrnPdf('Goods Receipt Note — CPCAP27', attachments);
    expect(picked?.filename).toBe('invoice.pdf');
  });

  it('attachmentLooksLikeGrnPdf matches grn substring in filename', () => {
    expect(attachmentLooksLikeGrnPdf(pdf('foo_grn_bar.pdf'))).toBe(true);
  });
});
