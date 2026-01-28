// Background Job Service - Manages async jobs for cache refresh and scraping
import { prisma } from '@/lib/db';
import { cacheService } from '@/lib/cache/cache-service';
import { googleMapsScraper } from '@/lib/scraping/google-maps-scraper';
import { JobType, JobStatus, BackgroundJobData } from '@/types/scraping';

export class BackgroundJobService {
  /**
   * Create a new background job
   */
  async createJob(
    type: JobType,
    payload: Record<string, unknown>,
    priority: number = 0,
    scheduledAt: Date = new Date()
  ): Promise<BackgroundJobData | null> {
    try {
      const job = await prisma.backgroundJob.create({
        data: {
          type,
          payload: JSON.parse(JSON.stringify({ type, data: payload })),
          priority,
          scheduledAt,
        },
      });
      return this.toJobObject(job);
    } catch (error) {
      console.error('[JobService] Create job error:', error);
      return null;
    }
  }

  /**
   * Schedule a cache refresh job
   */
  async scheduleRefresh(cacheId: string, priority: number = 0): Promise<BackgroundJobData | null> {
    // Check if a refresh job already exists for this cache
    const existing = await prisma.backgroundJob.findFirst({
      where: {
        type: 'refresh_cache',
        status: { in: ['pending', 'running'] },
        payload: {
          path: ['data', 'cacheId'],
          equals: cacheId,
        },
      },
    });

    if (existing) {
      console.log(`[JobService] Refresh job already exists for cache ${cacheId}`);
      return this.toJobObject(existing);
    }

    return this.createJob('refresh_cache', { cacheId }, priority);
  }

  /**
   * Schedule a scrape job for a restaurant
   */
  async scheduleScrape(
    placeId: string,
    googleMapsUrl: string,
    foodKeyword: string,
    priority: number = 0
  ): Promise<BackgroundJobData | null> {
    // Check if a scrape job already exists for this place+keyword
    const existing = await prisma.backgroundJob.findFirst({
      where: {
        type: 'scrape_restaurant',
        status: { in: ['pending', 'running'] },
        payload: {
          path: ['data', 'placeId'],
          equals: placeId,
        },
      },
    });

    if (existing) {
      console.log(`[JobService] Scrape job already exists for place ${placeId}`);
      return this.toJobObject(existing);
    }

    return this.createJob(
      'scrape_restaurant',
      { placeId, googleMapsUrl, foodKeyword },
      priority
    );
  }

  /**
   * Get pending jobs to process
   */
  async getPendingJobs(limit: number = 5): Promise<BackgroundJobData[]> {
    try {
      const jobs = await prisma.backgroundJob.findMany({
        where: {
          status: 'pending',
          scheduledAt: { lte: new Date() },
        },
        orderBy: [
          { priority: 'desc' },
          { scheduledAt: 'asc' },
        ],
        take: limit,
      });
      return jobs.map(this.toJobObject);
    } catch (error) {
      console.error('[JobService] Get pending jobs error:', error);
      return [];
    }
  }

  /**
   * Process a single job
   */
  async processJob(jobId: string): Promise<boolean> {
    const job = await prisma.backgroundJob.findUnique({
      where: { id: jobId },
    });

    if (!job || job.status !== 'pending') {
      return false;
    }

    // Mark as running
    await this.updateStatus(jobId, 'running');

    try {
      const payload = job.payload as { type: JobType; data: Record<string, unknown> };

      switch (payload.type) {
        case 'refresh_cache':
          await this.processRefreshCache(payload.data);
          break;
        case 'scrape_restaurant':
          await this.processScrapeRestaurant(payload.data);
          break;
        case 'cleanup_expired':
          await this.processCleanup();
          break;
        default:
          throw new Error(`Unknown job type: ${payload.type}`);
      }

      // Mark as completed
      await prisma.backgroundJob.update({
        where: { id: jobId },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });

      return true;
    } catch (error) {
      console.error(`[JobService] Job ${jobId} failed:`, error);

      // Update attempt count and potentially retry
      const updated = await prisma.backgroundJob.update({
        where: { id: jobId },
        data: {
          attempts: { increment: 1 },
          lastError: error instanceof Error ? error.message : 'Unknown error',
        },
      });

      if (updated.attempts >= updated.maxAttempts) {
        await this.updateStatus(jobId, 'failed');
      } else {
        // Reset to pending for retry
        await this.updateStatus(jobId, 'pending');
      }

      return false;
    }
  }

