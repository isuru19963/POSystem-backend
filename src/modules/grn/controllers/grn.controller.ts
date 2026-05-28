import {
  Controller, Get, Post, Patch, Body, Param, ParseUUIDPipe, Query,
  UseInterceptors, UploadedFile, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { GrnService } from '../services/grn.service';
import { CreateGrnDto } from '../dto/create-grn.dto';
import { CreateGrnManualDto } from '../dto/create-grn-manual.dto';
import { UpdateGrnStatusDto } from '../dto/update-grn-status.dto';
import { UpdateGrnNotesDto } from '../dto/update-grn-notes.dto';
import {
  JOB_NAMES,
  QUEUE_NAMES,
} from '../../../common/constants/app.constants';
import {
  enqueueManualInboxFetch,
  getInboxJobStatus,
} from '../../../queue/inbox-monitor.helpers';

@Controller('grn')
export class GrnController {
  private readonly logger = new Logger(GrnController.name);

  constructor(
    private readonly grnService: GrnService,
    @InjectQueue(QUEUE_NAMES.PO_PROCESSING)
    private readonly poProcessingQueue: Queue,
  ) {}

  @Post()
  create(@Body() dto: CreateGrnDto) {
    return this.grnService.createGrn(dto);
  }

  @Post('manual')
  createManual(@Body() dto: CreateGrnManualDto) {
    return this.grnService.createGrnManual(dto);
  }

  /**
   * Enqueue a GRN-only inbox job (separate from PO manual fetch). Scans the
   * entire INBOX (read + unread) and only processes GRN-shaped messages;
   * Message-ID dedup keeps repeat runs idempotent. Poll
   * `GET /grn/fetch-from-email/status/:jobId` for the summary.
   */
  @Post('fetch-from-email')
  async fetchFromEmail() {
    const { jobId, alreadyPending } = await enqueueManualInboxFetch(
      this.poProcessingQueue,
      JOB_NAMES.MONITOR_INBOX_GRN,
      this.logger,
    );
    this.logger.log(
      alreadyPending
        ? `Reusing in-flight GRN inbox job ${jobId}`
        : `Queued GRN inbox job ${jobId}`,
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

  /**
   * Upload a GRN PDF and extract its data for preview.
   * Does NOT create a GRN record — use POST /grn/manual to confirm.
   * Multipart field name: "file"
   */
  @Post('extract-pdf')
  @UseInterceptors(FileInterceptor('file'))
  extractPdf(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.originalname.toLowerCase().endsWith('.pdf') && file.mimetype !== 'application/pdf') {
      throw new BadRequestException('Only PDF files are accepted');
    }
    return this.grnService.extractGrnPdf(file.buffer);
  }

  @Get()
  findAll() {
    return this.grnService.findAll();
  }

  @Get('po-comparison')
  compareByPoNumber(@Query('poNumber') poNumber: string) {
    return this.grnService.compareByPoNumber(poNumber);
  }

  /**
   * Backfill: mark PO + deliveries as delivered for every PO that already has a GRN.
   */
  @Post('sync-delivered-from-grns')
  syncDeliveredFromExistingGrns() {
    return this.grnService.backfillDeliveredStatusFromExistingGrns();
  }

  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.grnService.findById(id);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGrnStatusDto,
  ) {
    return this.grnService.updateStatus(id, dto.status);
  }

  @Patch(':id/notes')
  updateNotes(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGrnNotesDto,
  ) {
    return this.grnService.updateNotes(id, dto.notes);
  }

  @Post(':id/match')
  performMatch(@Param('id', ParseUUIDPipe) id: string) {
    return this.grnService.performThreeWayMatch(id);
  }
}
