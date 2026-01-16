"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// config/prisma.config.ts
const client_1 = require("@prisma/client");
// Prevent multiple instances in development (hot reload issue)
const globalForPrisma = globalThis;
// Create Prisma Client with production-ready configuration
const prisma = globalForPrisma.prisma ?? new client_1.PrismaClient({
    log: [
        { level: 'error', emit: 'event' },
        { level: 'warn', emit: 'event' },
    ],
    errorFormat: 'minimal',
});
// Event listeners for debugging connection issues
prisma.$on('error', (e) => {
    console.error('❌ Prisma Error Event:', {
        timestamp: new Date().toISOString(),
        message: e.message,
        target: e.target,
    });
});
prisma.$on('warn', (e) => {
    console.warn('⚠️  Prisma Warning Event:', {
        timestamp: new Date().toISOString(),
        message: e.message,
        target: e.target,
    });
});
// Only cache in development to prevent memory leaks during hot reload
if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}
// Connect immediately and handle errors
prisma.$connect()
    .then(() => {
    console.log('✅ Prisma Client connected successfully');
    const limit = process.env.DATABASE_URL?.match(/connection_limit=(\d+)/)?.[1];
    console.log('📊 Connection pool limit:', limit || 'default');
})
    .catch((error) => {
    console.error('❌ Failed to connect Prisma Client:', error);
    process.exit(1);
});
// Graceful shutdown handlers
const gracefulShutdown = async (signal) => {
    console.log(`\n${signal} received. Starting graceful shutdown...`);
    try {
        await prisma.$disconnect();
        console.log('✅ Prisma Client disconnected successfully');
        process.exit(0);
    }
    catch (error) {
        console.error('❌ Error during Prisma shutdown:', error);
        process.exit(1);
    }
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('beforeExit', async () => {
    await prisma.$disconnect();
});
// Handle uncaught errors
process.on('uncaughtException', async (error) => {
    console.error('❌ Uncaught Exception:', error);
    await prisma.$disconnect();
    process.exit(1);
});
process.on('unhandledRejection', async (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    await prisma.$disconnect();
    process.exit(1);
});
exports.default = prisma;
