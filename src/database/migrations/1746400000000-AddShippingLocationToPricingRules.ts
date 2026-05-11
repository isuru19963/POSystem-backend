import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShippingLocationToPricingRules1746400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "vendor_pricing_rules"
      ADD COLUMN IF NOT EXISTS "shipping_location" character varying NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "vendor_pricing_rules" DROP COLUMN IF EXISTS "shipping_location"
    `);
  }
}
