import { IsString, IsInt, Min, Max, IsOptional, IsBoolean, Matches } from 'class-validator';

export class CreateTatConfigDto {
  @IsString()
  vendorId!: string;

  /** 0 = Sunday, 6 = Saturday */
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  /** Expected time in HH:mm format */
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'expectedBy must be in HH:mm format' })
  expectedBy!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
