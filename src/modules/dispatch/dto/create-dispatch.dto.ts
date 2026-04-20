import { IsString, IsDateString, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class DispatchLineItemDto {
  @IsString()
  skuId!: string;

  orderedQuantity!: number;
}

export class CreateDispatchDto {
  @IsString()
  purchaseOrderId!: string;

  @IsOptional()
  @IsString()
  routeId?: string;

  @IsOptional()
  @IsString()
  vehicleNumber?: string;

  @IsOptional()
  @IsString()
  driverName?: string;

  @IsOptional()
  @IsString()
  driverPhone?: string;

  @IsDateString()
  dispatchDate!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DispatchLineItemDto)
  lineItems!: DispatchLineItemDto[];
}
