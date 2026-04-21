import pino from 'pino';

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger = pino({
  level,
  base: { service: 'nelson-assistant' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-slack-signature"]',
      'req.headers.cookie',
      '*.token',
      '*.idToken',
      '*.refreshToken',
      '*.accessToken',
      '*.password',
      '*.SecretString',
      'req.body.password',
      'req.body.username',
      'body.password',
    ],
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = typeof logger;
