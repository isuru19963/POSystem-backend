import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Query,
  ParseUUIDPipe,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsUUID } from 'class-validator';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PoService } from '../services/po.service';
import { PdfExtractionService } from '../services/pdf-extraction.service';
import { XlsExtractionService } from '../services/xls-extraction.service';
import { QueryPoDto } from '../dto/query-po.dto';
import {
  JOB_NAMES,
  QUEUE_NAMES,
} from '../../../common/constants/app.constants';
import {
  enqueueManualInboxFetch,
  getInboxJobStatus,
} from '../../../queue/inbox-monitor.helpers';

/**
 * Parse a date string that may be in dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy or ISO formats.
 * Returns undefined when the string is empty or unparseable.
 */
function parsePoDate(dateStr?: string): Date | undefined {
  if (!dateStr) return undefined;

  const raw = String(dateStr).trim();
  if (!raw || /^0+$/.test(raw)) return undefined;

  // Unix timestamp support (seconds or milliseconds).
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    const ms = raw.length === 10 ? n * 1000 : n;
    const tsDate = new Date(ms);
    if (!isNaN(tsDate.getTime()) && tsDate.getUTCFullYear() >= 2000) {
      return tsDate;
    }
    return undefined;
  }

  // dd/mm/yyyy  dd-mm-yyyy  dd.mm.yyyy
  const dmy = raw.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const date = new Date(iso);
    if (!isNaN(date.getTime()) && date.getUTCFullYear() >= 2000) {
      return date;
    }
    return undefined;
  }

  // Normalize meridiem variations like "p.m." -> "pm".
  const normalized = raw.replace(/\b([ap])\.?m\.?\b/gi, '$1m');

  // yyyy-mm-dd or any other natively parseable format
  const date = new Date(normalized);
  if (isNaN(date.getTime()) || date.getUTCFullYear() < 2000) return undefined;
  return date;
}

class MapLineItemSkuDto {
  @IsUUID()
  skuId!: string;
}

@Controller('po')
export class PoController {
  private readonly logger = new Logger(PoController.name);

  constructor(
    private readonly poService: PoService,
    private readonly pdfExtractionService: PdfExtractionService,
    private readonly xlsExtractionService: XlsExtractionService,
    @InjectQueue(QUEUE_NAMES.PO_PROCESSING)
    private readonly poProcessingQueue: Queue,
  ) {}

  @Get()
  findAll(@Query() query: QueryPoDto) {
    return this.poService.findAll(query);
  }

