import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createLogger(serviceName, options = {}) {
  const logDir = options.logDir || path.join(process.cwd(), 'logs');

  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || options.level || 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${service}] ${level.toUpperCase()}: ${message}${metaStr}`;
      })
    ),
    defaultMeta: { service: serviceName },
    transports: [
      // Console transport
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        )
      }),
      // File transport
      new winston.transports.File({
        filename: path.join(logDir, `${serviceName}-error.log`),
        level: 'error'
      }),
      new winston.transports.File({
        filename: path.join(logDir, `${serviceName}.log`)
      })
    ]
  });

  // Handle unhandled rejections
  if (options.handleExceptions !== false) {
    logger.exceptions.handle(
      new winston.transports.File({
        filename: path.join(logDir, `${serviceName}-exceptions.log`)
      })
    );

    logger.rejections.handle(
      new winston.transports.File({
        filename: path.join(logDir, `${serviceName}-rejections.log`)
      })
    );
  }

  return logger;
}

export default createLogger;