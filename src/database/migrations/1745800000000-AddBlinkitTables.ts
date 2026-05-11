import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBlinkitTables1745800000000 implements MigrationInterface {
  name = 'AddBlinkitTables1745800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "scrape_status_enum" AS ENUM ('pending', 'success', 'failed')
    `);

    await queryRunner.query(`
      CREATE TABLE "blinkit_scrape_sessions" (
        "id"           uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "created_at"   TIMESTAMP         NOT NULL DEFAULT now(),
        "updated_at"   TIMESTAMP         NOT NULL DEFAULT now(),
        "search_query" character varying NOT NULL DEFAULT 'eggs',
        "status"       "scrape_status_enum" NOT NULL DEFAULT 'pending',
        "products_found" integer         NOT NULL DEFAULT 0,
        "scraped_at"   TIMESTAMP WITH TIME ZONE,
        "error"        text,
        CONSTRAINT "PK_blinkit_scrape_sessions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "blinkit_products" (
        "id"              uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "created_at"      TIMESTAMP         NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMP         NOT NULL DEFAULT now(),
        "name"            character varying NOT NULL,
        "blinkit_id"      character varying,
        "size"            character varying,
        "price"           numeric(10, 2),
        "mrp"             numeric(10, 2),
        "discount_percent" numeric(5, 2),
        "in_stock"        boolean           NOT NULL DEFAULT true,
        "image_url"       character varying,
        "brand"           character varying,
        "search_query"    character varying NOT NULL DEFAULT 'eggs',
        "scraped_at"      TIMESTAMP WITH TIME ZONE NOT NULL,
        "session_id"      character varying NOT NULL,
        CONSTRAINT "PK_blinkit_products" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_blinkit_products_scraped_at" ON "blinkit_products" ("scraped_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_blinkit_products_scraped_at"`);
    await queryRunner.query(`DROP TABLE "blinkit_products"`);
    await queryRunner.query(`DROP TABLE "blinkit_scrape_sessions"`);
    await queryRunner.query(`DROP TYPE "scrape_status_enum"`);
  }
}
