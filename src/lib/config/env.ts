// Environment configuration for Nerede Yesem?
// Centralized environment variable access with type safety

export const env = {
  // Database
  DATABASE_URL: process.env.DATABASE_URL || '',

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  // Google APIs
  GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY || '',
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',

  // Webshare Proxy
  WEBSHARE_PROXY_URL: process.env.WEBSHARE_PROXY_URL || '',

  // Cache Settings
  CACHE_TTL_DAYS: parseInt(process.env.CACHE_TTL_DAYS || '30', 10),
  CACHE_STALE_GRACE_HOURS: parseInt(process.env.CACHE_STALE_GRACE_HOURS || '24', 10),

  // Scraping Settings
  MAX_REVIEWS_PER_RESTAURANT: parseInt(process.env.MAX_REVIEWS_PER_RESTAURANT || '20', 10),
  SCRAPE_TIMEOUT_MS: parseInt(process.env.SCRAPE_TIMEOUT_MS || '30000', 10),
  SCRAPE_MAX_RETRIES: parseInt(process.env.SCRAPE_MAX_RETRIES || '3', 10),

  // Discovery Settings
  GOOGLE_API_MONTHLY_LIMIT: parseInt(process.env.GOOGLE_API_MONTHLY_LIMIT || '5000', 10),
  SEARCH_SCRAPE_MAX_RESULTS: parseInt(process.env.SEARCH_SCRAPE_MAX_RESULTS || '50', 10),

  // Environment
  NODE_ENV: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',
} as const;

// Validation function to check required environment variables
export function validateEnv(): { valid: boolean; missing: string[] } {
  const required = [
    'DATABASE_URL',
    'OPENAI_API_KEY',
    'GOOGLE_PLACES_API_KEY',
  ];

  const missing = required.filter((key) => !process.env[key]);

  return {
    valid: missing.length === 0,
    missing,
  };
}

// Cache duration helpers
export const cacheDuration = {
  // 30 days in milliseconds
  get ttlMs(): number {
    return env.CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  },
  // Stale grace period in milliseconds
  get staleGraceMs(): number {
    return env.CACHE_STALE_GRACE_HOURS * 60 * 60 * 1000;
  },
  // Get expiry date from now
  getExpiryDate(): Date {
    return new Date(Date.now() + this.ttlMs);
  },
  // Check if a date is expired
  isExpired(expiresAt: Date): boolean {
    return new Date() > expiresAt;
  },
  // Check if cache is stale but within grace period
  isStale(expiresAt: Date): boolean {
    const now = new Date();
    const staleThreshold = new Date(expiresAt.getTime() - this.staleGraceMs);
    return now > staleThreshold && now <= expiresAt;
  },
};

export default env;
