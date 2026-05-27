import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ILike } from 'typeorm';
import { Sku } from '../../../database/entities';

/** Inferred product line — maps to rows in the SKU master (Premium Fresh vs dr. Good Eggs). */
export type SkuBrandFamily = 'premium_fresh' | 'dr_good_eggs' | 'pure_o_fresh';

export interface ParsedPoLineDescriptor {
  brandFamily: SkuBrandFamily | null;
  packSize: number | null;
  combinedText: string;
}

/**
 * Resolves vendor PO line text (codes + long descriptions) to SKUs in our
 * catalogue. Hyperpure-style lines rarely use our internal SKU codes; they
 * look like:
 *   "BH-dr Good Nutrition Enriched Speciality Eggs (Mono Carton), 12 Pieces"
 * Brand rule: only the phrase "premium fresh" (OCR-tolerant) maps to Premium
 * Fresh; every other egg line defaults to dr. Good Eggs. Pack size from
 * "12 Pieces" / "30 Pack" etc., then match active SKUs.
 */
@Injectable()
export class SkuResolutionService {
  private readonly logger = new Logger(SkuResolutionService.name);

  /** Cached active catalogue — refreshed when empty or after TTL. */
  private catalogueCache: { skus: Sku[]; loadedAt: number } | null = null;
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(
    @InjectRepository(Sku)
    private readonly skuRepo: Repository<Sku>,
  ) {}

  async resolve(item: {
    skuCode?: string | null;
    skuName?: string | null;
  }): Promise<Sku | null> {
    const code = item.skuCode?.trim();
    if (code) {
      const byCode = await this.skuRepo.findOne({ where: { code } });
      if (byCode) return byCode;
    }

    const name = item.skuName?.trim();
    if (name) {
      const byName = await this.skuRepo.findOne({
        where: { name: ILike(name) },
      });
      if (byName) return byName;
    }

    const combined = [code, name].filter(Boolean).join(' ').trim();
    if (!combined) return null;

    const parsed = this.parseLineDescriptor(combined);
    if (!parsed.brandFamily || parsed.packSize == null) {
      return null;
    }

    const skus = await this.getActiveCatalogue();
    const candidates = skus.filter(
      (s) =>
        this.skuBrandFamily(s.brand) === parsed.brandFamily &&
        s.packSize === parsed.packSize,
    );

    if (candidates.length === 1) {
      this.logger.log(
        `Semantic SKU match: "${combined.slice(0, 80)}…" → ${candidates[0].code} (${candidates[0].name})`,
      );
      return candidates[0];
    }

    if (candidates.length > 1) {
      const best = this.pickBestNameMatch(combined, candidates);
      if (best) {
        this.logger.log(
          `Semantic SKU match (disambiguated): "${combined.slice(0, 80)}…" → ${best.code}`,
        );
        return best;
      }
    }

    return null;
  }

  /** Exposed for tests and admin tooling. */
  parseLineDescriptor(text: string): ParsedPoLineDescriptor {
    const combinedText = text.replace(/\s+/g, ' ').trim();
    const normalized = this.normalizeVendorText(combinedText);
    return {
      combinedText,
      brandFamily: this.inferBrandFamily(normalized),
      packSize: this.inferPackSize(normalized),
    };
  }

  /**
   * PDF/OCR often breaks words ("Pr emium", "Piec es", "6.0 Pieces").
   * Collapse spacing and fix common splits before keyword matching.
   */
  normalizeVendorText(text: string): string {
    let t = text.toLowerCase().replace(/\s+/g, ' ');
    t = t
      .replace(/prem\s*ium\s*fresh/gi, 'premium fresh')
      .replace(/pr\s+e\s*m\s*i\s*u\s*m\s+fresh/gi, 'premium fresh')
      .replace(/piec\s+es/gi, 'pieces')
      .replace(/p\s*i\s*e\s*c\s*e\s*s/gi, 'pieces')
      .replace(/dr\s*\.?\s*good/gi, 'dr good')
      .replace(/good\s+eggs/gi, 'good eggs');
    return t;
  }

  private async getActiveCatalogue(): Promise<Sku[]> {
    const now = Date.now();
    if (
      this.catalogueCache &&
      now - this.catalogueCache.loadedAt < SkuResolutionService.CACHE_TTL_MS
    ) {
      return this.catalogueCache.skus;
    }
    const skus = await this.skuRepo.find({
      where: { isActive: true },
      order: { code: 'ASC' },
    });
    this.catalogueCache = { skus, loadedAt: now };
    return skus;
  }

  /**
   * Brand from PO wording:
   * - "premium fresh" as a phrase (OCR may split: "prem ium fresh") → Premium Fresh
   * - "pure o fresh" → Pure O Fresh
   * - everything else (including lone "premium", dr good, good nutrition) → dr. Good Eggs
   */
  inferBrandFamily(text: string): SkuBrandFamily {
    const t = text.toLowerCase();

    if (/\bpure\s*o\s*fresh\b/.test(t) || /\bpureo\s*fresh\b/.test(t)) {
      return 'pure_o_fresh';
    }

    if (
      /\bpremium\s+fresh\b/.test(t) ||
      /prem\s*ium\s*fresh/.test(t)
    ) {
      return 'premium_fresh';
    }

    return 'dr_good_eggs';
  }

  /** Classify a catalogue SKU brand using the same phrase rules as PO lines. */
  skuBrandFamily(brand: string): SkuBrandFamily {
    return this.inferBrandFamily(this.normalizeVendorText(brand));
  }

  /**
   * Pack size from phrases like "12 Pieces", "30 Pack", "6 pk", or
   * "12Pack" embedded in vendor codes.
   */
  inferPackSize(text: string): number | null {
    const t = text.toLowerCase();
    const compact = t.replace(/\s/g, '');
    const allowed = new Set([6, 12, 30]);

    const patterns: RegExp[] = [
      // 6.0 pieces, 12.0 Pieces (PDF decimals)
      /\b(6|12|30)(?:\.0+)?\s*(?:pieces?|pcs?|pc|packs?|pk|units?|nos?\.?|numbers?)\b/i,
      /\b(?:pieces?|pcs?|packs?|pk)\s*[:\-]?\s*(6|12|30)(?:\.0+)?\b/i,
      /\b(6|12|30)(?:\.0+)?\s*pack\b/i,
      /\b(6|12|30)pack\b/i,
      /(?:^|[\s\-_/])(?:pf|dr|bh|sku)?[\s\-_]*?(6|12|30)(?:\.0+)?(?:\s*pack)?\b/i,
      // Compact OCR: "6.0pieces", "12pieces"
      /(6|12|30)\.?\d*pieces?/i,
      /\b(6|12|30)\s*p\s*c\b/i,
    ];

    for (const re of patterns) {
      const m = t.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (allowed.has(n)) return n;
      }
    }

    const cm = compact.match(/(6|12|30)\.?\d*pieces?/i);
    if (cm) {
      const n = parseInt(cm[1], 10);
      if (allowed.has(n)) return n;
    }

    return null;
  }

  private pickBestNameMatch(query: string, candidates: Sku[]): Sku | null {
    const q = query.toLowerCase();
    let best: Sku | null = null;
    let bestScore = 0;
    for (const s of candidates) {
      const name = s.name.toLowerCase();
      let score = 0;
      if (q.includes(name) || name.includes(q.slice(0, 20))) score += 3;
      if (q.includes(String(s.packSize))) score += 1;
      const fam = this.skuBrandFamily(s.brand);
      if (fam && q.includes(fam.replace('_', ' '))) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return bestScore > 0 ? best : candidates[0];
  }
}
