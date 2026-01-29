// Restaurant Discovery Service - Parallel scraping + API search with merge, dedup, and ranking
import { searchNearbyRestaurants, calculateDistance } from '@/lib/google-places';
import type { PlaceResult } from '@/lib/google-places';
import { googleMapsSearchScraper, SearchScrapedRestaurant } from '@/lib/scraping/google-maps-search-scraper';
import { apiCallCounter } from './api-call-counter';
import { env } from '@/lib/config/env';

export interface DiscoveredRestaurant {
  name: string;
  placeId?: string;
  rating?: number;
  reviewCount?: number;
  address?: string;
  latitude?: number;
  longitude?: number;
  priceLevel?: number;
  googleMapsUrl?: string;
  source: 'scrape' | 'api' | 'both';
  prominenceScore: number;
}

export interface DiscoveryParams {
  foodQuery: string;
  locationText: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
}

export interface DiscoveryResult {
  restaurants: DiscoveredRestaurant[];
  scrapeCount: number;
  apiCount: number;
  apiCallUsed: boolean;
}

/**
 * Normalize a name for dedup comparison
 * Lowercase, remove special chars except Turkish letters, trim
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-zçğıöşü0-9\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if two names are "similar enough" to be the same restaurant
 */
function areNamesSimilar(a: string, b: string): boolean {
  const normA = normalizeName(a);
  const normB = normalizeName(b);

  if (normA === normB) return true;

  // One is a substring of the other
  if (normA.includes(normB) || normB.includes(normA)) return true;

  return false;
}

/**
 * Check if two points are within a distance threshold (in km)
 */
function areClose(
  lat1?: number, lng1?: number,
  lat2?: number, lng2?: number,
  thresholdKm: number = 0.1
): boolean {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) {
    return false;
  }
  const distance = calculateDistance(lat1, lng1, lat2, lng2);
  return distance <= thresholdKm;
}

/**
 * Calculate prominence score: rating × log10(reviewCount + 1)
 */
function calculateProminenceScore(rating?: number, reviewCount?: number): number {
  const r = rating || 0;
  const c = reviewCount || 0;
  return r * Math.log10(c + 1);
}

/**
 * Convert API PlaceResult to DiscoveredRestaurant
 */
function apiToDiscovered(place: PlaceResult): DiscoveredRestaurant {
  return {
    name: place.name,
    placeId: place.place_id,
    rating: place.rating,
    reviewCount: place.user_ratings_total,
    address: place.formatted_address,
    latitude: place.geometry?.location?.lat,
    longitude: place.geometry?.location?.lng,
    priceLevel: place.price_level,
    googleMapsUrl: undefined,
    source: 'api',
    prominenceScore: calculateProminenceScore(place.rating, place.user_ratings_total),
  };
}

/**
 * Convert scraped search result to DiscoveredRestaurant
 */
function scrapeToDiscovered(r: SearchScrapedRestaurant): DiscoveredRestaurant {
  return {
    name: r.name,
    placeId: undefined,
    rating: r.rating,
    reviewCount: r.reviewCount,
    address: r.address,
    latitude: r.latitude,
    longitude: r.longitude,
    priceLevel: r.priceLevel,
    googleMapsUrl: r.googleMapsUrl,
    source: 'scrape',
    prominenceScore: calculateProminenceScore(r.rating, r.reviewCount),
  };
}

