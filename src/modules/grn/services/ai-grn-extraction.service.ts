import { Injectable, Logger } from '@nestjs/common';

export interface AiGrnExtractedLineItem {
  itemCode: string;
  itemName: string;
  hsnCode?: string;
  orderedQty: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason?: string;
}

export interface AiGrnExtractionResult {
  grnNumber?: string;
  poNumber?: string;
  supplierName?: string;
  grnDate?: string;
  lineItems?: AiGrnExtractedLineItem[];
}

@Injectable()
export class AiGrnExtractionService {
  private readonly logger = new Logger(AiGrnExtractionService.name);

  isEnabled(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  async extractFromText(rawText: string): Promise<AiGrnExtractionResult | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';
    if (!apiKey) return null;

    try {
      const prompt = this.buildPrompt(rawText);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        this.logger.warn(`Gemini GRN extraction failed: ${resp.status} ${errorText}`);
        return null;
      }

      const data = (await resp.json()) as any;
      const text =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ||
        data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('') ||
        '';

      const parsed = this.tryParseJson(text);
      if (!parsed) return null;
      return this.normalize(parsed);
    } catch (error) {
      this.logger.warn(`Gemini GRN extraction error: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private buildPrompt(rawText: string): string {
    return [
      'Extract GRN (Goods Receipt Note) data from text.',
      'Return ONLY JSON with this shape:',
      '{',
      '  "grnNumber": string,',
      '  "poNumber": string,',
      '  "supplierName": string,',
      '  "grnDate": string,',
      '  "lineItems": [',
      '    {',
      '      "itemCode": string,',
      '      "itemName": string,',
      '      "hsnCode": string,',
      '      "orderedQty": number,',
      '      "receivedQty": number,',
      '      "acceptedQty": number,',
      '      "rejectedQty": number,',
      '      "rejectionReason": string',
      '    }',
      '  ]',
      '}',
      'Rules:',
      '- Unknown strings as empty string.',
      '- Qty fields must be numbers.',
      '- No markdown fences.',
      '',
      'GRN_TEXT_START',
      rawText,
      'GRN_TEXT_END',
    ].join('\n');
  }

  private tryParseJson(text: string): any | null {
    if (!text) return null;
    const cleaned = text.trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }

  private normalize(data: any): AiGrnExtractionResult {
    const toNum = (v: unknown): number => {
      const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const lineItems = Array.isArray(data?.lineItems)
      ? data.lineItems.map((li: any) => ({
          itemCode: String(li?.itemCode || '').trim(),
          itemName: String(li?.itemName || '').trim(),
          hsnCode: li?.hsnCode ? String(li.hsnCode).trim() : undefined,
          orderedQty: toNum(li?.orderedQty),
          receivedQty: toNum(li?.receivedQty),
          acceptedQty: toNum(li?.acceptedQty),
          rejectedQty: toNum(li?.rejectedQty),
          rejectionReason: li?.rejectionReason ? String(li.rejectionReason).trim() : undefined,
        }))
      : [];

    return {
      grnNumber: data?.grnNumber ? String(data.grnNumber).trim() : undefined,
      poNumber: data?.poNumber ? String(data.poNumber).trim() : undefined,
      supplierName: data?.supplierName ? String(data.supplierName).trim() : undefined,
      grnDate: data?.grnDate ? String(data.grnDate).trim() : undefined,
      lineItems,
    };
  }
}
