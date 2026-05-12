import { Controller, Get } from '@nestjs/common';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../../package.json') as { version: string };

/**
 * Unauthenticated deployment probe. Use to confirm which API build is live
 * (e.g. compare `version` after `eb deploy`).
 */
@Controller('meta')
export class MetaController {
  @Get('deployment')
  deployment(): {
    service: string;
    version: string;
    node: string;
    poCustomerRepairFromSource: boolean;
  } {
    return {
      service: 'posystem-backend',
      version: pkg.version,
      node: process.version,
      poCustomerRepairFromSource: true,
    };
  }
}
