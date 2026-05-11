import { IsEnum } from 'class-validator';
import { GrnStatus } from '../../../database/entities';

export class UpdateGrnStatusDto {
  @IsEnum(GrnStatus, {
    message: `status must be one of: ${Object.values(GrnStatus).join(', ')}`,
  })
  status!: GrnStatus;
}
