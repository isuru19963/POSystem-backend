import { IsEnum, IsOptional, IsString, IsDateString } from 'class-validator';
import { PoStatus } from '../../../database/entities';

export class QueryPoDto {
  @IsOptional()
  @IsEnum(PoStatus)
  status?: PoStatus;

  @IsOptional()
  @IsString()
  vendorId?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsString()
  poNumber?: string;
}
