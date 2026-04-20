import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseUUIDPipe,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PoService } from '../services/po.service';
import { PdfExtractionService } from '../services/pdf-extraction.service';
import { XlsExtractionService } from '../services/xls-extraction.service';
import { QueryPoDto } from '../dto/query-po.dto';
import { QUEUE_NAMES } from '../../../common/constants/app.constants';

@Controller('po')
export class PoController {
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

  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.poService.findById(id);
  }

  @Post('reprocess-all')
  async reprocessAll() {
    await this.poProcessingQueue.add('reprocess-all', {}, {
      removeOnComplete: true,
      removeOnFail: 5,
    });
    return { message: 'Reprocess-all job queued' };
  }

  /** Extract data from an uploaded PO file (PDF or XLS) without saving */
  @Post('extract')
  @UseInterceptors(FileInterceptor('file'))
  async extractFromFile(
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');

    const filename = file.originalname.toLowerCase();
    if (filename.endsWith('.xls') || filename.endsWith('.xlsx') || filename.endsWith('.csv')) {
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
  async uploadAndCreate(
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');

    const filename = file.originalname.toLowerCase();
    let extracted;

    if (filename.endsWith('.xls') || filename.endsWith('.xlsx') || filename.endsWith('.csv')) {
      extracted = await this.xlsExtractionService.extract(file.buffer, file.originalname);
    } else if (filename.endsWith('.pdf')) {
      extracted = await this.pdfExtractionService.extract(file.buffer);
    } else {
      throw new BadRequestException(
        'Unsupported file type. Upload a PDF or XLS file.',
      );
    }

    const parseDate = (dateStr?: string): Date | undefined => {
      if (!dateStr) return undefined;
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? undefined : d;
    };

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
}
