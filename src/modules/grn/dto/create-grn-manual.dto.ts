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

export class ManualGrnLineItemDto {
  /** Item code matching the PO line item */
  @IsString()
  itemCode!: string;

  @IsOptional()
  @IsString()
  itemName?: string;

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

export class CreateGrnManualDto {
  /** PO number to link this GRN to */
  @IsString()
  poNumber!: string;

  @IsString()
  grnNumber!: string;

  @IsDateString()
  grnDate!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManualGrnLineItemDto)
  lineItems!: ManualGrnLineItemDto[];

  /** Set when GRN is created from IMAP (dedupe + audit). */
  @IsOptional()
  @IsString()
  emailMessageId?: string;

  @IsOptional()
  @IsString()
  rawFileKey?: string;
}
