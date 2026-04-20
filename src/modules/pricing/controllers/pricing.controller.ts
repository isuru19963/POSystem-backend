import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { PricingService } from '../services/pricing.service';
import { CreatePricingRuleDto } from '../dto/create-pricing-rule.dto';

@Controller('pricing')
export class PricingController {
  constructor(private readonly pricingService: PricingService) {}

  @Get('rules')
  findAllRules(@Query('vendorId') vendorId?: string) {
    return this.pricingService.findAllRules(vendorId);
  }

  @Post('rules')
  createRule(@Body() dto: CreatePricingRuleDto) {
    return this.pricingService.createRule({
      ...dto,
      effectiveFrom: new Date(dto.effectiveFrom),
      effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : undefined,
    });
  }
}
