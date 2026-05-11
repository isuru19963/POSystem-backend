import { Injectable, Logger } from '@nestjs/common';

export interface AiExtractedLineItem {
  skuCode: string;
  skuName: string;
  hsnCode?: string;
  quantity: number;
  price: number;
  mrp?: number;
  total?: number;
}

export interface AiPoExtractionResult {
  vendorName?: string;
  vendorCode?: string;
  vendorGstin?: string;
  poNumber?: string;
  poDate?: string;
  expectedDeliveryDate?: string;
  expiryDate?: string;
  paymentTerms?: string;
  shippingLocation?: string;
  lineItems?: AiExtractedLineItem[];
  grandTotal?: number;
}

@Injectable()
export class AiPoExtractionService {
  private readonly logger = new Logger(AiPoExtractionService.name);

  isEnabled(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  async extractFromText(rawText: string): Promise<AiPoExtractionResult | null> {
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
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0,
            topP: 0.95,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        this.logger.warn(`Gemini extraction failed: ${resp.status} ${errorText}`);
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
      this.logger.warn(`Gemini extraction error: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private buildPrompt(rawText: string): string {
    return [
      'Extract purchase-order data from the text below.',
      'Return ONLY JSON with this shape:',
      '{',
      '  "vendorName": string,',
      '  "vendorCode": string,',
      '  "vendorGstin": string,',
      '  "poNumber": string,',
      '  "poDate": string,',
      '  "expectedDeliveryDate": string,',
      '  "expiryDate": string,',
      '  "paymentTerms": string,',
      '  "shippingLocation": string,',
      '  "lineItems": [',
      '    {',
      '      "skuCode": string,',
      '      "skuName": string,',
      '      "hsnCode": string,',
      '      "quantity": number,',
      '      "price": number,',
      '      "mrp": number,',
      '      "total": number',
      '    }',
      '  ],',
      '  "grandTotal": number',
      '}',
      'Rules:',
      '- Keep unknown fields as empty string or 0.',
      '- quantity/price/mrp/total/grandTotal must be numbers.',
      '- Do not include markdown or code fences.',
      '',
      'PO_TEXT_START',
      rawText,
      'PO_TEXT_END',
    ].join('\n');
  }

  private tryParseJson(text: string): any | null {
    if (!text) return null;

    const cleaned = text.trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      // Try extracting the first JSON object in case the model wrapped it.
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }

  private normalize(data: any): AiPoExtractionResult {
    const toNum = (v: unknown): number => {
      const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const lineItems = Array.isArray(data?.lineItems)
      ? data.lineItems.map((li: any) => ({
          skuCode: String(li?.skuCode || '').trim(),
          skuName: String(li?.skuName || '').trim(),
          hsnCode: li?.hsnCode ? String(li.hsnCode).trim() : undefined,
          quantity: toNum(li?.quantity),
          price: toNum(li?.price),
          mrp: li?.mrp != null ? toNum(li?.mrp) : undefined,
          total: li?.total != null ? toNum(li?.total) : undefined,
        }))
      : [];

    return {
      vendorName: data?.vendorName ? String(data.vendorName).trim() : undefined,
      vendorCode: data?.vendorCode ? String(data.vendorCode).trim() : undefined,
      vendorGstin: data?.vendorGstin ? String(data.vendorGstin).trim() : undefined,
      poNumber: data?.poNumber ? String(data.poNumber).trim() : undefined,
      poDate: data?.poDate ? String(data.poDate).trim() : undefined,
      expectedDeliveryDate: data?.expectedDeliveryDate ? String(data.expectedDeliveryDate).trim() : undefined,
      expiryDate: data?.expiryDate ? String(data.expiryDate).trim() : undefined,
      paymentTerms: data?.paymentTerms ? String(data.paymentTerms).trim() : undefined,
      shippingLocation: data?.shippingLocation ? String(data.shippingLocation).trim() : undefined,
      lineItems,
      grandTotal: data?.grandTotal != null ? toNum(data.grandTotal) : undefined,
    };
  }
}
