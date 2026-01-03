// config/prisma.config.ts
import { PrismaClient, Prisma } from '@prisma/client';

// Prevent multiple instances in development (hot reload issue)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Create Prisma Client with production-ready configuration
const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
  ],
  errorFormat: 'minimal',
});

// Event listeners for debugging connection issues
prisma.$on('error' as never, (e: Prisma.LogEvent) => {
  console.error('❌ Prisma Error Event:', {
    timestamp: new Date().toISOString(),
    message: e.message,
    target: e.target,
  });
});

prisma.$on('warn' as never, (e: Prisma.LogEvent) => {
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
  })
  .catch((error) => {
    console.error('❌ Failed to connect Prisma Client:', error);
    process.exit(1); // Exit if DB connection fails
  });

// Graceful shutdown handlers
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

export default prisma;