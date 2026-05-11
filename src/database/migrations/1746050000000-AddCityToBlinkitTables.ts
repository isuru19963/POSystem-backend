import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCityToBlinkitTables1746050000000 implements MigrationInterface {
  name = 'AddCityToBlinkitTables1746050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "blinkit_products"
        ADD COLUMN IF NOT EXISTS "city" character varying
    `);

    await queryRunner.query(`
      ALTER TABLE "blinkit_scrape_sessions"
        ADD COLUMN IF NOT EXISTS "city" character varying
    `);

    // Index city on products for fast city-filtered queries
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_blinkit_products_city"
        ON "blinkit_products" ("city")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_blinkit_products_city"`);
    await queryRunner.query(`ALTER TABLE "blinkit_products" DROP COLUMN IF EXISTS "city"`);
    await queryRunner.query(`ALTER TABLE "blinkit_scrape_sessions" DROP COLUMN IF EXISTS "city"`);
  }
}
