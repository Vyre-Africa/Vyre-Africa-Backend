import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
});


const prisma = globalForPrisma.prisma ?? new PrismaClient({
    adapter,
    log: [
        { level: 'error', emit: 'event' },
        { level: 'warn', emit: 'event' },
    ],
    errorFormat: 'minimal'
});
// const prisma = globalForPrisma.prisma ?? new (PrismaClient as any)({
//     adapter,
//     log: [
//         { level: 'error', emit: 'event' },
//         { level: 'warn', emit: 'event' },
//     ],
//     errorFormat: 'minimal'
// });

prisma.$on('error' as never, (e: Prisma.LogEvent) => {
    console.error('❌ Prisma Error Event:', {
        timestamp: new Date().toISOString(),
        message:   e.message,
        target:    e.target,
    });
});

prisma.$on('warn' as never, (e: Prisma.LogEvent) => {
    console.warn('⚠️ Prisma Warning Event:', {
        timestamp: new Date().toISOString(),
        message:   e.message,
        target:    e.target,
    });
});

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

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

const gracefulShutdown = async (signal: string) => {
    console.log(`\n${signal} received. Starting graceful shutdown...`);
    try {
        await prisma.$disconnect();
        console.log('✅ Prisma Client disconnected successfully');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during Prisma shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('beforeExit', async () => { await prisma.$disconnect(); });

process.on('uncaughtException', async (error) => {
    console.error('❌ Uncaught Exception:', error);
    await prisma.$disconnect();
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    // await prisma.$disconnect();
    // process.exit(1);
});

export default prisma;