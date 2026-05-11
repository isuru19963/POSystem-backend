import { Controller, Get, Post, Patch, Delete, Body, Query, Param } from '@nestjs/common';
import { PricingService } from '../services/pricing.service';
import { CreatePricingRuleDto, UpdatePricingRuleDto } from '../dto/create-pricing-rule.dto';

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

  @Patch('rules/:id')
  updateRule(@Param('id') id: string, @Body() dto: UpdatePricingRuleDto) {
    return this.pricingService.updateRule(id, {
      ...dto,
      effectiveFrom: new Date(dto.effectiveFrom),
      effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : undefined,
    });
  }

  @Delete('rules/:id')
  deleteRule(@Param('id') id: string) {
    return this.pricingService.deleteRule(id);
  }
}
