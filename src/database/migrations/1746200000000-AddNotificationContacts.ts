import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationContacts1746200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_contacts" (
        "id"         UUID        NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP   NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP   NOT NULL DEFAULT now(),
        "label"      VARCHAR(100) NOT NULL,
        "phone"      VARCHAR(20)  NOT NULL,
        "isActive"   BOOLEAN      NOT NULL DEFAULT true,
        CONSTRAINT "PK_notification_contacts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_notification_contacts_phone" UNIQUE ("phone")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_contacts"`);
  }
}
