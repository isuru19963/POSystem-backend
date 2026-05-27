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

  it('pickPrimaryGrnPdf prefers goods_received over purchase_order for Hyperpure', () => {
    const attachments = [
      pdf('purchase_order-3413994.pdf'),
      pdf('goods_received_note.pdf'),
    ];
    const picked = pickPrimaryGrnPdf(
      'Hyperpure GRN against PO Number CPCMH27-PO-3413994',
      attachments,
    );
    expect(picked?.filename).toBe('goods_received_note.pdf');
  });

  it('attachmentLooksLikeGrnPdf matches grn substring in filename', () => {
    expect(attachmentLooksLikeGrnPdf(pdf('foo_grn_bar.pdf'))).toBe(true);
  });

  it('subjectLooksLikeGrn matches CFFPO with receipt wording', () => {
    expect(
      subjectLooksLikeGrn('Goods received against PO CFFPO82657'),
    ).toBe(true);
  });
});
