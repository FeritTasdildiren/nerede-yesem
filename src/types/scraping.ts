// Types for Cache and Scraping System

// Proxy Types
export type ProxyTier = 'high' | 'medium' | 'low';

export interface Proxy {
  address: string;
  port: number;
  username?: string;
  password?: string;
  tier?: ProxyTier;
  protocol: 'http' | 'https' | 'socks5';
}

export interface ProxyResponse {
  success: boolean;
  proxy?: Proxy;
  error?: string;
}

export interface ProxyUsageRecord {
  proxyAddress: string;
  tier?: ProxyTier;
  targetPlaceId: string;
  success: boolean;
  responseTimeMs?: number;
  errorMessage?: string;
}

// Scraper Types
export interface ScrapedReviewData {
  authorName: string;
  rating: number;
  text: string;
  pricePerPerson?: string;
  relativeTime?: string;
  matchedKeywords: string[];
}

export interface ScrapedRestaurantData {
  googlePlaceId: string;
  name: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
  rating?: number;
  totalReviews?: number;
  priceLevel?: number;
  phone?: string;
  website?: string;
  googleMapsUrl?: string;
}

export interface ScrapeResult {
  success: boolean;
  restaurant?: ScrapedRestaurantData;
  reviews: ScrapedReviewData[];
  error?: string;
  scrapedAt: Date;
  proxyUsed?: string;
}

export interface ScrapeOptions {
  maxReviews?: number;
  foodKeyword: string;
  sortBy?: 'newest' | 'highest' | 'lowest';
  timeout?: number;
  restaurantName?: string; // For debug logging in parallel scraping
}

// Cache Types
export type CacheStatus = 'fresh' | 'stale' | 'refreshing' | 'failed';

export interface CacheKey {
  foodQuery: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
}

export interface CachedAnalysisResult {
  restaurantId: string;
  googlePlaceId: string;
  name: string;
  foodScore: number;
  positivePoints: string[];
  negativePoints: string[];
  isRecommended: boolean;
  summary: string;
  reviewCount: number;
  avgRating: number;
  distance?: number;
  keywordRating?: number; // Scrape edilen yorumların yıldız ortalaması
  searchQuery?: string; // Aranan yemek türü
}

export interface CacheEntry {
  id: string;
  cacheKey: string;
  status: CacheStatus;
  foodQuery: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  analysisResults: CachedAnalysisResult[];
  aiMessage?: string;
  expiresAt: Date;
  hitCount: number;
  createdAt: Date;
  lastAccessedAt: Date;
}

export interface CacheLookupResult {
  found: boolean;
  entry?: CacheEntry;
  status: 'hit' | 'miss' | 'stale' | 'expired';
}

// Background Job Types
export type JobType = 'refresh_cache' | 'scrape_restaurant' | 'cleanup_expired';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface JobPayload {
  type: JobType;
  data: Record<string, unknown>;
}

export interface BackgroundJobData {
  id: string;
  type: JobType;
  payload: JobPayload;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  scheduledAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

// API Response Types
export interface ScrapeApiResponse {
  success: boolean;
  data?: {
    restaurant: ScrapedRestaurantData;
    reviews: ScrapedReviewData[];
    fromCache: boolean;
    cacheStatus?: CacheStatus;
  };
  error?: string;
}

// Utility function to generate cache key
export function generateCacheKey(params: CacheKey): string {
  const normalized = {
    q: params.foodQuery.toLowerCase().trim(),
    lat: params.latitude.toFixed(4),
    lng: params.longitude.toFixed(4),
    r: params.radiusKm,
  };
  return `${normalized.q}:${normalized.lat}:${normalized.lng}:${normalized.r}`;
}

// Utility function to check if coordinates are within range
export function isWithinRange(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  thresholdKm: number = 0.5
): boolean {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  return distance <= thresholdKm;
}
