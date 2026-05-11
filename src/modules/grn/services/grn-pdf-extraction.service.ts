import { Injectable, Logger } from '@nestjs/common';
import { AiGrnExtractionResult, AiGrnExtractionService } from './ai-grn-extraction.service';

export interface GrnExtractedLineItem {
  itemCode: string;
  itemName: string;
  hsnCode?: string;
  orderedQty: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason?: string;
}

export interface GrnExtractionResult {
  grnNumber: string;
  poNumber: string;
  supplierName: string;
  grnDate: string;
  lineItems: GrnExtractedLineItem[];
  rawText?: string;
  confidence?: number;
  extractionMethod?: 'rule' | 'hybrid' | 'ai';
}

/**
 * Extracts GRN data from PDF documents.
 *
 * Handles common GRN PDF formats:
 *  - Standard tabular GRN (GRN No, PO No, Date, item table with ordered/received/accepted/rejected)
 *  - Vendor delivery challans referencing a PO
 */
@Injectable()
export class GrnPdfExtractionService {
  private readonly logger = new Logger(GrnPdfExtractionService.name);

  constructor(private readonly aiGrnExtractionService: AiGrnExtractionService) {}

  async extract(pdfBuffer: Buffer): Promise<GrnExtractionResult> {
    this.logger.log('Extracting GRN PDF...');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PDFParse } = require('pdf-parse');
    const uint8 = new Uint8Array(pdfBuffer);
    const parser = new PDFParse(uint8);
    await parser.load();

    const textResult = await parser.getText();
    const text = textResult.pages.map((p: { text: string }) => p.text).join('\n');
    parser.destroy();

    this.logger.log(`Extracted text length: ${text.length}`);

    let result = this.parseGrn(text);
    result.rawText = text;
    result.confidence = this.computeConfidence(result);
    result.extractionMethod = 'rule';

    if (this.shouldUseAiFallback(result)) {
      this.logger.warn(
        `Low GRN extraction confidence (${result.confidence?.toFixed(2)}) for ${result.grnNumber || '[unknown]'}, trying AI fallback`,
      );
      const aiResult = await this.aiGrnExtractionService.extractFromText(text);
      if (aiResult) {
        result = this.mergeWithAiResult(result, aiResult);
      }
    }

    this.logger.log(
      `Parsed GRN "${result.grnNumber}" (PO: ${result.poNumber}) with ${result.lineItems.length} items (confidence=${result.confidence?.toFixed(2)}, method=${result.extractionMethod})`,
    );

