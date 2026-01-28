// Database connection - will be configured when PostgreSQL is set up
// For now, using mock data

// TODO: Uncomment when database is ready
// import { PrismaClient } from '@prisma/client';
//
// const globalForPrisma = globalThis as unknown as {
//   prisma: PrismaClient | undefined;
// };
//
// export const prisma =
//   globalForPrisma.prisma ??
//   new PrismaClient({
//     log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
//   });
//
// if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
//
// export default prisma;

export const prisma = null;
export default prisma;
