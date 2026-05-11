import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotesToGrns1746000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "grns" ADD COLUMN IF NOT EXISTS "notes" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "grns" DROP COLUMN IF EXISTS "notes"`);
  }
}