    return result;
  }

  private shouldUseAiFallback(result: GrnExtractionResult): boolean {
    if (!this.aiGrnExtractionService.isEnabled()) return false;
    if (!result.grnNumber || !result.poNumber || !result.supplierName) return true;
    if (!result.lineItems || result.lineItems.length === 0) return true;
    return (result.confidence || 0) < 0.72;
  }

  private computeConfidence(result: GrnExtractionResult): number {
    let score = 0;
    if (result.grnNumber) score += 0.25;
    if (result.poNumber) score += 0.20;
    if (result.supplierName) score += 0.15;
    if (result.grnDate) score += 0.10;
    if (result.lineItems?.length) {
      score += result.lineItems.length >= 2 ? 0.30 : 0.20;
    }
    return Math.min(1, score);
  }

  private mergeWithAiResult(
    ruleResult: GrnExtractionResult,
    aiResult: AiGrnExtractionResult,
  ): GrnExtractionResult {
    const merged: GrnExtractionResult = {
      ...ruleResult,
      grnNumber: ruleResult.grnNumber || aiResult.grnNumber || '',
      poNumber: ruleResult.poNumber || aiResult.poNumber || '',
      supplierName: ruleResult.supplierName || aiResult.supplierName || '',
      grnDate: this.normalizeDate(ruleResult.grnDate || aiResult.grnDate || ''),
      lineItems: ruleResult.lineItems?.length
        ? ruleResult.lineItems
        : (aiResult.lineItems || []).map((li) => ({
            itemCode: li.itemCode,
            itemName: li.itemName,
            hsnCode: li.hsnCode,
            orderedQty: li.orderedQty,
            receivedQty: li.receivedQty,
            acceptedQty: li.acceptedQty,
            rejectedQty: li.rejectedQty,
            rejectionReason: li.rejectionReason,
          })),
      extractionMethod: 'hybrid',
    };

    merged.confidence = this.computeConfidence(merged);
    return merged;
  }

  private parseGrn(text: string): GrnExtractionResult {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    const grnNumber = this.extractField(lines, [
      /GRN\s*(?:No|Number|#)\s*[:\-]?\s*(\S+)/i,
      /Goods\s*Receipt\s*(?:Note|No)\s*[:\-]?\s*(\S+)/i,
      /Receipt\s*No\s*[:\-]?\s*(\S+)/i,
    ]) || `GRN-${Date.now()}`;

    const poNumber = this.extractField(lines, [
      /PO\s*(?:No|Number|#)\s*[:\-]?\s*(\S+)/i,
      /Purchase\s*Order\s*(?:No|Number)\s*[:\-]?\s*(\S+)/i,
      /Reference\s*PO\s*[:\-]?\s*(\S+)/i,
      /Ref\s*PO\s*[:\-]?\s*(\S+)/i,
      /Order\s*(?:No|Number)\s*[:\-]?\s*(\S+)/i,
    ]) || '';

    const supplierName = this.extractField(lines, [
      /Supplier\s*(?:Name)?\s*[:\-]?\s*(.+)/i,
      /Vendor\s*(?:Name)?\s*[:\-]?\s*(.+)/i,
      /From\s*[:\-]?\s*(.+)/i,
    ]) || '';

    const grnDate = this.extractField(lines, [
      /GRN\s*Date\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      /Receipt\s*Date\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
      /Date\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
    ]) || new Date().toISOString().slice(0, 10);

    const lineItems = this.extractLineItems(text, lines);

    return {
      grnNumber,
      poNumber,
      supplierName,
      grnDate: this.normalizeDate(grnDate),
      lineItems,
    };
  }

  /**
   * Try each pattern in order; return first match group 1.
   */
  private extractField(lines: string[], patterns: RegExp[]): string | undefined {
    for (const pattern of patterns) {
      for (const line of lines) {
        const m = line.match(pattern);
        if (m) return m[1].trim();
      }
      // Also try full text joined
      const full = lines.join(' ');
      const m = full.match(pattern);
      if (m) return m[1].trim();
    }
    return undefined;
  }

  /**
   * Extract GRN line items from the PDF table.
   *
   * Supports two table formats:
   *
   * Format A (full):
   *   Sr | Item Code | Description | HSN | Ordered Qty | Received Qty | Accepted Qty | Rejected Qty | Remarks
   *
   * Format B (minimal - delivery challan style):
   *   Sr | Item Code | Description | HSN | Qty | Rate | Amount
   *   (In this case received = ordered, accepted = ordered, rejected = 0)
   */
  private extractLineItems(text: string, lines: string[]): GrnExtractedLineItem[] {
    // Detect which format by checking header keywords
    const hasReceivedCol = /received\s*qty|received\s*quantity/i.test(text);

    if (hasReceivedCol) {
      return this.extractFullFormatItems(lines);
    }
    return this.extractMinimalFormatItems(lines);
  }

  /**
   * Full GRN format: rows start with a serial number and contain 4+ quantity columns.
   * Pattern: SR  ITEM_CODE  DESCRIPTION  [HSN]  ORDERED  RECEIVED  ACCEPTED  REJECTED  [REASON]
   */
  private extractFullFormatItems(lines: string[]): GrnExtractedLineItem[] {
    const items: GrnExtractedLineItem[] = [];
    // Find table header row to anchor the item rows
    const headerIdx = lines.findIndex((l) =>
      /item\s*code/i.test(l) && /received/i.test(l),
    );
    const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];

      // Row pattern: Sr(1-3digits) ItemCode Description [HSN] Ordered Received Accepted Rejected [Reason]
      // Try to match: starts with number, then alphanumeric code, then at least 4 integers
      const rowMatch = line.match(
        /^(\d{1,3})\s+([A-Z0-9\-\/]+)\s+(.*?)\s+(\d{6,8})?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*))?$/i,
      );
      if (rowMatch) {
        const [, , itemCode, rawName, hsnCode, orderedQty, receivedQty, acceptedQty, rejectedQty, reason] = rowMatch;
        items.push({
          itemCode: itemCode.trim(),
          itemName: rawName.trim(),
          hsnCode: hsnCode?.trim(),
          orderedQty: parseInt(orderedQty, 10),
          receivedQty: parseInt(receivedQty, 10),
          acceptedQty: parseInt(acceptedQty, 10),
          rejectedQty: parseInt(rejectedQty, 10),
          rejectionReason: reason?.trim() || undefined,
        });
        continue;
      }

      // Simpler fallback: numeric row with at least 4 trailing numbers
      const simpleMatch = line.match(
        /^(\d{1,3})\s+([A-Z0-9\-\/]+)\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/i,
      );
      if (simpleMatch) {
        const [, , itemCode, rawName, orderedQty, receivedQty, acceptedQty, rejectedQty, reason] = simpleMatch;
        items.push({
          itemCode: itemCode.trim(),
          itemName: rawName.trim(),
          orderedQty: parseInt(orderedQty, 10),
          receivedQty: parseInt(receivedQty, 10),
          acceptedQty: parseInt(acceptedQty, 10),
          rejectedQty: parseInt(rejectedQty, 10),
          rejectionReason: reason?.trim() || undefined,
        });
      }
    }

    return items;
  }

  /**
   * Minimal / delivery challan format — no separate accepted/rejected columns.
   * Row: SR  ITEM_CODE  DESCRIPTION  [HSN]  QTY  [RATE  AMOUNT]
   * Assumes received = ordered, accepted = ordered, rejected = 0.
   */
  private extractMinimalFormatItems(lines: string[]): GrnExtractedLineItem[] {
    const items: GrnExtractedLineItem[] = [];
    const headerIdx = lines.findIndex((l) =>
      /item\s*(?:code|no)/i.test(l) && /(?:qty|quantity|amount)/i.test(l),
    );
    const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];

      // Row starting with serial number
      const rowMatch = line.match(
        /^(\d{1,3})\s+([A-Z0-9\-\/]+)\s+(.*?)\s+(\d{6,8})?\s*(\d+)(?:\s+[\d.]+)?(?:\s+[\d.]+)?\s*$/i,
      );
      if (rowMatch) {
        const [, , itemCode, rawName, hsnCode, qty] = rowMatch;
        const quantity = parseInt(qty, 10);
        items.push({
          itemCode: itemCode.trim(),
          itemName: rawName.trim(),
          hsnCode: hsnCode?.trim(),
          orderedQty: quantity,
          receivedQty: quantity,
          acceptedQty: quantity,
          rejectedQty: 0,
        });
      }
    }

    return items;
  }

  /** Normalize common date formats (dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy) → ISO YYYY-MM-DD */
  private normalizeDate(raw: string): string {
    const m = raw.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if (m) {
      const [, d, mo, y] = m;
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    // Try ISO or already normalized
    const iso = new Date(raw);
    if (!isNaN(iso.getTime())) return iso.toISOString().slice(0, 10);
    return new Date().toISOString().slice(0, 10);
  }
}
