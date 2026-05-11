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
import { QUEUE_NAMES } from '../../../common/constants/app.constants';
import { enqueueInboxMonitor } from '../../../queue/inbox-monitor.helpers';

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
   * Enqueue an inbox monitor job and return its id immediately. The BullMQ
   * worker picks up both PO and GRN messages off the same IMAP scan, so this
   * endpoint shares the queue with `POST /po/fetch-from-email`. Clients poll
   * `GET /grn/fetch-from-email/status/:jobId` for the final summary.
   *
   * If a monitor-inbox job is already in flight, we return its id instead of
   * stacking a duplicate.
   */
  @Post('fetch-from-email')
  async fetchFromEmail() {
    const { jobId, alreadyPending } = await enqueueInboxMonitor(
      this.poProcessingQueue,
      this.logger,
    );
    this.logger.log(
      alreadyPending
        ? `Reusing in-flight inbox monitor job ${jobId}`
        : `Queued inbox monitor job ${jobId}`,
    );
    return {
      jobId,
      status: alreadyPending ? 'in-progress' : 'queued',
    };
  }

  /** Poll the status of a previously-queued inbox monitor job. */
  @Get('fetch-from-email/status/:jobId')
  async fetchFromEmailStatus(@Param('jobId') jobId: string) {
    const job = await this.poProcessingQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundException(
        `Job ${jobId} not found — it may have completed and been cleaned up.`,
      );
    }
    const state = await job.getState();
    return {
      jobId,
      state,
      result: job.returnvalue ?? null,
      failedReason: job.failedReason ?? null,
      processedOn: job.processedOn ?? null,
      finishedOn: job.finishedOn ?? null,
    };
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
