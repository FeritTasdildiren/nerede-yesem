// Proxy Service - Webshare.io proxy list with round-robin rotation
import { prisma } from '@/lib/db';
import { env } from '@/lib/config/env';
import { Proxy, ProxyUsageRecord } from '@/types/scraping';

export class ProxyService {
  private proxies: Proxy[] = [];
  private currentIndex: number = 0;
  private lastFetchTime: number = 0;
  private refreshIntervalMs = 6 * 60 * 60 * 1000; // 6 hours
  private usedProxies: Map<string, Set<string>> = new Map(); // placeId -> Set<proxyAddress>

  /**
   * Get a proxy for scraping a specific place.
   * Uses round-robin rotation and skips proxies already used for this placeId.
   */
  async getProxy(placeId: string): Promise<Proxy | null> {
    await this.ensureProxiesLoaded();

    if (this.proxies.length === 0) {
      console.warn('[ProxyService] No proxies available');
      return null;
    }

    const usedForPlace = this.usedProxies.get(placeId) || new Set();
    const totalProxies = this.proxies.length;

    // Try each proxy in round-robin order, skip already-used ones for this placeId
    for (let i = 0; i < totalProxies; i++) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % totalProxies;

      if (usedForPlace.has(proxy.address)) {
        continue;
      }

      // Track as used for this placeId
      if (!this.usedProxies.has(placeId)) {
        this.usedProxies.set(placeId, new Set());
      }
      this.usedProxies.get(placeId)!.add(proxy.address);

      console.log(`[ProxyService] Got proxy: ${proxy.address}:${proxy.port} for ${placeId}`);
      return proxy;
    }

    console.warn(`[ProxyService] All ${totalProxies} proxies already used for ${placeId}`);
    return null;
  }

  /**
   * Ensure proxy list is loaded and not stale
   */
  private async ensureProxiesLoaded(): Promise<void> {
    if (this.proxies.length > 0 && Date.now() - this.lastFetchTime < this.refreshIntervalMs) {
      return;
    }
    await this.fetchProxyList();
  }

  /**
   * Fetch proxy list from Webshare download URL
   * Format: IP:PORT:USERNAME:PASSWORD (one per line)
   */
  private async fetchProxyList(): Promise<void> {
    const downloadUrl = env.WEBSHARE_PROXY_URL;
    if (!downloadUrl) {
      console.error('[ProxyService] WEBSHARE_PROXY_URL is not set');
      return;
    }

    try {
      console.log('[ProxyService] Fetching proxy list from Webshare...');
      const response = await fetch(downloadUrl);

      if (!response.ok) {
        console.error(`[ProxyService] Failed to fetch proxy list: ${response.status}`);
        return;
      }

      const text = await response.text();
      const lines = text.trim().split('\n').filter((line) => line.trim().length > 0);

      const parsed: Proxy[] = [];
      for (const line of lines) {
        const parts = line.trim().split(':');
        if (parts.length < 4) {
          console.warn(`[ProxyService] Skipping invalid line: ${line}`);
          continue;
        }

        const [address, portStr, username, password] = parts;
        const port = parseInt(portStr, 10);
        if (!address || isNaN(port)) {
          console.warn(`[ProxyService] Skipping invalid proxy: ${line}`);
          continue;
        }

        parsed.push({
          address,
          port,
          username,
          password,
          protocol: 'http',
        });
      }

      if (parsed.length > 0) {
        this.proxies = parsed;
        this.lastFetchTime = Date.now();
        console.log(`[ProxyService] Loaded ${parsed.length} proxies from Webshare`);
      } else {
        console.error('[ProxyService] No valid proxies parsed from response');
      }
    } catch (error) {
      console.error('[ProxyService] Failed to fetch proxy list:', error);
    }
  }

  /**
   * Record proxy usage for analytics and optimization
   */
  async recordUsage(record: ProxyUsageRecord): Promise<void> {
    try {
      await prisma.proxyUsage.create({
        data: {
          proxyAddress: record.proxyAddress,
          tier: record.tier || 'high',
          targetPlaceId: record.targetPlaceId,
          success: record.success,
          responseTimeMs: record.responseTimeMs,
          errorMessage: record.errorMessage,
        },
      });
    } catch (error) {
      console.error('[ProxyService] Failed to record usage:', error);
    }
  }

  /**
   * Get proxy statistics
   */
  async getStats(hours: number = 24) {
    const since = new Date();
    since.setHours(since.getHours() - hours);

    const stats = await prisma.proxyUsage.groupBy({
      by: ['tier', 'success'],
      where: {
        usedAt: { gte: since },
      },
      _count: true,
      _avg: {
        responseTimeMs: true,
      },
    });

    return stats;
  }

  /**
   * Get success rate for a specific proxy
   */
  async getProxySuccessRate(proxyAddress: string, hours: number = 24) {
    const since = new Date();
    since.setHours(since.getHours() - hours);

    const total = await prisma.proxyUsage.count({
      where: {
        proxyAddress,
        usedAt: { gte: since },
      },
    });

    const successful = await prisma.proxyUsage.count({
      where: {
        proxyAddress,
        success: true,
        usedAt: { gte: since },
      },
    });

    return total > 0 ? successful / total : 0;
  }

  /**
   * Clear used proxies cache for a place (allows retry with same proxies)
   */
  clearUsedProxies(placeId: string): void {
    this.usedProxies.delete(placeId);
  }

  /**
   * Clear all used proxies cache
   */
  clearAllUsedProxies(): void {
    this.usedProxies.clear();
  }

  /**
   * Build proxy URL for Puppeteer
   */
  buildProxyUrl(proxy: Proxy): string {
    const auth = proxy.username && proxy.password
      ? `${proxy.username}:${proxy.password}@`
      : '';
    return `${proxy.protocol}://${auth}${proxy.address}:${proxy.port}`;
  }

  /**
   * Check if proxy service is available (has proxies loaded)
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureProxiesLoaded();
      return this.proxies.length > 0;
    } catch {
      return false;
    }
  }
}

export const proxyService = new ProxyService();
export default proxyService;
