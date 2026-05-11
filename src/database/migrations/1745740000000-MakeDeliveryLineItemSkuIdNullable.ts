import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeDeliveryLineItemSkuIdNullable1745740000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE delivery_line_items ALTER COLUMN sku_id DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE delivery_line_items ADD COLUMN IF NOT EXISTS item_code VARCHAR`,
    );
    await queryRunner.query(
      `ALTER TABLE delivery_line_items ADD COLUMN IF NOT EXISTS item_name VARCHAR`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE delivery_line_items DROP COLUMN IF EXISTS item_code`,
    );
    await queryRunner.query(
      `ALTER TABLE delivery_line_items DROP COLUMN IF EXISTS item_name`,
    );
    await queryRunner.query(
      `ALTER TABLE delivery_line_items ALTER COLUMN sku_id SET NOT NULL`,
    );
  }
}
