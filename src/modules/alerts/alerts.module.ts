import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Alert } from '../../database/entities';
import { AlertsService } from './services/alerts.service';
import { WhatsappModule } from '../../whatsapp/whatsapp.module';
import { EmailModule } from '../../email/email.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Alert]),
    WhatsappModule,
    EmailModule,
  ],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
