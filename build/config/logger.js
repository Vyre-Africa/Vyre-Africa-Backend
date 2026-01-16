"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const winston_1 = __importDefault(require("winston"));
const env_config_1 = __importDefault(require("../config/env.config"));
// Define log format
const logFormat = winston_1.default.format.printf((info) => {
    return `${info.timestamp} [${info.level}] ${info.message} ${info.stack ? `\n${info.stack}` : ''}`;
});
// Create logger instance
const logger = winston_1.default.createLogger({
    level: env_config_1.default.nodeEnv === 'production' ? 'info' : 'debug',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston_1.default.format.errors({ stack: true }), winston_1.default.format.splat(), logFormat),
    transports: [
        new winston_1.default.transports.Console(),
        new winston_1.default.transports.File({
            filename: 'logs/error.log',
            level: 'error'
        }),
        new winston_1.default.transports.File({
            filename: 'logs/combined.log'
        })
    ],
    exceptionHandlers: [
        new winston_1.default.transports.File({
            filename: 'logs/exceptions.log'
        })
    ]
});
// Handle uncaught promise rejections
process.on('unhandledRejection', (ex) => {
    logger.error('UNHANDLED REJECTION:', ex);
});
exports.default = logger;
