import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The original AddNotificationContacts migration created `createdAt` /
 * `updatedAt` columns, but `BaseEntity` maps `@CreateDateColumn` /
 * `@UpdateDateColumn` to `created_at` / `updated_at`. That mismatch caused
 * every insert/select against `notification_contacts` to throw, surfacing as
 * a 500 from `POST /admin/notification-contacts`.
 *
 * This migration normalizes the columns to snake_case to match the rest of
 * the schema. It is idempotent so it is safe to run multiple times and on
 * environments where the table was never created with the wrong names.
 */
export class FixNotificationContactsTimestamps1746300000000
  implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'notification_contacts'
            AND column_name = 'createdAt'
        ) THEN
          ALTER TABLE "notification_contacts" RENAME COLUMN "createdAt" TO "created_at";
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'notification_contacts'
            AND column_name = 'updatedAt'
        ) THEN
          ALTER TABLE "notification_contacts" RENAME COLUMN "updatedAt" TO "updated_at";
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "notification_contacts"
        ALTER COLUMN "created_at" SET DEFAULT now(),
        ALTER COLUMN "updated_at" SET DEFAULT now();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'notification_contacts'
            AND column_name = 'created_at'
        ) THEN
          ALTER TABLE "notification_contacts" RENAME COLUMN "created_at" TO "createdAt";
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'notification_contacts'
            AND column_name = 'updated_at'
        ) THEN
          ALTER TABLE "notification_contacts" RENAME COLUMN "updated_at" TO "updatedAt";
        END IF;
      END $$;
    `);
  }
}
