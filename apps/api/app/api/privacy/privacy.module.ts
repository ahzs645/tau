import { Module } from '@nestjs/common';
import { PrivacyController } from '#api/privacy/privacy.controller.js';
import { PrivacyService } from '#api/privacy/privacy.service.js';
import { DatabaseModule } from '#database/database.module.js';

@Module({
  imports: [DatabaseModule],
  controllers: [PrivacyController],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}
