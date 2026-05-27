import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly useLocal: boolean;
  private readonly localDir: string;

  constructor(private readonly configService: ConfigService) {
    const accessKeyId = this.configService.get<string>('aws.accessKeyId');
    const secretAccessKey =
      this.configService.get<string>('aws.secretAccessKey');
    const nodeEnv = process.env.NODE_ENV || 'development';
    const explicitLocal =
      process.env.USE_LOCAL_FILE_STORAGE === 'true' ||
      process.env.USE_LOCAL_FILE_STORAGE === '1';

    // Production must use S3 (EB has no persistent local disk). Dev without
    // credentials uses ./uploads unless USE_LOCAL_FILE_STORAGE is forced off.
    this.useLocal =
      explicitLocal ||
      (nodeEnv !== 'production' && !accessKeyId && !secretAccessKey);

    const region = this.configService.get<string>('aws.region');
    const clientConfig: ConstructorParameters<typeof S3Client>[0] = { region };
    if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = { accessKeyId, secretAccessKey };
    }
    this.s3 = new S3Client(clientConfig);

    this.bucket = this.configService.get<string>('aws.s3Bucket') || '';
    this.localDir = path.join(process.cwd(), 'uploads');

    if (this.useLocal) {
      this.logger.log('Using local filesystem storage (./uploads)');
      fs.mkdirSync(this.localDir, { recursive: true });
    } else {
      this.logger.log(
        `Using S3 storage (bucket=${this.bucket || '[unset]'}, region=${region})`,
      );
    }
  }

  async uploadFile(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<string> {
    if (this.useLocal) {
      const filePath = path.join(this.localDir, key);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body);
      this.logger.log(`Saved file locally: ${filePath}`);
      return key;
    }

    if (!this.bucket) {
      throw new Error('AWS_S3_BUCKET is not configured');
    }

    this.logger.log(`Uploading file to S3: ${key}`);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return key;
  }

  async getFile(key: string): Promise<Buffer> {
    if (this.useLocal) {
      const filePath = path.join(this.localDir, key);
      this.logger.log(`Reading local file: ${filePath}`);
      try {
        return fs.readFileSync(filePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          throw new NotFoundException(
            `Stored file not found on server (${key}). Re-import the PO from email if needed.`,
          );
        }
        throw err;
      }
    }

    if (!this.bucket) {
      throw new Error('AWS_S3_BUCKET is not configured');
    }

    this.logger.log(`Downloading file from S3: ${key}`);
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      const stream = response.Body as Readable;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (
        err instanceof NoSuchKey ||
        (err as { name?: string })?.name === 'NoSuchKey'
      ) {
        throw new NotFoundException(
          `Stored file not found in S3 (${key}). Re-fetch the PO from email to restore the attachment.`,
        );
      }
      throw err;
    }
  }

  /**
   * Generate a temporary, publicly accessible HTTPS URL for an S3 object.
   * Used by Twilio WhatsApp media — Twilio needs an unauthenticated URL it
   * can fetch within the link's lifetime. Returns null in local-storage mode.
   */
  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string | null> {
    if (this.useLocal || !this.bucket) {
      this.logger.warn(
        `getSignedUrl skipped — local storage or missing bucket (key=${key})`,
      );
      return null;
    }
    try {
      return await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to sign S3 URL for ${key}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
}