class RestaurantDiscoveryService {
  /**
   * Discover restaurants using parallel scraping + API approach
   */
  async discover(params: DiscoveryParams, topN: number = 5): Promise<DiscoveryResult> {
    const { foodQuery, locationText, latitude, longitude, radiusKm } = params;

    console.log(`[Discovery] Starting parallel discovery for "${foodQuery}" near ${locationText}`);

    // Run scrape and API in parallel
    const canUseApi = env.DATABASE_URL ? await apiCallCounter.canMakeCall() : false;

    const [scrapeSettled, apiSettled] = await Promise.allSettled([
      // Scrape path
      googleMapsSearchScraper.scrapeSearchResults(
        locationText,
        foodQuery,
        latitude,
        longitude,
        radiusKm
      ),
      // API path (only if under monthly limit)
      canUseApi
        ? this.callApi(foodQuery, latitude, longitude, radiusKm)
        : Promise.resolve(null),
    ]);

    // Process scrape results
    let scrapeRestaurants: DiscoveredRestaurant[] = [];
    if (scrapeSettled.status === 'fulfilled' && scrapeSettled.value.success) {
      scrapeRestaurants = scrapeSettled.value.restaurants
        .filter(r => !r.isSponsored)
        .map(scrapeToDiscovered);
      console.log(`[Discovery] Scrape: ${scrapeRestaurants.length} restaurants`);
    } else {
      const reason = scrapeSettled.status === 'rejected'
        ? scrapeSettled.reason
        : (scrapeSettled.value as { error?: string })?.error;
      console.warn('[Discovery] Scrape failed:', reason);
    }

    // Process API results
    let apiRestaurants: DiscoveredRestaurant[] = [];
    let apiCallUsed = false;
    if (apiSettled.status === 'fulfilled' && apiSettled.value) {
      apiRestaurants = apiSettled.value;
      apiCallUsed = true;
      console.log(`[Discovery] API: ${apiRestaurants.length} restaurants`);
    } else if (apiSettled.status === 'rejected') {
      console.warn('[Discovery] API failed:', apiSettled.reason);
    } else if (!canUseApi) {
      console.log('[Discovery] API skipped (monthly limit reached or DB disabled)');
    }

    // Merge and deduplicate
    const merged = this.mergeAndDedup(apiRestaurants, scrapeRestaurants);
    console.log(`[Discovery] After merge+dedup: ${merged.length} restaurants`);

    // Sort by prominence score and take top N
    const sorted = merged
      .sort((a, b) => b.prominenceScore - a.prominenceScore)
      .slice(0, topN);

    console.log(`[Discovery] Top ${topN}:`, sorted.map(r =>
      `${r.name} (${r.rating}, ${r.reviewCount} reviews, score=${r.prominenceScore.toFixed(2)}, source=${r.source})`
    ));

    return {
      restaurants: sorted,
      scrapeCount: scrapeRestaurants.length,
      apiCount: apiRestaurants.length,
      apiCallUsed,
    };
  }

  /**
   * Call Google Places API and track usage
   */
  private async callApi(
    keyword: string,
    latitude: number,
    longitude: number,
    radiusKm: number
  ): Promise<DiscoveredRestaurant[]> {
    const radiusMeters = radiusKm * 1000;
    const places = await searchNearbyRestaurants(latitude, longitude, keyword, radiusMeters);

    // Increment API call counter
    await apiCallCounter.increment();

    return places.map(apiToDiscovered);
  }

  /**
   * Merge API and scrape results, deduplicating entries
   * API results take priority (they have placeId)
   */
  private mergeAndDedup(
    apiResults: DiscoveredRestaurant[],
    scrapeResults: DiscoveredRestaurant[]
  ): DiscoveredRestaurant[] {
    // Start with API results as base (they have placeId)
    const merged: DiscoveredRestaurant[] = [...apiResults];

    for (const scrapeItem of scrapeResults) {
      // Check if this scrape result matches any existing entry
      let isDuplicate = false;

      for (let i = 0; i < merged.length; i++) {
        const existing = merged[i];

        // Check name similarity
        const nameSimilar = areNamesSimilar(existing.name, scrapeItem.name);

        // If names match exactly → duplicate
        if (normalizeName(existing.name) === normalizeName(scrapeItem.name)) {
          isDuplicate = true;
          // Enrich API result with scrape data
          this.enrichFromScrape(merged[i], scrapeItem);
          break;
        }

        // If names are similar AND locations are close → duplicate
        if (nameSimilar && areClose(
          existing.latitude, existing.longitude,
          scrapeItem.latitude, scrapeItem.longitude,
          0.1
        )) {
          isDuplicate = true;
          this.enrichFromScrape(merged[i], scrapeItem);
          break;
        }
      }

      if (!isDuplicate) {
        merged.push(scrapeItem);
      }
    }

    return merged;
  }

  /**
   * Enrich an existing entry with data from a scraped result
   */
  private enrichFromScrape(existing: DiscoveredRestaurant, scrape: DiscoveredRestaurant): void {
    // Mark as coming from both sources
    existing.source = 'both';

    // Fill in missing data from scrape
    if (!existing.googleMapsUrl && scrape.googleMapsUrl) {
      existing.googleMapsUrl = scrape.googleMapsUrl;
    }
    if (!existing.address && scrape.address) {
      existing.address = scrape.address;
    }
    if (!existing.priceLevel && scrape.priceLevel) {
      existing.priceLevel = scrape.priceLevel;
    }
    if (!existing.latitude && scrape.latitude) {
      existing.latitude = scrape.latitude;
      existing.longitude = scrape.longitude;
    }

    // Use higher review count if scrape has more (API may be outdated)
    if (scrape.reviewCount && (!existing.reviewCount || scrape.reviewCount > existing.reviewCount)) {
      existing.reviewCount = scrape.reviewCount;
      // Recalculate prominence score with updated data
      existing.prominenceScore = calculateProminenceScore(existing.rating, existing.reviewCount);
    }
  }
}

export const restaurantDiscoveryService = new RestaurantDiscoveryService();
export default restaurantDiscoveryService;
