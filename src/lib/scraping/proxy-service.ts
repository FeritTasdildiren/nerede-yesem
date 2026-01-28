// Proxy Service - Manages proxy rotation for scraping
import { prisma } from '@/lib/db';
import { env } from '@/lib/config/env';
import { Proxy, ProxyTier, ProxyUsageRecord } from '@/types/scraping';

interface ProxyApiResponse {
  success: boolean;
  proxy?: {
    address: string;
    port: number;
    username?: string;
    password?: string;
    tier: string;
    protocol: string;
  };
  error?: string;
}

export class ProxyService {
  private apiUrl: string;
  private apiKey: string;
  private usedProxies: Map<string, Set<string>> = new Map(); // placeId -> Set<proxyAddress>

  constructor() {
    this.apiUrl = env.PROXY_API_URL;
    this.apiKey = env.PROXY_API_KEY;
  }

  /**
   * Get a proxy for scraping a specific place
   * Tries high tier first, falls back to medium tier
   */
  async getProxy(placeId: string, preferredTier: ProxyTier = 'high'): Promise<Proxy | null> {
    const tiers: ProxyTier[] = preferredTier === 'high'
      ? ['high', 'medium']
      : ['medium', 'high'];

    for (const tier of tiers) {
      const proxy = await this.fetchProxy(tier, placeId);
      if (proxy) {
        return proxy;
      }
    }

    console.warn(`[ProxyService] No proxy available for place: ${placeId}`);
    return null;
  }

  /**
   * Fetch a proxy from the API
   */
  private async fetchProxy(tier: ProxyTier, placeId: string): Promise<Proxy | null> {
    try {
      // Get previously used proxies for this place
      const usedForPlace = this.usedProxies.get(placeId) || new Set();

      const response = await fetch(`${this.apiUrl}/proxy/get`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({
          tier,
          exclude: Array.from(usedForPlace),
        }),
      });

      if (!response.ok) {
        console.error(`[ProxyService] API error: ${response.status}`);
        return null;
      }

      const data: ProxyApiResponse = await response.json();

      if (!data.success || !data.proxy) {
        console.warn(`[ProxyService] No ${tier} proxy available`);
        return null;
      }

      const proxy: Proxy = {
        address: data.proxy.address,
        port: data.proxy.port,
        username: data.proxy.username,
        password: data.proxy.password,
        tier: data.proxy.tier as ProxyTier,
        protocol: data.proxy.protocol as 'http' | 'https' | 'socks5',
      };

      // Track this proxy as used for this place
      if (!this.usedProxies.has(placeId)) {
        this.usedProxies.set(placeId, new Set());
      }
      this.usedProxies.get(placeId)!.add(proxy.address);

      return proxy;
    } catch (error) {
      console.error('[ProxyService] Failed to fetch proxy:', error);
      return null;
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
          tier: record.tier,
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
   * Check if proxy API is available
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/health`, {
        method: 'GET',
        headers: {
          'X-API-Key': this.apiKey,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const proxyService = new ProxyService();
export default proxyService;