  /**
   * Process cache refresh job
   */
  private async processRefreshCache(data: Record<string, unknown>): Promise<void> {
    const cacheId = data.cacheId as string;
    const entry = await prisma.searchCache.findUnique({
      where: { id: cacheId },
      include: { restaurants: true },
    });

    if (!entry) {
      throw new Error(`Cache entry not found: ${cacheId}`);
    }

    // Mark as refreshing
    await cacheService.updateStatus(cacheId, 'refreshing');

    // Re-scrape all restaurants for this query
    for (const restaurant of entry.restaurants) {
      if (restaurant.googleMapsUrl) {
        await googleMapsScraper.scrapeAndSave(
          restaurant.googleMapsUrl,
          restaurant.googlePlaceId,
          { foodKeyword: entry.foodQuery }
        );
      }
    }

    // Mark as fresh with new expiry
    await prisma.searchCache.update({
      where: { id: cacheId },
      data: {
        status: 'fresh',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      },
    });
  }

  /**
   * Process restaurant scrape job
   */
  private async processScrapeRestaurant(data: Record<string, unknown>): Promise<void> {
    const { placeId, googleMapsUrl, foodKeyword } = data as {
      placeId: string;
      googleMapsUrl: string;
      foodKeyword: string;
    };

    await googleMapsScraper.scrapeAndSave(googleMapsUrl, placeId, { foodKeyword });
  }

  /**
   * Process cleanup job
   */
  private async processCleanup(): Promise<void> {
    const deleted = await cacheService.cleanupExpired();
    console.log(`[JobService] Cleaned up ${deleted} expired cache entries`);
  }

  /**
   * Update job status
   */
  private async updateStatus(jobId: string, status: JobStatus): Promise<void> {
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: {
        status,
        startedAt: status === 'running' ? new Date() : undefined,
      },
    });
  }

  /**
   * Process all pending jobs
   */
  async processAllPending(limit: number = 5): Promise<{ processed: number; failed: number }> {
    const jobs = await this.getPendingJobs(limit);
    let processed = 0;
    let failed = 0;

    for (const job of jobs) {
      const success = await this.processJob(job.id);
      if (success) {
        processed++;
      } else {
        failed++;
      }
    }

    return { processed, failed };
  }

  /**
   * Get job statistics
   */
  async getStats() {
    try {
      const [total, pending, running, completed, failed] = await Promise.all([
        prisma.backgroundJob.count(),
        prisma.backgroundJob.count({ where: { status: 'pending' } }),
        prisma.backgroundJob.count({ where: { status: 'running' } }),
        prisma.backgroundJob.count({ where: { status: 'completed' } }),
        prisma.backgroundJob.count({ where: { status: 'failed' } }),
      ]);

      return { total, pending, running, completed, failed };
    } catch (error) {
      console.error('[JobService] Stats error:', error);
      return null;
    }
  }

  /**
   * Clean up old completed/failed jobs
   */
  async cleanupOldJobs(olderThanDays: number = 7): Promise<number> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - olderThanDays);

    try {
      const result = await prisma.backgroundJob.deleteMany({
        where: {
          status: { in: ['completed', 'failed'] },
          completedAt: { lt: threshold },
        },
      });
      return result.count;
    } catch (error) {
      console.error('[JobService] Cleanup old jobs error:', error);
      return 0;
    }
  }

  /**
   * Convert Prisma object to BackgroundJobData
   */
  private toJobObject(job: {
    id: string;
    type: string;
    payload: unknown;
    status: string;
    priority: number;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
    scheduledAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
  }): BackgroundJobData {
    return {
      id: job.id,
      type: job.type as JobType,
      payload: job.payload as { type: JobType; data: Record<string, unknown> },
      status: job.status as JobStatus,
      priority: job.priority,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      lastError: job.lastError || undefined,
      scheduledAt: job.scheduledAt,
      startedAt: job.startedAt || undefined,
      completedAt: job.completedAt || undefined,
    };
  }
}

export const backgroundJobService = new BackgroundJobService();
export default backgroundJobService;
