import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPackSizeAndPureOFreshToPricingRules1745900000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add pack_size column to vendor_pricing_rules
    await queryRunner.query(`
      ALTER TABLE "vendor_pricing_rules"
      ADD COLUMN IF NOT EXISTS "pack_size" integer NULL
    `);

    // Add pure_o_fresh to the pricing_rule_type enum
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = 'pure_o_fresh'
            AND enumtypid = (
              SELECT oid FROM pg_type WHERE typname = 'vendor_pricing_rules_type_enum'
            )
        ) THEN
          ALTER TYPE "vendor_pricing_rules_type_enum" ADD VALUE 'pure_o_fresh';
        END IF;
      END$$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "vendor_pricing_rules" DROP COLUMN IF EXISTS "pack_size"
    `);
    // Note: PostgreSQL does not support removing enum values without recreating the type
  }
}
