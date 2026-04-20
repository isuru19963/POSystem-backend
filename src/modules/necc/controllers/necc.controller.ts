import { Controller, Get, Post, Query } from '@nestjs/common';
import { NeccService } from '../services/necc.service';

@Controller('necc')
export class NeccController {
  constructor(private readonly neccService: NeccService) {}

  /** Get recent prices, optionally filtered by city */
  @Get()
  getRecent(@Query('city') city?: string) {
    return this.neccService.getRecentPrices(city);
  }

  @Get('prices')
  getPriceHistory(
    @Query('city') city: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.neccService.getPriceHistory(
      city,
      new Date(from),
      new Date(to),
    );
  }

  @Get('cities')
  getCities() {
    return this.neccService.getCities();
  }

  @Get('price')
  getPrice(@Query('city') city: string, @Query('date') date: string) {
    return this.neccService.getPrice(city, new Date(date));
  }

  /** Trigger a manual scrape of NECC prices */
  @Post('scrape')
  async scrape() {
    const count = await this.neccService.scrapeNow();
    return { message: `Scraped ${count} price entries` };
  }
}
