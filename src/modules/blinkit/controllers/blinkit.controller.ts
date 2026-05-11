import {
  Controller,
  Get,
  Post,
  Query,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { BlinkitService } from '../services/blinkit.service';

@Controller('blinkit')
export class BlinkitController {
  constructor(private readonly blinkitService: BlinkitService) {}

  /** Available cities for city-based scraping */
  @Get('cities')
  getCities() {
    return this.blinkitService.getCities();
  }

  /** Trigger a live scrape for a search query and city */
  @Post('scrape')
  @HttpCode(HttpStatus.ACCEPTED)
  scrape(@Query('q') query = 'eggs', @Query('city') city?: string) {
    return this.blinkitService.scrape(query, city);
  }

  /** Dashboard stats: total scrapes, records, unique products, last scraped */
  @Get('stats')
  getStats(@Query('city') city?: string) {
    return this.blinkitService.getStats(city);
  }

  /** Most recent successful scrape results */
  @Get('products')
  getLatestProducts(
    @Query('q') query = 'eggs',
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('city') city?: string,
  ) {
    return this.blinkitService.getLatestProducts(query, limit, city);
  }

  /** Price history for a named product over last N days */
  @Get('price-history')
  getPriceHistory(
    @Query('name') name: string,
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
    @Query('city') city?: string,
  ) {
    if (!name) return [];
    return this.blinkitService.getPriceHistory(name, days, city);
  }

  /** All unique product names (for chart selector dropdown) */
  @Get('product-names')
  getProductNames(@Query('city') city?: string) {
    return this.blinkitService.getUniqueProductNames(city);
  }

  /** Scrape session history */
  @Get('sessions')
  getSessions(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('city') city?: string,
  ) {
    return this.blinkitService.getSessions(limit, city);
  }

  /** Latest promotion/banner-like text captured during scraping */
  @Get('promotions')
  getPromotions(
    @Query('q') query = 'eggs',
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('city') city?: string,
  ) {
    return this.blinkitService.getLatestPromotions(query, limit, city);
  }
}
