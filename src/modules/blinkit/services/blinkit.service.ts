import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { BlinkitProduct } from '../../../database/entities/blinkit-product.entity';
import { BlinkitPromotion } from '../../../database/entities/blinkit-promotion.entity';
import { BlinkitScrapeSession, ScrapeStatus } from '../../../database/entities/blinkit-scrape-session.entity';

export const BLINKIT_CITIES: Record<string, { lat: number; lon: number; label: string }> = {
  hyderabad:  { lat: 17.3850, lon: 78.4867, label: 'Hyderabad' },
  mumbai:     { lat: 19.0760, lon: 72.8777, label: 'Mumbai' },
  pune:       { lat: 18.5204, lon: 73.8567, label: 'Pune' },
  bengaluru:  { lat: 12.9716, lon: 77.5946, label: 'Bengaluru' },
  vijayawada: { lat: 16.5062, lon: 80.6480, label: 'Vijayawada' },
};

export const DEFAULT_CITY = 'hyderabad';

@Injectable()
export class BlinkitService {
  private readonly logger = new Logger(BlinkitService.name);

  // Blinkit's public search page (no auth required)
  private readonly BLINKIT_URL = 'https://blinkit.com/s/?q=';
  private readonly JINA_PROXY_URL = 'https://r.jina.ai/https://blinkit.com/s/?q=';