  /**
   * Distinct vendor item codes seen on PO line items that have not been
   * matched to an SKU in our catalogue. Drives the admin "missing SKU"
   * worklist on the PO list page.
   */
  @Get('unmapped-items')
  listUnmappedItemCodes() {
    return this.poService.listUnmappedItemCodes();
  }

  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.poService.findById(id);
  }

  /**
   * Stream the original PO PDF or spreadsheet from S3/local storage.
   * Use disposition=inline to open in the browser, attachment to download.
   */
  /**
   * Re-download PDF/XLS from the mailbox for POs missing files on S3.
   * Uses the stored email Message-ID; does not create a duplicate PO.
   */
  @Post(':id/restore-source-from-email')
  @HttpCode(HttpStatus.OK)
  restoreSourceFromEmail(@Param('id', ParseUUIDPipe) id: string) {
    return this.poService.restoreSourceFilesFromEmail(id);
  }

  @Get(':id/source-file')
  async getSourceFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('kind') kind: 'pdf' | 'xls' | undefined,
    @Query('disposition') disposition: 'inline' | 'attachment' | undefined,
    @Res() res: Response,
  ) {
    const { buffer, fileName, contentType } = await this.poService.getSourceFile(
      id,
      kind,
    );
    const disp =
      disposition === 'attachment' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `${disp}; filename="${fileName.replace(/"/g, '')}"`,
    );
    res.send(buffer);
  }

  /**
   * Map one PO line item to an SKU in our master catalogue. Once every line
   * item on the PO is mapped, the PO is auto-promoted out of
   * NEEDS_SKU_MAPPING and re-validated.
   */
  @Patch(':poId/line-items/:lineItemId/sku')
  mapLineItemSku(
    @Param('poId', ParseUUIDPipe) poId: string,
    @Param('lineItemId', ParseUUIDPipe) lineItemId: string,
    @Body() dto: MapLineItemSkuDto,
  ) {
    return this.poService.mapLineItemSku(poId, lineItemId, dto.skuId);
  }

  /**
   * Re-run SKU resolution against the current catalogue for every unmapped
   * line item on a PO. Useful after admins add a missing SKU.
   */
  @Post(':poId/rematch-skus')
  @HttpCode(HttpStatus.OK)
  rematchSkus(@Param('poId', ParseUUIDPipe) poId: string) {
    return this.poService.rematchSkus(poId);
  }

  /** Re-match every unmapped line item on all POs (after catalogue / matcher updates). */
  @Post('rematch-all-skus')
  @HttpCode(HttpStatus.OK)
  rematchAllSkus() {
    return this.poService.rematchAllUnmappedSkus();
  }

  /** Flush all PO and PO-linked records (testing use only). */
  @Post('flush-testing')
  @HttpCode(HttpStatus.OK)
  flushTestingData() {
    return this.poService.flushTestingData();
  }

  /** Delete PO (testing use only). Fails if PO is linked to dispatch/GRN records. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  removeById(@Param('id', ParseUUIDPipe) id: string) {
    return this.poService.removeById(id);
  }

  @Post('reprocess-all')
  async reprocessAll() {
    await this.poProcessingQueue.add(
      'reprocess-all',
      {},
      {
        removeOnComplete: true,
        removeOnFail: 5,
      },
    );
    return { message: 'Reprocess-all job queued' };
  }

  /** Extract data from an uploaded PO file (PDF or XLS) without saving */
  @Post('extract')
  @UseInterceptors(FileInterceptor('file'))
  async extractFromFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');

    const filename = file.originalname.toLowerCase();
    if (
      filename.endsWith('.xls') ||
      filename.endsWith('.xlsx') ||
      filename.endsWith('.csv')
    ) {
      return this.xlsExtractionService.extract(file.buffer, file.originalname);
    } else if (filename.endsWith('.pdf')) {
      return this.pdfExtractionService.extract(file.buffer);
    } else {
      throw new BadRequestException(
        'Unsupported file type. Upload a PDF, XLS, or CSV file.',
      );
    }
  }

  /** Upload a PO file and create a PO record from it */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAndCreate(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');

    const filename = file.originalname.toLowerCase();
    let extracted;

    if (
      filename.endsWith('.xls') ||
      filename.endsWith('.xlsx') ||
      filename.endsWith('.csv')
    ) {
      extracted = await this.xlsExtractionService.extract(
        file.buffer,
        file.originalname,
      );
    } else if (filename.endsWith('.pdf')) {
      extracted = await this.pdfExtractionService.extract(file.buffer);
    } else {
      throw new BadRequestException(
        'Unsupported file type. Upload a PDF or XLS file.',
      );
    }

    const parseDate = parsePoDate;

    return this.poService.createFromEmail({
      poNumber: extracted.poNumber,
      poDate: parseDate(extracted.poDate) || new Date(),
      vendorName: extracted.vendorName,
      shippingLocation: extracted.shippingLocation || '',
      emailMessageId: `upload-${Date.now()}`,
      expectedDeliveryDate: parseDate(extracted.expectedDeliveryDate),
      expiryDate: parseDate(extracted.expiryDate),
      paymentTerms: extracted.paymentTerms,
      totalAmount: extracted.grandTotal,
      lineItems: extracted.lineItems,
      extractedData: extracted as unknown as Record<string, unknown>,
    });
  }

  /**
   * Enqueue a PO-only inbox job (separate from GRN manual fetch and from the
   * cron). Scans the entire INBOX (read + unread) so any PO mail that exists
   * lands in the DB; the Message-ID dedup makes repeat clicks idempotent.
   * Poll `GET /po/fetch-from-email/status/:jobId` for the summary.
   */
  @Post('fetch-from-email')
  async fetchFromEmail() {
    const { jobId, alreadyPending } = await enqueueManualInboxFetch(
      this.poProcessingQueue,
      JOB_NAMES.MONITOR_INBOX_PO,
      this.logger,
    );
    this.logger.log(
      alreadyPending
        ? `Reusing in-flight PO inbox job ${jobId}`
        : `Queued PO inbox job ${jobId}`,
    );
    return {
      jobId,
      status: alreadyPending ? 'in-progress' : 'queued',
    };
  }

  /** Poll the status of a previously-queued inbox monitor job. */
  @Get('fetch-from-email/status/:jobId')
  async fetchFromEmailStatus(@Param('jobId') jobId: string) {
    const status = await getInboxJobStatus(this.poProcessingQueue, jobId);
    if (!status) {
      throw new NotFoundException(
        `Job ${jobId} not found — it may have completed and been cleaned up.`,
      );
    }
    return status;
  }
}
