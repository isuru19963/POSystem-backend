import { GrnPdfExtractionService } from './grn-pdf-extraction.service';
import { AiGrnExtractionService } from './ai-grn-extraction.service';

describe('GrnPdfExtractionService', () => {
  const service = new GrnPdfExtractionService({
    isEnabled: () => false,
    extractFromText: async () => null,
  } as unknown as AiGrnExtractionService);

  it('extracts Hyperpure PO number from email subject', () => {
    const result = (service as unknown as { parseGrn: (t: string, h?: { emailSubject?: string }) => unknown }).parseGrn(
      'GRN No :\nPO No :\n',
      {
        emailSubject:
          'DECCAN AGRO FARM PRIVATE LIMITED - Hyperpure GRN against PO Number CPCMH27-PO-3383384',
      },
    ) as { poNumber: string; grnNumber: string };

    expect(result.poNumber).toBe('CPCMH27-PO-3383384');
    expect(result.grnNumber).toContain('GRN-');
  });

  it('extracts Cloudstore PO from subject', () => {
    const result = (service as unknown as { parseGrn: (t: string, h?: { emailSubject?: string }) => unknown }).parseGrn(
      '',
      {
        emailSubject:
          'GRN & Purchase Return CVPL-1N60003666|| DECCAN AGRO FARM PRIVATE LIMITED || Hyderabad_CFFPO81951',
      },
    ) as { poNumber: string };

    expect(result.poNumber).toBe('CFFPO81951');
  });

  it('sniffs Hyperpure line items from PO catalogue in flat text', () => {
    const text = `
      1 155480 BH-dr Good Nutrition Eggs 04071100 95 90 88 2
      2 155481 BH-dr Premium White Eggs 04071100 991 980 975 5
      3 175809 BH-Premium Fresh Eggs 04071100 334 330 328 2
    `;
    const items = service.sniffLineItemsFromPoCatalog(text, [
      { itemCode: '155480', itemName: 'Eggs A' },
      { itemCode: '155481', itemName: 'Eggs B' },
      { itemCode: '175809', itemName: 'Eggs C' },
    ]);
    expect(items).toHaveLength(3);
    expect(items[2].acceptedQty).toBeGreaterThan(0);
  });
});
