// AI Recommendation Endpoint with Cache, Discovery, and Scraping Integration
import { NextRequest, NextResponse } from 'next/server';
import { analyzeReviews, generateRecommendationMessage } from '@/lib/ai/openai';
import { getPlaceDetails, getPriceRangeFromLevel, calculateDistance } from '@/lib/google-places';
import { ApiResponse, SearchResult, RestaurantWithAnalysis } from '@/types';
import { cacheService } from '@/lib/cache/cache-service';
import { googleMapsScraper } from '@/lib/scraping/google-maps-scraper';
import { restaurantRepository } from '@/lib/repositories/restaurant-repository';
import { reviewRepository } from '@/lib/repositories/review-repository';
import { backgroundJobService } from '@/lib/jobs/background-job-service';
import { CachedAnalysisResult } from '@/types/scraping';
import { env } from '@/lib/config/env';
import { restaurantDiscoveryService, DiscoveredRestaurant } from '@/lib/services/restaurant-discovery';

// Flag to enable/disable database features (set to false if DB not ready)
const DB_ENABLED = !!env.DATABASE_URL;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { foodQuery, location, radius = 3, locationText = '' } = body;

    if (!foodQuery || !location) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'foodQuery ve location gerekli' },
        { status: 400 }
      );
    }

    console.log('[API] Search request:', { foodQuery, location, radius, locationText, dbEnabled: DB_ENABLED });

    // Check cache first (if DB is enabled)
    if (DB_ENABLED) {
      const cacheResult = await cacheService.lookup({
        foodQuery,
        latitude: location.latitude,
        longitude: location.longitude,
        radiusKm: radius,
      });

      if (cacheResult.found && cacheResult.entry) {
        console.log(`[API] Cache ${cacheResult.status}: ${cacheResult.entry.cacheKey}`);

        // If stale, trigger background refresh
        if (cacheResult.status === 'stale') {
          await backgroundJobService.scheduleRefresh(cacheResult.entry.id, 1);
          console.log('[API] Scheduled background refresh for stale cache');
        }

        // Return cached results (fresh or stale)
        if (cacheResult.status === 'hit' || cacheResult.status === 'stale') {
          const cachedResults = cacheResult.entry.analysisResults;
          return NextResponse.json<ApiResponse<SearchResult>>({
            success: true,
            data: {
              query: foodQuery,
              location,
              recommendations: cachedResults.map(transformCachedToRestaurant),
              message: cacheResult.entry.aiMessage || generateDefaultMessage(foodQuery, cachedResults),
              searchedAt: cacheResult.entry.createdAt,
            },
            meta: {
              cached: true,
              cacheStatus: cacheResult.status,
              cacheAge: Math.floor((Date.now() - cacheResult.entry.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
            } as Record<string, unknown>,
          });
        }
      }
    }

    // Cache miss or DB disabled - use Discovery Service (parallel scrape + API)
    console.log('[API] Cache miss, starting restaurant discovery...');

    const discoveryResult = await restaurantDiscoveryService.discover({
      foodQuery,
      locationText: locationText || `${location.latitude},${location.longitude}`,
      latitude: location.latitude,
      longitude: location.longitude,
      radiusKm: radius,
    }, 5);

    console.log(`[API] Discovery complete: ${discoveryResult.restaurants.length} restaurants (scrape: ${discoveryResult.scrapeCount}, api: ${discoveryResult.apiCount})`);

    if (discoveryResult.restaurants.length === 0) {
      return NextResponse.json<ApiResponse<SearchResult>>({
        success: true,
        data: {
          query: foodQuery,
          location,
          recommendations: [],
          message: `${radius} km yarıçapında "${foodQuery}" için restoran bulunamadı.`,
          searchedAt: new Date(),
        },
      });
    }

    // Process each discovered restaurant - Try scraping reviews FIRST to minimize API calls
    const scrapedRestaurantIds: string[] = [];

    interface ScrapeAttempt {
      discovered: DiscoveredRestaurant;
      scrapeResult: Awaited<ReturnType<typeof googleMapsScraper.scrapeAndSave>> | null;
      reviewTexts: string[];
      needsApiCall: boolean;
    }

    const tryScrapeFirst = async (discovered: DiscoveredRestaurant): Promise<ScrapeAttempt> => {
      console.log(`[API] Trying scrape first for: ${discovered.name} (source: ${discovered.source})`);

      let reviewTexts: string[] = [];
      let scrapeResult: Awaited<ReturnType<typeof googleMapsScraper.scrapeAndSave>> | null = null;
      let needsApiCall = true;

      if (DB_ENABLED) {
        try {
          // Check if we have recent reviews in DB (only if placeId available)
          if (discovered.placeId) {
            const existingRestaurant = await restaurantRepository.findByPlaceId(discovered.placeId);

            if (existingRestaurant) {
              const existingReviews = await reviewRepository.findByRestaurantAndKeyword(
                existingRestaurant.id,
                foodQuery,
                env.MAX_REVIEWS_PER_RESTAURANT
              );

              if (existingReviews.length >= 1) {
                console.log(`[API] Using ${existingReviews.length} cached reviews for ${discovered.name}`);
                reviewTexts = existingReviews.map((r: { text: string }) => r.text);
                scrapedRestaurantIds.push(existingRestaurant.id);
                if (existingRestaurant.formattedAddress) {
                  needsApiCall = false;
                }
              }
            }
          }

          // If not enough reviews, try scraping
          if (reviewTexts.length < 1) {
            console.log(`[API] Scraping reviews for ${discovered.name}...`);

            // Build scrape URL: use placeId URL or googleMapsUrl from scrape
            let scrapeUrl: string;
            let scrapeId: string;

            if (discovered.placeId) {
              scrapeUrl = `https://www.google.com/maps/place/?q=place_id:${discovered.placeId}`;
              scrapeId = discovered.placeId;
            } else if (discovered.latitude && discovered.longitude) {
              // No placeId: build a search URL with name + coordinates
              // This navigates Google Maps to the specific restaurant
              const encodedName = encodeURIComponent(discovered.name);
              scrapeUrl = `https://www.google.com/maps/search/${encodedName}/@${discovered.latitude},${discovered.longitude},17z`;
              scrapeId = `scrape-${discovered.name.replace(/\s+/g, '-').substring(0, 30)}`;
            } else {
              // Cannot scrape without URL or placeId
              console.log(`[API] No URL or placeId for ${discovered.name}, skipping review scrape`);
              return { discovered, scrapeResult: null, reviewTexts: [], needsApiCall: !!discovered.placeId };
            }

            scrapeResult = await googleMapsScraper.scrapeAndSave(
              scrapeUrl,
              scrapeId,
              { foodKeyword: foodQuery, restaurantName: discovered.name },
              {
                googlePlaceId: discovered.placeId || scrapeId,
                name: discovered.name,
                latitude: discovered.latitude,
                longitude: discovered.longitude,
              }
            );

            if (scrapeResult.success && scrapeResult.reviews.length >= 1) {
              reviewTexts = scrapeResult.reviews.map(r => r.text);
              console.log(`[API] Scraped ${reviewTexts.length} reviews for ${discovered.name}`);

              // Get restaurant ID for cache
              if (discovered.placeId) {
                const savedRestaurant = await restaurantRepository.findByPlaceId(discovered.placeId);
                if (savedRestaurant) {
                  scrapedRestaurantIds.push(savedRestaurant.id);
                }
              }

              needsApiCall = false;
              console.log(`[API] Scraping successful for ${discovered.name}, skipping Place Details API`);
            }
          }
        } catch (scrapeError) {
          console.warn(`[API] Scraping failed for ${discovered.name}:`, scrapeError);
        }
      }

      return { discovered, scrapeResult, reviewTexts, needsApiCall };
    };

    // Phase 1: Run all scrape attempts in PARALLEL
    console.log(`[API] Phase 1: Trying to scrape ${discoveryResult.restaurants.length} restaurants in parallel...`);
    const allScrapeAttempts = await Promise.all(discoveryResult.restaurants.map(tryScrapeFirst));

    const successfulScrapes = allScrapeAttempts.filter(a => !a.needsApiCall);
    console.log(`[API] Phase 1 complete: ${successfulScrapes.length}/${discoveryResult.restaurants.length} restaurants scraped successfully`);

    // Phase 2: Process results - call API only for failed scrapes if needed
    const processRestaurant = async (attempt: ScrapeAttempt): Promise<RestaurantWithAnalysis | null> => {
      const { discovered, scrapeResult, reviewTexts: scrapeReviewTexts, needsApiCall } = attempt;
      let reviewTexts = scrapeReviewTexts;

      // Calculate keyword rating from scraped reviews
      let keywordRating: number | undefined;
      if (scrapeResult?.reviews && scrapeResult.reviews.length > 0) {
        const ratings = scrapeResult.reviews.map(r => r.rating).filter(r => r > 0);
        if (ratings.length > 0) {
          const sum = ratings.reduce((a, b) => a + b, 0);
          keywordRating = Math.round((sum / ratings.length) * 10) / 10;
        }
      }

      // Get restaurant details (from scrape, discovered data, or API)
      let details: {
        place_id: string;
        name: string;
        formatted_address: string;
        geometry: { location: { lat: number; lng: number } };
        rating?: number;
        user_ratings_total?: number;
        price_level?: number;
        formatted_phone_number?: string;
        website?: string;
        url?: string;
        reviews?: Array<{ text: string }>;
      };

      if (!needsApiCall) {
        // Use scraped data + discovered data as fallback
        console.log(`[API] Using scraped/discovered data for: ${discovered.name}`);
        const sr = scrapeResult?.restaurant;
        details = {
          place_id: discovered.placeId || `scrape-${discovered.name}`,
          name: sr?.name || discovered.name,
          formatted_address: sr?.formattedAddress || discovered.address || '',
          geometry: {
            location: {
              lat: sr?.latitude || discovered.latitude || 0,
              lng: sr?.longitude || discovered.longitude || 0,
            }
          },
          rating: sr?.rating || discovered.rating,
          user_ratings_total: sr?.totalReviews || discovered.reviewCount,
          price_level: sr?.priceLevel || discovered.priceLevel,
          formatted_phone_number: sr?.phone,
          website: sr?.website,
          url: sr?.googleMapsUrl || discovered.googleMapsUrl,
        };
      } else if (discovered.placeId) {
        // Need to call Place Details API
        console.log(`[API] Calling Place Details API for: ${discovered.name}`);
        const apiDetails = await getPlaceDetails(discovered.placeId);
        if (!apiDetails) {
          console.log(`[API] Failed to get details for: ${discovered.name}`);
          return null;
        }
        details = apiDetails;

        // API reviews disabled - only use scraped reviews
        if (reviewTexts.length === 0) {
          console.log(`[API] No scraped reviews for ${discovered.name}, skipping AI analysis`);
        }
      } else {
        // No placeId and no scrape data - use discovered data directly
        console.log(`[API] Using discovered data only for: ${discovered.name}`);
        details = {
          place_id: `discovered-${discovered.name}`,
          name: discovered.name,
          formatted_address: discovered.address || '',
          geometry: {
            location: {
              lat: discovered.latitude || 0,
              lng: discovered.longitude || 0,
            }
          },
          rating: discovered.rating,
          user_ratings_total: discovered.reviewCount,
          price_level: discovered.priceLevel,
          url: discovered.googleMapsUrl,
        };
      }

      const distance = calculateDistance(
        location.latitude,
        location.longitude,
        details.geometry.location.lat,
        details.geometry.location.lng
      );

      // Only include restaurants with scraped reviews
      if (reviewTexts.length === 0) {
        console.log(`[API] Excluding ${discovered.name}: no scraped reviews`);
        return null;
      }

      // Analyze reviews with AI
      console.log(`[API] Running AI analysis for ${discovered.name} with ${reviewTexts.length} reviews`);
      const analysis = await analyzeReviews(details.name, foodQuery, reviewTexts);
      console.log(`[API] AI result for ${discovered.name}: foodScore=${analysis.foodScore}, recommended=${analysis.isRecommended}`);

      // Parse address
      const addressParts = details.formatted_address.split(',').map(s => s.trim());
      const district = addressParts[1] || '';
      const city = addressParts[2] || '';

      return {
        id: details.place_id,
        placeId: discovered.placeId,
        name: details.name,
        slug: details.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
        cuisineTypes: [],
        priceRange: getPriceRangeFromLevel(details.price_level),
        address: details.formatted_address,
        city: city.replace(/^\d+\s*/, '') || '',
        district,
        latitude: details.geometry.location.lat,
        longitude: details.geometry.location.lng,
        phone: details.formatted_phone_number,
        website: details.website,
        googleMapsUrl: details.url || discovered.googleMapsUrl,
        avgRating: details.rating || 0,
        reviewCount: details.user_ratings_total || 0,
        distance: Math.round(distance * 10) / 10,
        aiAnalysis: analysis,
        keywordRating,
        searchQuery: foodQuery,
        source: discovered.source,
      };
    };

    // Phase 2: Process all restaurants
    console.log(`[API] Phase 2: Processing ${allScrapeAttempts.length} restaurants...`);
    const apiCallsNeeded = allScrapeAttempts.filter(a => a.needsApiCall).length;
    console.log(`[API] API calls needed: ${apiCallsNeeded}/${allScrapeAttempts.length}`);

    const results = await Promise.all(allScrapeAttempts.map(processRestaurant));
    const nonNullResults = results.filter((r): r is RestaurantWithAnalysis => r !== null);
    console.log(`[API] Non-null results: ${nonNullResults.length}, scores: [${nonNullResults.map(r => `${r.name}:${r.aiAnalysis.foodScore}`).join(', ')}]`);
    const analyzedRestaurants = nonNullResults.filter(r => r.aiAnalysis.foodScore > 0);

    console.log(`[API] Processed ${analyzedRestaurants.length} restaurants after foodScore>0 filter`);

    // Sort by keyword rating (scrape edilen yorumların yıldız ortalaması)
    // Fallback to AI food score if keyword rating is not available
    const sortedRestaurants = analyzedRestaurants
      .sort((a, b) => {
        const ratingA = a.keywordRating ?? (a.aiAnalysis.foodScore / 2);
        const ratingB = b.keywordRating ?? (b.aiAnalysis.foodScore / 2);
        return ratingB - ratingA;
      });

    // Generate recommendation message
    const message = await generateRecommendationMessage(
      foodQuery,
      sortedRestaurants.map((r) => ({
        name: r.name,
        score: r.aiAnalysis.foodScore,
        summary: r.aiAnalysis.summary,
      }))
    );

    // Store results in cache (if DB enabled)
    if (DB_ENABLED && sortedRestaurants.length > 0) {
      try {
        const cachedResults: CachedAnalysisResult[] = sortedRestaurants.map(r => ({
          restaurantId: r.id,
          googlePlaceId: r.placeId || r.id,
          name: r.name,
          foodScore: r.aiAnalysis.foodScore,
          positivePoints: r.aiAnalysis.positivePoints,
          negativePoints: r.aiAnalysis.negativePoints,
          isRecommended: r.aiAnalysis.isRecommended,
          summary: r.aiAnalysis.summary,
          reviewCount: r.reviewCount,
          avgRating: r.avgRating,
          distance: r.distance,
          keywordRating: r.keywordRating,
          searchQuery: r.searchQuery,
        }));

        await cacheService.store(
          {
            foodQuery,
            latitude: location.latitude,
            longitude: location.longitude,
            radiusKm: radius,
          },
          cachedResults,
          message,
          scrapedRestaurantIds
        );
        console.log('[API] Stored results in cache');
      } catch (cacheError) {
        console.warn('[API] Failed to cache results:', cacheError);
      }
    }

    const result: SearchResult = {
      query: foodQuery,
      location,
      recommendations: sortedRestaurants,
      message: sortedRestaurants.length > 0
        ? message
        : `"${foodQuery}" için yakınınızda öneri bulunamadı.`,
      searchedAt: new Date(),
    };

    return NextResponse.json<ApiResponse<SearchResult>>({
      success: true,
      data: result,
      meta: {
        cached: false,
        reviewSource: DB_ENABLED ? 'scraped' : 'google_api',
        discoveryStats: {
          scrapeCount: discoveryResult.scrapeCount,
          apiCount: discoveryResult.apiCount,
          apiCallUsed: discoveryResult.apiCallUsed,
        },
      } as Record<string, unknown>,
    });
  } catch (error) {
    console.error('[API] /ai/recommend error:', error);
    return NextResponse.json<ApiResponse<null>>(
      { success: false, error: 'Bir hata oluştu: ' + (error instanceof Error ? error.message : 'Bilinmeyen hata') },
      { status: 500 }
    );
  }
}

// Transform cached result to RestaurantWithAnalysis
function transformCachedToRestaurant(cached: CachedAnalysisResult): RestaurantWithAnalysis {
  return {
    id: cached.restaurantId,
    placeId: cached.googlePlaceId,
    name: cached.name,
    slug: cached.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
    cuisineTypes: [],
    priceRange: 'moderate',
    address: '',
    city: '',
    latitude: 0,
    longitude: 0,
    avgRating: cached.avgRating,
    reviewCount: cached.reviewCount,
    distance: cached.distance,
    aiAnalysis: {
      foodScore: cached.foodScore,
      positivePoints: cached.positivePoints,
      negativePoints: cached.negativePoints,
      isRecommended: cached.isRecommended,
      summary: cached.summary,
    },
    keywordRating: cached.keywordRating,
    searchQuery: cached.searchQuery,
  };
}

// Generate default message from cached results
function generateDefaultMessage(query: string, results: CachedAnalysisResult[]): string {
  if (results.length === 0) {
    return `"${query}" için öneri bulunamadı.`;
  }

  const topResult = results[0];
  return `"${query}" için en iyi önerimiz ${topResult.name}. ${topResult.summary}`;
}
