import { IsString, IsDateString, IsOptional, IsEnum } from 'class-validator';
import { DispatchStatus } from '../../../database/entities';

export class UpdateDeliveryDto {
  @IsOptional()
  @IsEnum(DispatchStatus)
  status?: DispatchStatus;

  @IsOptional()
  @IsString()
  vehicleNumber?: string;

  @IsOptional()
  @IsString()
  driverName?: string;

  @IsOptional()
  @IsString()
  driverPhone?: string;

  @IsOptional()
  @IsString()
  routeId?: string;

  @IsOptional()
  @IsDateString()
  dispatchDate?: string;
}
