import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVehiclesAndDrivers1746120000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vehicles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "vehicle_number" character varying NOT NULL,
        "type" character varying,
        "capacity" character varying,
        "is_active" boolean NOT NULL DEFAULT true,
        "notes" character varying,
        CONSTRAINT "PK_vehicles_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_vehicles_vehicle_number" UNIQUE ("vehicle_number")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "drivers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "name" character varying NOT NULL,
        "phone" character varying NOT NULL,
        "license" character varying,
        "is_active" boolean NOT NULL DEFAULT true,
        "notes" character varying,
        CONSTRAINT "PK_drivers_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_drivers_phone" UNIQUE ("phone")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "drivers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "vehicles"`);
  }
}
