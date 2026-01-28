// Cache Service - Manages search result caching with 1-month TTL
import { prisma } from '@/lib/db';
import { cacheDuration } from '@/lib/config/env';
import {
  CacheEntry,
  CacheLookupResult,
  CacheKey,
  CachedAnalysisResult,
  CacheStatus,
  generateCacheKey,
} from '@/types/scraping';

export class CacheService {
  /**
   * Look up a cache entry by search parameters
   */
  async lookup(params: CacheKey): Promise<CacheLookupResult> {
    const cacheKey = generateCacheKey(params);

    try {
      const entry = await prisma.searchCache.findUnique({
        where: { cacheKey },
        include: {
          restaurants: true,
        },
      });

      if (!entry) {
        return { found: false, status: 'miss' };
      }

      // Check if expired
      if (cacheDuration.isExpired(entry.expiresAt)) {
        // Mark as stale for background refresh
        await this.updateStatus(entry.id, 'stale');
        return {
          found: true,
          entry: this.toEntryObject(entry),
          status: 'expired',
        };
      }

      // Check if stale (within grace period)
      if (cacheDuration.isStale(entry.expiresAt)) {
        return {
          found: true,
          entry: this.toEntryObject(entry),
          status: 'stale',
        };
      }

      // Fresh cache hit - update access time and hit count
      await this.recordHit(entry.id);

      return {
        found: true,
        entry: this.toEntryObject(entry),
        status: 'hit',
      };
    } catch (error) {
      console.error('[CacheService] Lookup error:', error);
      return { found: false, status: 'miss' };
    }
  }

  /**
   * Store search results in cache
   */
  async store(
    params: CacheKey,
    results: CachedAnalysisResult[],
    aiMessage: string,
    restaurantIds: string[]
  ): Promise<CacheEntry | null> {
    const cacheKey = generateCacheKey(params);

    try {
      // Check if entry exists
      const existing = await prisma.searchCache.findUnique({
        where: { cacheKey },
      });

      if (existing) {
        // Update existing entry
        const updated = await prisma.searchCache.update({
          where: { cacheKey },
          data: {
            analysisResults: results as unknown as object,
            aiMessage,
            status: 'fresh',
            expiresAt: cacheDuration.getExpiryDate(),
            restaurants: {
              set: restaurantIds.map((id) => ({ id })),
            },
          },
          include: {
            restaurants: true,
          },
        });
        return this.toEntryObject(updated);
      }

      // Create new entry
      const created = await prisma.searchCache.create({
        data: {
          cacheKey,
          foodQuery: params.foodQuery,
          latitude: params.latitude,
          longitude: params.longitude,
          radiusKm: params.radiusKm,
          analysisResults: results as unknown as object,
          aiMessage,
          status: 'fresh',
          expiresAt: cacheDuration.getExpiryDate(),
          restaurants: {
            connect: restaurantIds.map((id) => ({ id })),
          },
        },
        include: {
          restaurants: true,
        },
      });

      return this.toEntryObject(created);
    } catch (error) {
      console.error('[CacheService] Store error:', error);
      return null;
    }
  }

  /**
   * Update cache entry status
   */
  async updateStatus(id: string, status: CacheStatus): Promise<void> {
    try {
      await prisma.searchCache.update({
        where: { id },
        data: { status },
      });
    } catch (error) {
      console.error('[CacheService] Status update error:', error);
    }
  }

  /**
   * Record a cache hit (update access time and hit count)
   */
  private async recordHit(id: string): Promise<void> {
    try {
      await prisma.searchCache.update({
        where: { id },
        data: {
          lastAccessedAt: new Date(),
          hitCount: { increment: 1 },
        },
      });
    } catch (error) {
      console.error('[CacheService] Hit record error:', error);
    }
  }

