
// config/prisma.config.ts
import { PrismaClient, Prisma } from '@prisma/client';

// Prevent multiple instances in development (hot reload issue)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Track active connections for debugging
let activeConnections = 0;

// Create Prisma Client with production-ready configuration
const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
    { level: 'query', emit: 'event' }, // Enable query logging for debugging
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

// Monitor query performance and connection usage
prisma.$on('query' as never, (e: Prisma.QueryEvent) => {
  // Only log slow queries (over 1 second)
  if (e.duration > 1000) {
    console.warn('🐌 Slow Query Detected:', {
      query: e.query.substring(0, 100) + '...',
      duration: `${e.duration}ms`,
      params: e.params,
    });
  }
  
  // Log very slow queries (over 5 seconds) as errors
  if (e.duration > 5000) {
    console.error('🚨 VERY Slow Query:', {
      query: e.query,
      duration: `${e.duration}ms`,
      params: e.params,
    });
  }
});

// Middleware to track connection usage
prisma.$use(async (params, next) => {
  const start = Date.now();
  activeConnections++;
  
  // Log if connections are high
  if (activeConnections > 7) {
    console.warn('⚠️  High connection usage:', {
      active: activeConnections,
      model: params.model,
      action: params.action,
    });
  }

  try {
    const result = await next(params);
    const duration = Date.now() - start;
    
    // Log slow operations
    if (duration > 3000) {
      console.warn('⏱️  Slow operation:', {
        model: params.model,
        action: params.action,
        duration: `${duration}ms`,
      });
    }
    
    return result;
  } catch (error) {
    console.error('❌ Query failed:', {
      model: params.model,
      action: params.action,
      error: error instanceof Error ? error.message : error,
    });
    throw error;
  } finally {
    activeConnections--;
  }
});

// Only cache in development to prevent memory leaks during hot reload
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Connect immediately and handle errors
prisma.$connect()
  .then(() => {
    console.log('✅ Prisma Client connected successfully');
    console.log('📊 Connection pool limit:', process.env.DATABASE_URL?.match(/connection_limit=(\d+)/)?.[1] || 'default');
  })
  .catch((error) => {
    console.error('❌ Failed to connect Prisma Client:', error);
    process.exit(1);
  });

// Periodic connection pool health check
setInterval(() => {
  if (activeConnections > 0) {
    console.log('📊 Connection Pool Status:', {
      active: activeConnections,
      timestamp: new Date().toISOString(),
    });
  }
}, 30000); // Every 30 seconds

// Graceful shutdown handlers
const gracefulShutdown = async (signal: string) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  console.log(`📊 Active connections at shutdown: ${activeConnections}`);
  
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