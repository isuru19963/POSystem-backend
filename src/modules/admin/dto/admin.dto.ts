import {
  IsString,
  IsEmail,
  IsOptional,
  IsNumber,
  Min,
  Max,
  IsBoolean,
  IsArray,
  IsEnum,
  IsPositive,
  IsInt,
  MinLength,
  IsDateString,
} from 'class-validator';
import { UserRole } from '../../../database/entities';

// ---- Vendor DTOs ----

export class CreateVendorDto {
  @IsString()
  name!: string;

  @IsString()
  code!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateVendorDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ---- SKU DTOs ----

export class CreateSkuDto {
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsString()
  brand!: string;

  @IsInt()
  @IsPositive()
  packSize!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  mrp?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateSkuDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  packSize?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  mrp?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ---- Route DTOs ----

export class CreateRouteDto {
  @IsString()
  name!: string;

  @IsArray()
  @IsString({ each: true })
  stops!: string[];

  @IsOptional()
  @IsString()
  vehicleType?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ---- Location Mapping DTOs ----

export class CreateLocationMappingDto {
  @IsString()
  shippingLocation!: string;

  @IsString()
  neccCity!: string;

  @IsOptional()
  @IsString()
  state?: string;
}

// ---- Vehicle DTOs ----

export class CreateVehicleDto {
  @IsString()
  vehicleNumber!: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  capacity?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  vehicleNumber?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  capacity?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

// ---- Driver DTOs ----

export class CreateDriverDto {
  @IsString()
  name!: string;

  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  license?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateDriverDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  license?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

/** Bulk-create default vendor pricing rules (all three brands) for every customer. */
export class SeedDefaultPricingRulesDto {
  @IsDateString()
  effectiveFrom!: string;

  /** Premium Fresh: fixed ₹ per egg added to NECC (not a %). Default 1. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  premiumFreshMarginPerEgg?: number;

  /** Dr Good Eggs: discount % from MRP. Default 25. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  drGoodEggsMarginPercent?: number;

  /** Pure O Fresh: discount % from MRP. Default 25. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  pureOFreshMarginPercent?: number;

  /** If true (default), skip vendor+brand when an active catch-all rule already exists (no ship-to, no pack-size). */
  @IsOptional()
  @IsBoolean()
  skipExisting?: boolean;

  /** If true, also include inactive vendors. Default false. */
  @IsOptional()
  @IsBoolean()
  includeInactiveVendors?: boolean;
}

// ---- User DTOs ----

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  firstName!: string;

  @IsString()
  lastName!: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Paste CSV for WhatsApp notification contacts: optional header `phone,label` */
export class ImportNotificationContactsCsvDto {
  @IsString()
  @MinLength(1)
  csv!: string;
}
