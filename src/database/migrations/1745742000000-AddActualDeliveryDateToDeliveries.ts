import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddActualDeliveryDateToDeliveries1745742000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS actual_delivery_date TIMESTAMP NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE deliveries DROP COLUMN IF EXISTS actual_delivery_date`,
    );
  }
}