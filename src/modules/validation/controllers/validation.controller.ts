import { Controller, Post, Param, ParseUUIDPipe } from '@nestjs/common';
import { ValidationService } from '../services/validation.service';

@Controller('validation')
export class ValidationController {
  constructor(private readonly validationService: ValidationService) {}

  @Post('po/:id')
  validatePo(@Param('id', ParseUUIDPipe) id: string) {
    return this.validationService.validatePo(id);
  }
}
