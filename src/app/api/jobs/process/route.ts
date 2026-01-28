// Background Jobs Processing Endpoint
// This endpoint should be called by a cron job (e.g., every 5 minutes)
import { NextRequest, NextResponse } from 'next/server';
import { backgroundJobService } from '@/lib/jobs/background-job-service';
import { cacheService } from '@/lib/cache/cache-service';

// Simple API key authentication for cron jobs
const CRON_SECRET = process.env.CRON_SECRET || 'development-secret';

export async function POST(request: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const action = body.action || 'process';
    const limit = body.limit || 5;

    let result: Record<string, unknown> = {};

    switch (action) {
      case 'process':
        // Process pending jobs
        result = await backgroundJobService.processAllPending(limit);
        break;

      case 'schedule-stale-refresh':
        // Schedule refresh for stale cache entries
        const staleEntries = await cacheService.getStaleEntries(limit);
        let scheduled = 0;
        for (const entry of staleEntries) {
          const job = await backgroundJobService.scheduleRefresh(entry.id, 1);
          if (job) scheduled++;
        }
        result = { scheduled, total: staleEntries.length };
        break;

      case 'cleanup':
        // Cleanup expired caches and old jobs
        const [expiredCaches, oldJobs] = await Promise.all([
          cacheService.cleanupExpired(),
          backgroundJobService.cleanupOldJobs(7),
        ]);
        result = { expiredCaches, oldJobs };
        break;

      case 'stats':
        // Get statistics
        const [jobStats, cacheStats] = await Promise.all([
          backgroundJobService.getStats(),
          cacheService.getStats(),
        ]);
        result = { jobs: jobStats, cache: cacheStats };
        break;

      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }

    return NextResponse.json({
      success: true,
      action,
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Jobs API] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

// GET endpoint for health check
export async function GET(request: NextRequest) {
  // Allow health check without auth
  const url = new URL(request.url);
  if (url.searchParams.get('health') === 'true') {
    const stats = await backgroundJobService.getStats();
    return NextResponse.json({
      success: true,
      healthy: true,
      stats,
      timestamp: new Date().toISOString(),
    });
  }

  return NextResponse.json(
    { success: false, error: 'Use POST for job operations' },
    { status: 405 }
  );
}