  /**
   * Get all stale cache entries that need refresh
   */
  async getStaleEntries(limit: number = 10): Promise<CacheEntry[]> {
    try {
      const entries = await prisma.searchCache.findMany({
        where: {
          status: 'stale',
        },
        orderBy: {
          lastAccessedAt: 'desc', // Prioritize frequently accessed
        },
        take: limit,
        include: {
          restaurants: true,
        },
      });

      return entries.map(this.toEntryObject);
    } catch (error) {
      console.error('[CacheService] Get stale entries error:', error);
      return [];
    }
  }

  /**
   * Get expired cache entries for cleanup
   */
  async getExpiredEntries(limit: number = 100): Promise<CacheEntry[]> {
    try {
      const entries = await prisma.searchCache.findMany({
        where: {
          expiresAt: { lt: new Date() },
        },
        orderBy: {
          expiresAt: 'asc',
        },
        take: limit,
        include: {
          restaurants: true,
        },
      });

      return entries.map(this.toEntryObject);
    } catch (error) {
      console.error('[CacheService] Get expired entries error:', error);
      return [];
    }
  }

  /**
   * Delete a cache entry
   */
  async delete(id: string): Promise<void> {
    try {
      await prisma.searchCache.delete({
        where: { id },
      });
    } catch (error) {
      console.error('[CacheService] Delete error:', error);
    }
  }

  /**
   * Delete expired entries (cleanup job)
   */
  async cleanupExpired(): Promise<number> {
    try {
      const result = await prisma.searchCache.deleteMany({
        where: {
          expiresAt: { lt: new Date() },
          // Only delete if expired and not recently accessed
          lastAccessedAt: {
            lt: new Date(Date.now() - cacheDuration.staleGraceMs),
          },
        },
      });
      return result.count;
    } catch (error) {
      console.error('[CacheService] Cleanup error:', error);
      return 0;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    try {
      const [total, fresh, stale, refreshing, failed] = await Promise.all([
        prisma.searchCache.count(),
        prisma.searchCache.count({ where: { status: 'fresh' } }),
        prisma.searchCache.count({ where: { status: 'stale' } }),
        prisma.searchCache.count({ where: { status: 'refreshing' } }),
        prisma.searchCache.count({ where: { status: 'failed' } }),
      ]);

      const avgHitCount = await prisma.searchCache.aggregate({
        _avg: { hitCount: true },
      });

      return {
        total,
        byStatus: { fresh, stale, refreshing, failed },
        averageHitCount: avgHitCount._avg.hitCount || 0,
      };
    } catch (error) {
      console.error('[CacheService] Stats error:', error);
      return null;
    }
  }

  /**
   * Invalidate cache entries by food query
   */
  async invalidateByQuery(foodQuery: string): Promise<number> {
    try {
      const result = await prisma.searchCache.updateMany({
        where: {
          foodQuery: {
            equals: foodQuery.toLowerCase(),
            mode: 'insensitive',
          },
        },
        data: {
          status: 'stale',
        },
      });
      return result.count;
    } catch (error) {
      console.error('[CacheService] Invalidate error:', error);
      return 0;
    }
  }

  /**
   * Convert Prisma object to CacheEntry interface
   */
  private toEntryObject(entry: {
    id: string;
    cacheKey: string;
    status: string;
    foodQuery: string;
    latitude: unknown;
    longitude: unknown;
    radiusKm: number;
    analysisResults: unknown;
    aiMessage: string | null;
    expiresAt: Date;
    hitCount: number;
    createdAt: Date;
    lastAccessedAt: Date;
  }): CacheEntry {
    return {
      id: entry.id,
      cacheKey: entry.cacheKey,
      status: entry.status as CacheStatus,
      foodQuery: entry.foodQuery,
      latitude: Number(entry.latitude),
      longitude: Number(entry.longitude),
      radiusKm: entry.radiusKm,
      analysisResults: entry.analysisResults as CachedAnalysisResult[],
      aiMessage: entry.aiMessage || undefined,
      expiresAt: entry.expiresAt,
      hitCount: entry.hitCount,
      createdAt: entry.createdAt,
      lastAccessedAt: entry.lastAccessedAt,
    };
  }
}

export const cacheService = new CacheService();
export default cacheService;
