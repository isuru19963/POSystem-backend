import {
  IsString,
  IsDateString,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateGrnLineItemDto {
  @IsString()
  skuId!: string;

  @IsInt()
  @Min(0)
  receivedQuantity!: number;

  @IsInt()
  @Min(0)
  acceptedQuantity!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  rejectedQuantity?: number;

  @IsOptional()
  @IsString()
  rejectionReason?: string;
}

export class CreateGrnDto {
  @IsString()
  purchaseOrderId!: string;

  @IsString()
  grnNumber!: string;

  @IsDateString()
  grnDate!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateGrnLineItemDto)
  lineItems!: CreateGrnLineItemDto[];
}
