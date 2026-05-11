import { IsEnum } from 'class-validator';
import { DispatchStatus } from '../../../database/entities';

export class UpdateDeliveryStatusDto {
  @IsEnum(DispatchStatus, {
    message: `status must be one of: ${Object.values(DispatchStatus).join(', ')}`,
  })
  status!: DispatchStatus;
}
