import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `needs_sku_mapping` to the purchase order status enum. Any line item
 * that cannot be matched to an SKU in our master catalogue holds the parent
 * PO in this state until every line item is mapped — at which point the PO
 * is auto-promoted back to `extracted` and re-validated.
 */
export class AddNeedsSkuMappingPoStatus1747600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Postgres requires literal addition to enums; guard against re-runs.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'purchase_orders_status_enum'
            AND e.enumlabel = 'needs_sku_mapping'
        ) THEN
          ALTER TYPE "purchase_orders_status_enum"
            ADD VALUE 'needs_sku_mapping' AFTER 'extracted';
        END IF;
      END
      $$;
    `);
  }

  public async down(): Promise<void> {
    // Postgres has no native way to drop an enum value; backfill any rows in
    // this state to 'extracted' would be required in a rollback, but we leave
    // the value in place (harmless if unused) to keep this migration safe.
  }
}
