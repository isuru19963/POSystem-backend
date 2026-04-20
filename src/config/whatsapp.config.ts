import { registerAs } from '@nestjs/config';

export default registerAs('whatsapp', () => ({
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  from: process.env.TWILIO_WHATSAPP_FROM,
  groupId: process.env.WHATSAPP_GROUP_ID,
}));
