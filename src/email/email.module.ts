import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { ImapService } from './imap.service';

@Module({
  providers: [EmailService, ImapService],
  exports: [EmailService, ImapService],
})
export class EmailModule {}
