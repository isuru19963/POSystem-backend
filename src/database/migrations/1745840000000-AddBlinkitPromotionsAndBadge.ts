import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBlinkitPromotionsAndBadge1745840000000 implements MigrationInterface {
  name = 'AddBlinkitPromotionsAndBadge1745840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "blinkit_products"
      ADD COLUMN IF NOT EXISTS "promo_badge" character varying
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "blinkit_promotions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "title" character varying NOT NULL,
        "description" text,
        "target_url" character varying,
        "image_url" character varying,
        "search_query" character varying NOT NULL DEFAULT 'eggs',
        "scraped_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "session_id" character varying NOT NULL,
        CONSTRAINT "PK_blinkit_promotions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_blinkit_promotions_scraped_at"
      ON "blinkit_promotions" ("scraped_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_blinkit_promotions_scraped_at"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "blinkit_promotions"`);
    await queryRunner.query(`ALTER TABLE "blinkit_products" DROP COLUMN IF EXISTS "promo_badge"`);
  }
}
