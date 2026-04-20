import { IsString, IsEnum, IsNumber, IsBoolean, IsDateString, IsOptional } from 'class-validator';
import { PricingRuleType } from '../../../database/entities';

export class CreatePricingRuleDto {
  @IsString()
  vendorId!: string;

  @IsString()
  brand!: string;

  @IsEnum(PricingRuleType)
  type!: PricingRuleType;

  @IsNumber()
  margin!: number;

  @IsBoolean()
  isPercentage!: boolean;

  @IsOptional()
  @IsString()
  neccCity?: string;

  @IsDateString()
  effectiveFrom!: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;
}
