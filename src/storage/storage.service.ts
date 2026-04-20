import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
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
    this.useLocal = !accessKeyId;

    this.s3 = new S3Client({
      region: this.configService.get<string>('aws.region'),
      credentials: {
        accessKeyId: accessKeyId || '',
        secretAccessKey:
          this.configService.get<string>('aws.secretAccessKey') || '',
      },
    });
    this.bucket = this.configService.get<string>('aws.s3Bucket') || '';
    this.localDir = path.join(process.cwd(), 'uploads');

    if (this.useLocal) {
      this.logger.log('Using local filesystem storage (no AWS credentials)');
      fs.mkdirSync(this.localDir, { recursive: true });
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
      return fs.readFileSync(filePath);
    }

    this.logger.log(`Downloading file from S3: ${key}`);
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
  }
}
