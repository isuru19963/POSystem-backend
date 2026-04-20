import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { NeccPrice } from '../../../database/entities';

@Injectable()
export class NeccService {
  private readonly logger = new Logger(NeccService.name);

  constructor(
    @InjectRepository(NeccPrice)
    private readonly neccPriceRepo: Repository<NeccPrice>,
  ) {}

  /**
   * Fetch NECC rates daily at 6 AM IST
   */
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async fetchDailyRates(): Promise<void> {
    this.logger.log('Fetching daily NECC rates...');
    try {
      const rates = await this.fetchFromNecc();
      for (const rate of rates) {
        await this.upsertPrice(rate.city, rate.date, rate.price, rate.rawData);
      }
      this.logger.log(`Updated ${rates.length} NECC prices`);
    } catch (error) {
      this.logger.error('Failed to fetch NECC rates', error);
    }
  }

  /**
   * Public method to trigger scraping on demand
   */
  async scrapeNow(): Promise<number> {
    const rates = await this.fetchFromNecc();
    for (const rate of rates) {
      await this.upsertPrice(rate.city, rate.date, rate.price, rate.rawData);
    }
    return rates.length;
  }

  /**
   * Scrape egg prices from the NECC website
   */
  private async fetchFromNecc(): Promise<
    Array<{
      city: string;
      date: Date;
      price: number;
      rawData?: Record<string, unknown>;
    }>
  > {
    const url = 'https://www.e2necc.com/home/eggprice';
    this.logger.log(`Scraping NECC prices from ${url}`);

    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const $ = cheerio.load(response.data);
    const results: Array<{
      city: string;
      date: Date;
      price: number;
      rawData?: Record<string, unknown>;
    }> = [];

    // The default page always returns the current month's data
    const now = new Date();
    const month = now.getMonth(); // 0-indexed
    const year = now.getFullYear();

    // Parse all table rows for price data
    $('table tr').each((_i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 10) return;

      const cityName = $(cells[0]).text().trim();
      if (
        !cityName ||
        cityName === 'Name Of Zone / Day' ||
        cityName.includes('NECC SUGGESTED') ||
        cityName.includes('Prevailing Prices')
      )
        return;

      // Each cell after the first is a day's price; last cell is Average
      const dayCount = cells.length - 2; // subtract city name + average
      for (let day = 1; day <= dayCount; day++) {
        const priceText = $(cells[day]).text().trim();
        if (priceText === '-' || priceText === '') continue;
        const price = parseFloat(priceText);
        if (isNaN(price)) continue;

        const date = new Date(year, month, day);
        // Skip if the day overflows the month
        if (date.getMonth() !== month) continue;

        results.push({
          city: cityName.replace(/\s*\(.*?\)\s*$/, '').trim(),
          date,
          price,
          rawData: { source: 'e2necc.com', originalCity: cityName },
        });
      }
    });

    this.logger.log(`Scraped ${results.length} price entries from NECC`);
    return results;
  }

  /**
   * Get recent prices for a city (last 60 days by default)
   */
  async getRecentPrices(city?: string): Promise<NeccPrice[]> {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 60);

    const where: any = { date: MoreThanOrEqual(fromDate) };
    if (city) where.city = city;

    return this.neccPriceRepo.find({
      where,
      order: { date: 'DESC' },
      take: 500,
    });
  }

  async upsertPrice(
    city: string,
    date: Date,
    price: number,
    rawData?: Record<string, unknown>,
  ): Promise<NeccPrice> {
    const existing = await this.neccPriceRepo.findOne({
      where: { city, date },
    });

    if (existing) {
      existing.price = price;
      if (rawData) existing.rawData = rawData;
      return this.neccPriceRepo.save(existing);
    }

    return this.neccPriceRepo.save(
      this.neccPriceRepo.create({ city, date, price, rawData }),
    );
  }

  async getPrice(city: string, date: Date): Promise<NeccPrice | null> {
    return this.neccPriceRepo.findOne({ where: { city, date } });
  }

  async getPriceHistory(
    city: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<NeccPrice[]> {
    return this.neccPriceRepo.find({
      where: { city, date: Between(fromDate, toDate) },
      order: { date: 'ASC' },
    });
  }

  async getCities(): Promise<string[]> {
    const result = await this.neccPriceRepo
      .createQueryBuilder('np')
      .select('DISTINCT np.city', 'city')
      .getRawMany<{ city: string }>();
    return result.map((r) => r.city);
  }
}
