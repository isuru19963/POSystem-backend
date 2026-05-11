import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeGrnLineItemSkuIdNullableAddItemFields1745960000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Make sku_id nullable
    await queryRunner.query(
      `ALTER TABLE "grn_line_items" ALTER COLUMN "sku_id" DROP NOT NULL`,
    );

    // Add item_code column if not exists
    await queryRunner.query(
      `ALTER TABLE "grn_line_items" ADD COLUMN IF NOT EXISTS "item_code" character varying`,
    );

    // Add item_name column if not exists
    await queryRunner.query(
      `ALTER TABLE "grn_line_items" ADD COLUMN IF NOT EXISTS "item_name" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "grn_line_items" DROP COLUMN IF EXISTS "item_name"`,
    );
    await queryRunner.query(
      `ALTER TABLE "grn_line_items" DROP COLUMN IF EXISTS "item_code"`,
    );
    await queryRunner.query(
      `ALTER TABLE "grn_line_items" ALTER COLUMN "sku_id" SET NOT NULL`,
    );
  }
}
