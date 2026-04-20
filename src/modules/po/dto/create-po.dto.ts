import { IsString, IsDateString, IsOptional } from 'class-validator';

export class CreatePoDto {
  @IsString()
  poNumber!: string;

  @IsDateString()
  poDate!: string;

  @IsString()
  vendorCode!: string;

  @IsString()
  shippingLocation!: string;

  @IsOptional()
  @IsString()
  rawFileKey?: string;
}
