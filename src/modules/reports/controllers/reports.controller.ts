import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from '../services/reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('vendor-performance')
  vendorPerformance(
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.reportsService.getVendorPerformance(
      new Date(from),
      new Date(to),
    );
  }

  @Get('city-sku-analytics')
  citySkuAnalytics(
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.reportsService.getCitySkuAnalytics(
      new Date(from),
      new Date(to),
    );
  }

  @Get('fulfillment-rates')
  fulfillmentRates(
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.reportsService.getFulfillmentRates(
      new Date(from),
      new Date(to),
    );
  }

  @Get('necc-trends')
  neccTrends(
    @Query('city') city: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.reportsService.getNeccTrends(
      city,
      new Date(from),
      new Date(to),
    );
  }

  @Get('dispatch-summary')
  dispatchSummary(@Query('date') date: string) {
    return this.reportsService.getDispatchSummary(new Date(date));
  }
}
