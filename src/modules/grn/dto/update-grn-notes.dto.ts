import { IsOptional, IsString } from 'class-validator';

export class UpdateGrnNotesDto {
  @IsOptional()
  @IsString()
  notes?: string;
}
