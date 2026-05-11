import { IsString, IsEnum, IsNumber, IsBoolean, IsDateString, IsOptional, IsInt } from 'class-validator';
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

  /** When set, rule applies only to POs with this shipping_location (all rule types). */
  @IsOptional()
  @IsString()
  shippingLocation?: string;

  /**
   * For Premium Fresh: pack size this margin applies to (6, 12, 30).
   * Leave empty to apply to all pack sizes.
   */
  @IsOptional()
  @IsInt()
  packSize?: number;

  @IsDateString()
  effectiveFrom!: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePricingRuleDto extends CreatePricingRuleDto {}
