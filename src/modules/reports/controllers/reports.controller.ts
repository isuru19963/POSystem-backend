import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
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

  // ---- New report endpoints (date-range filtered) ----

  @Get('city-po-amount')
  cityPoAmount(@Query('from') from: string, @Query('to') to: string) {
    return this.reportsService.getCityWisePoAmount(new Date(from), new Date(to));
  }

  @Get('product-wise')
  productWise(@Query('from') from: string, @Query('to') to: string) {
    return this.reportsService.getProductWise(new Date(from), new Date(to));
  }

  @Get('undelivered-returns')
  undeliveredReturns(@Query('from') from: string, @Query('to') to: string) {
    return this.reportsService.getUndeliveredAndReturns(
      new Date(from),
      new Date(to),
    );
  }

  // ---- CSV exports ----

  @Get('export/vendor-performance')
  async exportVendorPerformance(
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    const data = await this.reportsService.getVendorPerformance(
      new Date(from),
      new Date(to),
    );
    this.sendCsv(res, data, `vendor-performance_${from}_${to}.csv`);
  }

  @Get('export/city-sku-analytics')
  async exportCitySkuAnalytics(
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    const data = await this.reportsService.getCitySkuAnalytics(
      new Date(from),
      new Date(to),
    );
    this.sendCsv(res, data, `city-sku-analytics_${from}_${to}.csv`);
  }

  @Get('export/fulfillment-rates')
  async exportFulfillmentRates(
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    const data = await this.reportsService.getFulfillmentRates(
      new Date(from),
      new Date(to),
    );
    // getFulfillmentRates returns a single object — wrap in array for CSV
    this.sendCsv(res, [data], `fulfillment-rates_${from}_${to}.csv`);
  }

  @Get('export/necc-trends')
  async exportNeccTrends(
    @Query('city') city: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    const data = await this.reportsService.getNeccTrends(
      city,
      new Date(from),
      new Date(to),
    );
    this.sendCsv(res, data as unknown as Record<string, unknown>[], `necc-trends_${city}_${from}_${to}.csv`);
  }

  @Get('export/city-po-amount')
  async exportCityPoAmount(
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    const data = await this.reportsService.getCityWisePoAmount(
      new Date(from),
      new Date(to),
    );
    this.sendCsv(res, data, `city-po-amount_${from}_${to}.csv`);
  }

  @Get('export/product-wise')
  async exportProductWise(
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    const data = await this.reportsService.getProductWise(
      new Date(from),
      new Date(to),
    );
    this.sendCsv(res, data, `product-wise_${from}_${to}.csv`);
  }

  @Get('export/undelivered-returns')
  async exportUndeliveredReturns(
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    const data = await this.reportsService.getUndeliveredAndReturns(
      new Date(from),
      new Date(to),
    );
    this.sendCsv(res, data.items, `undelivered-returns_${from}_${to}.csv`);
  }

  // ---- helpers ----

  private sendCsv(
    res: Response,
    rows: Record<string, unknown>[],
    filename: string,
  ) {
    if (!rows || rows.length === 0) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send('');
    }
    const headers = Object.keys(rows[0]);
    const escape = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((h) => escape(row[h])).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8 compatibility
  }
}