  // Headers that mimic a real browser to avoid bot detection
  private readonly BROWSER_HEADERS = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
  };

  constructor(
    @InjectRepository(BlinkitProduct)
    private readonly productRepo: Repository<BlinkitProduct>,
    @InjectRepository(BlinkitPromotion)
    private readonly promotionRepo: Repository<BlinkitPromotion>,
    @InjectRepository(BlinkitScrapeSession)
    private readonly sessionRepo: Repository<BlinkitScrapeSession>,
  ) {}

  /**
   * Automatic scrape every 30 minutes for all cities
   * (can be disabled with BLINKIT_AUTO_SCRAPE_ENABLED=false).
   */
  @Cron('*/30 * * * *')
  async runScheduledScrape(): Promise<void> {
    const enabled = String(process.env.BLINKIT_AUTO_SCRAPE_ENABLED ?? 'true').toLowerCase();
    if (enabled === 'false' || enabled === '0') {
      return;
    }

    const defaultQuery = process.env.BLINKIT_DEFAULT_QUERY ?? 'eggs';
    this.logger.log(`Running scheduled Blinkit scrape for "${defaultQuery}" across all cities`);

    for (const city of Object.keys(BLINKIT_CITIES)) {
      await this.scrape(defaultQuery, city);
    }
  }

  // ------------------------------------------------------------------
  // Scrape + persist
  // ------------------------------------------------------------------
  async scrape(query = 'eggs', city = DEFAULT_CITY): Promise<BlinkitScrapeSession> {
    const normalizedCity = city.toLowerCase().trim();
    const session = await this.sessionRepo.save(
      this.sessionRepo.create({ searchQuery: query, city: normalizedCity, status: ScrapeStatus.PENDING }),
    );

    try {
      const products = await this.fetchProducts(query, session.id, normalizedCity);

      if (products.length) {
        await this.productRepo.save(products);
      }

      await this.scrapePromotions(query, session.id);

      session.status = ScrapeStatus.SUCCESS;
      session.productsFound = products.length;
      session.scrapedAt = new Date();
      await this.sessionRepo.save(session);

      this.logger.log(`Scraped ${products.length} products for "${query}" in ${normalizedCity}`);
    } catch (err: any) {
      this.logger.error(`Scrape failed for city ${normalizedCity}: ${err?.message}`);
      session.status = ScrapeStatus.FAILED;
      session.error = String(err?.message ?? err);
      await this.sessionRepo.save(session);
    }

    return session;
  }

  private buildBlinkitUrl(query: string, city: string): string {
    const coords = BLINKIT_CITIES[city] ?? BLINKIT_CITIES[DEFAULT_CITY];
    return `${this.BLINKIT_URL}${encodeURIComponent(query)}&lat=${coords.lat}&lon=${coords.lon}`;
  }

  private buildLocationHeaders(city: string): Record<string, string> {
    const coords = BLINKIT_CITIES[city] ?? BLINKIT_CITIES[DEFAULT_CITY];
    return {
      ...this.BROWSER_HEADERS,
      Cookie: `userLat=${coords.lat}; userLon=${coords.lon}; gr_1=${coords.lat}%2C${coords.lon}`,
    };
  }

  private async fetchProducts(
    query: string,
    sessionId: string,
    city: string,
  ): Promise<BlinkitProduct[]> {
    const directUrl = this.buildBlinkitUrl(query, city);
    this.logger.log(`Scraping [${city}]: ${directUrl}`);

    try {
      const response = await axios.get<string>(directUrl, {
        headers: this.buildLocationHeaders(city),
        responseType: 'text',
        timeout: 30_000,
      });

      const parsedProducts = this.parseProducts(response.data as string, query, sessionId, city);
      if (parsedProducts.length) {
        return parsedProducts;
      }
    } catch (error: any) {
      this.logger.warn(
        `Direct Blinkit scrape failed for ${city}, trying proxy fallback: ${error?.message ?? error}`,
      );
    }

    return this.fetchProductsViaProxy(query, sessionId, city);
  }

  private async fetchProductsViaProxy(
    query: string,
    sessionId: string,
    city: string,
  ): Promise<BlinkitProduct[]> {
    const targetUrl = this.buildBlinkitUrl(query, city);
    const proxyUrl = `https://r.jina.ai/${targetUrl}`;
    this.logger.log(`Scraping via proxy fallback [${city}]: ${proxyUrl}`);

    const response = await axios.get<string>(proxyUrl, {
      responseType: 'text',
      timeout: 30_000,
      headers: {
        Accept: 'text/plain, text/markdown;q=0.9, */*;q=0.8',
        'User-Agent': this.BROWSER_HEADERS['User-Agent'],
      },
    });

    const proxyProducts = this.parseJinaMarkdown(
      response.data as string,
      query,
      sessionId,
      city,
    );

    if (!proxyProducts.length) {
      throw new Error(`Blinkit proxy fallback returned no products for city ${city}`);
    }

    return proxyProducts;
  }

  // ------------------------------------------------------------------
  // Parse HTML → BlinkitProduct[]
  // Blinkit renders a React SPA; the initial HTML contains JSON state
  // in a <script id="__NEXT_DATA__"> or product cards for SSR.
  // We try JSON first, then fall back to CSS selectors.
  // ------------------------------------------------------------------
  private parseProducts(
    html: string,
    query: string,
    sessionId: string,
    city: string,
  ): BlinkitProduct[] {
    const scrapedAt = new Date();

    // --- 1. Try extracting embedded JSON (Next.js __NEXT_DATA__) ---
    const jsonProducts = this.parseNextData(html, query, sessionId, scrapedAt, city);
    if (jsonProducts.length) return jsonProducts;

    // --- 2. Fallback: parse structured JSON-LD or meta tags ---
    const ldProducts = this.parseJsonLd(html, query, sessionId, scrapedAt, city);
    if (ldProducts.length) return ldProducts;

    // --- 3. Fallback: cheerio DOM parsing ---
    return this.parseViaCheerio(html, query, sessionId, scrapedAt, city);
  }

  private parseJinaMarkdown(
    markdown: string,
    query: string,
    sessionId: string,
    city: string,
  ): BlinkitProduct[] {
    const scrapedAt = new Date();
    const lines = markdown
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const markerIndex = lines.findIndex((line) => line === 'Markdown Content:');
    const contentLines = markerIndex >= 0 ? lines.slice(markerIndex + 1) : lines;
    const products: BlinkitProduct[] = [];

    let index = 0;
    while (index < contentLines.length) {
      const line = contentLines[index];

      if (!line.startsWith('![')) {
        index += 1;
        continue;
      }

      let cursor = index + 1;
      while (cursor < contentLines.length && !contentLines[cursor].startsWith('₹')) {
        cursor += 1;
      }

      if (cursor >= contentLines.length) {
        break;
      }

      const metadataLines = contentLines.slice(index + 1, cursor).filter((entry) => entry !== 'ADD');
      const productName = metadataLines.find((entry) => !/^\d+\s+mins$/i.test(entry) && !/^\d+\s*(pcs|pc|g|kg|ml|l)\b/i.test(entry));
      const size = metadataLines.find((entry) => /^\d+\s*(pcs|pc|g|kg|ml|l)\b/i.test(entry));
      const promoBadge = metadataLines.find((entry) => /(%\s*off|off|save|deal|offer)/i.test(entry));
      const prices: number[] = [];

      while (cursor < contentLines.length && (contentLines[cursor].startsWith('₹') || contentLines[cursor] === 'ADD')) {
        if (contentLines[cursor].startsWith('₹')) {
          const numericValue = parseFloat(contentLines[cursor].replace(/[^\d.]/g, ''));
          if (!Number.isNaN(numericValue)) {
            prices.push(numericValue);
          }
        }
        cursor += 1;
      }

      if (productName && prices.length) {
        const [price, mrp] = prices;
        const product = this.productRepo.create({
          name: productName,
          size,
          price,
          mrp,
          discountPercent:
            price && mrp && mrp > price
              ? Math.round(((mrp - price) / mrp) * 100)
              : undefined,
          promoBadge,
          inStock: true,
          city,
          searchQuery: query,
          sessionId,
          scrapedAt,
        });
        products.push(product);
      }

      index = cursor;
    }

    return products;
  }

  private parseNextData(
    html: string,
    query: string,
    sessionId: string,
    scrapedAt: Date,
    city: string,
  ): BlinkitProduct[] {
    try {
      const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (!match) return [];

      const json = JSON.parse(match[1]);

      // Drill into page props to find product arrays (Blinkit structure)
      const pageProps =
        json?.props?.pageProps ??
        json?.props?.initialProps ??
        {};

      // Blinkit categories / search may nest under different keys.
      // Try common patterns.
      const rawProducts: any[] =
        pageProps?.searchResults?.products ??
        pageProps?.products ??
        pageProps?.data?.products ??
        pageProps?.initialData?.products ??
        [];

      return rawProducts.map((p: any) => this.mapJsonProduct(p, query, sessionId, scrapedAt, city));
    } catch {
      return [];
    }
  }

  private parseJsonLd(
    html: string,
    query: string,
    sessionId: string,
    scrapedAt: Date,
    city: string,
  ): BlinkitProduct[] {
    try {
      const $ = cheerio.load(html);
      const results: BlinkitProduct[] = [];

      $('script[type="application/ld+json"]').each((_i, el) => {
        try {
          const data = JSON.parse($(el).html() || '{}');
          const items: any[] = Array.isArray(data) ? data : [data];
          items.forEach((item) => {
            if (item['@type'] === 'Product') {
              const p = this.productRepo.create({
                name: item.name ?? 'Unknown',
                blinkitId: item.productID ?? item.sku ?? undefined,
                price: item.offers?.price ? parseFloat(item.offers.price) : undefined,
                mrp: item.offers?.highPrice ? parseFloat(item.offers.highPrice) : undefined,
                promoBadge:
                  item.offers?.description ??
                  item.additionalProperty?.find?.((prop: any) => /offer|promo|badge/i.test(String(prop?.name ?? '')))?.value ??
                  undefined,
                brand: item.brand?.name ?? undefined,
                imageUrl: item.image ?? undefined,
                inStock: item.offers?.availability !== 'https://schema.org/OutOfStock',
                city,
                searchQuery: query,
                sessionId,
                scrapedAt,
              });
              if (p.price && p.mrp && p.mrp > p.price) {
                p.discountPercent = Math.round(((p.mrp - p.price) / p.mrp) * 100);
              }
              results.push(p);
            }
          });
        } catch { /* skip malformed */ }
      });

      return results;
    } catch {
      return [];
    }
  }

  private parseViaCheerio(
    html: string,
    query: string,
    sessionId: string,
    scrapedAt: Date,
    city: string,
  ): BlinkitProduct[] {
    const $ = cheerio.load(html);
    const results: BlinkitProduct[] = [];

    // Generic product card selectors — Blinkit uses various class names
    const cardSelectors = [
      '[data-testid="product-card"]',
      '.product-card',
      '.ProductCard',
      '[class*="product-card"]',
      '[class*="ProductCard"]',
      'div[class*="plp-product"]',
    ];

    let cards = $();
    for (const sel of cardSelectors) {
      cards = $(sel);
      if (cards.length) break;
    }

    cards.each((_i, el) => {
      const card = $(el);
      const nameEl = card
        .find('[class*="product-name"], [class*="ProductName"], h3, h4, [class*="name"]')
        .first();
      const name = nameEl.text().trim();
      if (!name) return;

      const priceText = card
        .find('[class*="sale-price"], [class*="SalePrice"], [class*="selling-price"]')
        .first()
        .text()
        .replace(/[₹,\s]/g, '');
      const mrpText = card
        .find('[class*="mrp"], [class*="MRP"], s, del')
        .first()
        .text()
        .replace(/[₹,\s]/g, '');
      const discountText = card
        .find('[class*="discount"], [class*="Discount"]')
        .first()
        .text()
        .replace(/[%\s]/g, '');
      const sizeText = card
        .find('[class*="weight"], [class*="size"], [class*="unit"]')
        .first()
        .text()
        .trim();
      const stockText = card
        .find('[class*="out-of-stock"], [class*="OutOfStock"]')
        .first()
        .text()
        .toLowerCase();
      const promoBadgeText = card
        .find('[class*="promo"], [class*="badge"], [class*="offer"], [class*="tag"]')
        .first()
        .text()
        .trim();
      const imgEl = card.find('img').first();
      const imageUrl = imgEl.attr('src') ?? imgEl.attr('data-src') ?? undefined;

      const price = parseFloat(priceText);
      const mrp = parseFloat(mrpText);
      const discount = parseFloat(discountText);

      const p = this.productRepo.create({
        name,
        size: sizeText || undefined,
        price: isNaN(price) ? undefined : price,
        mrp: isNaN(mrp) ? undefined : mrp,
        discountPercent: isNaN(discount)
          ? price && mrp && mrp > price
            ? Math.round(((mrp - price) / mrp) * 100)
            : undefined
          : discount,
        promoBadge: promoBadgeText || undefined,
        inStock: !stockText.includes('out'),
        imageUrl,
        city,
        searchQuery: query,
        sessionId,
        scrapedAt,
      });
      results.push(p);
    });

    return results;
  }

  private mapJsonProduct(
    p: any,
    query: string,
    sessionId: string,
    scrapedAt: Date,
    city: string,
  ): BlinkitProduct {
    const price = parseFloat(p.selling_price ?? p.price ?? p.offerPrice ?? 0);
    const mrp = parseFloat(p.mrp ?? p.originalPrice ?? p.maxRetailPrice ?? 0);
    const product = this.productRepo.create({
      name: p.name ?? p.product_name ?? 'Unknown',
      blinkitId: String(p.id ?? p.product_id ?? p.sku ?? ''),
      size: p.unit ?? p.weight ?? p.size ?? undefined,
      price: isNaN(price) ? undefined : price,
      mrp: isNaN(mrp) ? undefined : mrp,
      discountPercent:
        price && mrp && mrp > price
          ? Math.round(((mrp - price) / mrp) * 100)
          : undefined,
      promoBadge:
        p.promo_badge ??
        p.offer_text ??
        p.badge_text ??
        p.badge ??
        undefined,
      inStock: p.in_stock ?? p.availability ?? true,
      imageUrl: p.image_url ?? p.image ?? undefined,
      brand: p.brand ?? p.brand_name ?? undefined,
      city,
      searchQuery: query,
      sessionId,
      scrapedAt,
    });
    return product;
  }

  private async scrapePromotions(query: string, sessionId: string): Promise<void> {
    const proxyUrl = `${this.JINA_PROXY_URL}${encodeURIComponent(query)}`;

    try {
      const response = await axios.get<string>(proxyUrl, {
        responseType: 'text',
        timeout: 30_000,
        headers: {
          Accept: 'text/plain, text/markdown;q=0.9, */*;q=0.8',
          'User-Agent': this.BROWSER_HEADERS['User-Agent'],
        },
      });

      const promotions = this.parseJinaPromotions(response.data as string, query, sessionId);
      if (promotions.length) {
        await this.promotionRepo.save(promotions);
      }
    } catch (error: any) {
      this.logger.warn(`Promotion scrape skipped: ${error?.message ?? error}`);
    }
  }

  private parseJinaPromotions(
    markdown: string,
    query: string,
    sessionId: string,
  ): BlinkitPromotion[] {
    const scrapedAt = new Date();
    const lines = markdown
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const candidates = lines.filter((line) => /(%\s*off|off|offer|deal|combo|save|banner)/i.test(line));
    const unique = [...new Set(candidates)].slice(0, 30);

    return unique.map((title) => this.promotionRepo.create({
      title,
      description: undefined,
      targetUrl: undefined,
      imageUrl: undefined,
      searchQuery: query,
      sessionId,
      scrapedAt,
    }));
  }

  // ------------------------------------------------------------------
  // Query helpers
  // ------------------------------------------------------------------
  async getSessions(limit = 20, city?: string): Promise<BlinkitScrapeSession[]> {
    return this.sessionRepo.find({
      where: city ? { city: city.toLowerCase() } : {},
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getLatestProducts(query = 'eggs', limit = 100, city?: string): Promise<BlinkitProduct[]> {
    // Get most recent successful session for query (optionally city-scoped)
    const session = await this.sessionRepo.findOne({
      where: city
        ? { searchQuery: query, city: city.toLowerCase(), status: ScrapeStatus.SUCCESS }
        : { searchQuery: query, status: ScrapeStatus.SUCCESS },
      order: { createdAt: 'DESC' },
    });

    if (!session) return [];

    return this.productRepo.find({
      where: { sessionId: session.id },
      order: { name: 'ASC' },
      take: limit,
    });
  }

  async getPriceHistory(
    productName: string,
    days = 30,
    city?: string,
  ): Promise<BlinkitProduct[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const qb = this.productRepo
      .createQueryBuilder('p')
      .where('LOWER(p.name) LIKE :name', { name: `%${productName.toLowerCase()}%` })
      .andWhere('p.scraped_at >= :since', { since });

    if (city) {
      qb.andWhere('p.city = :city', { city: city.toLowerCase() });
    }

    return qb.orderBy('p.scraped_at', 'ASC').getMany();
  }

  async getStats(city?: string): Promise<{
    totalScrapes: number;
    recordsCollected: number;
    uniqueProducts: number;
    lastScraped: Date | null;
  }> {
    const cityFilter = city ? { city: city.toLowerCase() } : {};
    const [totalScrapes, recordsCollected, uniqueProducts] = await Promise.all([
      this.sessionRepo.count({ where: { status: ScrapeStatus.SUCCESS, ...cityFilter } }),
      this.productRepo.count({ where: city ? { city: city.toLowerCase() } : {} }),
      (() => {
        const qb = this.productRepo
          .createQueryBuilder('p')
          .select('COUNT(DISTINCT p.name)', 'cnt');
        if (city) qb.where('p.city = :city', { city: city.toLowerCase() });
        return qb.getRawOne().then((r) => parseInt(r?.cnt ?? '0', 10));
      })(),
    ]);

    const latestSession = await this.sessionRepo.findOne({
      where: { status: ScrapeStatus.SUCCESS, ...cityFilter },
      order: { createdAt: 'DESC' },
    });

    return {
      totalScrapes,
      recordsCollected,
      uniqueProducts,
      lastScraped: latestSession?.scrapedAt ?? null,
    };
  }

  async getUniqueProductNames(city?: string): Promise<string[]> {
    const qb = this.productRepo
      .createQueryBuilder('p')
      .select('DISTINCT p.name', 'name');
    if (city) qb.where('p.city = :city', { city: city.toLowerCase() });
    const rows = await qb.orderBy('p.name', 'ASC').getRawMany();
    return rows.map((r) => r.name as string);
  }

  async getLatestPromotions(query = 'eggs', limit = 20, city?: string): Promise<BlinkitPromotion[]> {
    const session = await this.sessionRepo.findOne({
      where: city
        ? { searchQuery: query, city: city.toLowerCase(), status: ScrapeStatus.SUCCESS }
        : { searchQuery: query, status: ScrapeStatus.SUCCESS },
      order: { createdAt: 'DESC' },
    });

    if (!session) return [];

    return this.promotionRepo.find({
      where: { sessionId: session.id },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  getCities(): { key: string; label: string; lat: number; lon: number }[] {
    return Object.entries(BLINKIT_CITIES).map(([key, v]) => ({ key, ...v }));
  }
}
