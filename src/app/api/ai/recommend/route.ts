// AI Recommendation Endpoint with Cache and Scraping Integration
import { NextRequest, NextResponse } from 'next/server';
import { analyzeReviews, generateRecommendationMessage } from '@/lib/ai/openai';
import { searchNearbyRestaurants, getPlaceDetails, getPriceRangeFromLevel, calculateDistance } from '@/lib/google-places';
import { ApiResponse, SearchResult, RestaurantWithAnalysis } from '@/types';
import { cacheService } from '@/lib/cache/cache-service';
import { googleMapsScraper } from '@/lib/scraping/google-maps-scraper';
import { restaurantRepository } from '@/lib/repositories/restaurant-repository';
import { reviewRepository } from '@/lib/repositories/review-repository';
import { backgroundJobService } from '@/lib/jobs/background-job-service';
import { generateCacheKey, CachedAnalysisResult } from '@/types/scraping';
import { env } from '@/lib/config/env';

// Flag to enable/disable database features (set to false if DB not ready)
const DB_ENABLED = !!env.DATABASE_URL;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { foodQuery, location, radius = 3 } = body;

    if (!foodQuery || !location) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'foodQuery ve location gerekli' },
        { status: 400 }
      );
    }

    console.log('[API] Search request:', { foodQuery, location, radius, dbEnabled: DB_ENABLED });

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

    // Cache miss or DB disabled - search Google Places
    console.log('[API] Cache miss, searching Google Places...');

    const radiusInMeters = radius * 1000;
    const places = await searchNearbyRestaurants(
      location.latitude,
      location.longitude,
      foodQuery,
      radiusInMeters
    );

    console.log('[API] Found places:', places.length);

    if (places.length === 0) {
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

    // Filter for quality places
    const qualityPlaces = places.filter(p =>
      (p.user_ratings_total || 0) >= 50 && (p.rating || 0) >= 4.0
    );

    console.log(`[API] Quality filter: ${qualityPlaces.length}/${places.length} places`);

    let topPlaces;
    if (qualityPlaces.length >= 3) {
      topPlaces = qualityPlaces.slice(0, 5);
    } else {
      console.log('[API] Using relaxed filter');
      topPlaces = places
        .filter(p => (p.user_ratings_total || 0) >= 10 && (p.rating || 0) >= 3.5)
        .slice(0, 5);

      if (topPlaces.length === 0) {
        topPlaces = places.slice(0, 5);
      }
    }

    console.log('[API] Top places:', topPlaces.map(p => `${p.name} (${p.rating})`));

    // Process each restaurant in PARALLEL - Try scraping FIRST to minimize API calls
    const scrapedRestaurantIds: string[] = [];

    // Phase 1: Try scraping first for all restaurants
    interface ScrapeAttempt {
      place: typeof topPlaces[0];
      scrapeResult: Awaited<ReturnType<typeof googleMapsScraper.scrapeAndSave>> | null;
      reviewTexts: string[];
      needsApiCall: boolean;
    }

    const scrapeAttempts: ScrapeAttempt[] = [];

    const tryScrapeFirst = async (place: typeof topPlaces[0]): Promise<ScrapeAttempt> => {
      console.log(`[API] Trying scrape first for: ${place.name}`);

      let reviewTexts: string[] = [];
      let scrapeResult: Awaited<ReturnType<typeof googleMapsScraper.scrapeAndSave>> | null = null;
      let needsApiCall = true;

      if (DB_ENABLED) {
        try {
          // Check if we have recent reviews in DB
          const existingRestaurant = await restaurantRepository.findByPlaceId(place.place_id);

          if (existingRestaurant) {
            const existingReviews = await reviewRepository.findByRestaurantAndKeyword(
              existingRestaurant.id,
              foodQuery,
              env.MAX_REVIEWS_PER_RESTAURANT
            );

            if (existingReviews.length >= 5) {
              console.log(`[API] Using ${existingReviews.length} cached reviews for ${place.name}`);
              reviewTexts = existingReviews.map((r: { text: string }) => r.text);
              scrapedRestaurantIds.push(existingRestaurant.id);
              // If we have reviews + restaurant info in DB, no API call needed
              if (existingRestaurant.formattedAddress) {
                needsApiCall = false;
              }
            }
          }

          // If not enough reviews, try scraping
          if (reviewTexts.length < 5) {
            console.log(`[API] Scraping reviews for ${place.name}...`);
            // Build URL from place_id
            const scrapeUrl = `https://www.google.com/maps/place/?q=place_id:${place.place_id}`;

            scrapeResult = await googleMapsScraper.scrapeAndSave(
              scrapeUrl,
              place.place_id,
              { foodKeyword: foodQuery },
              {
                googlePlaceId: place.place_id,
                name: place.name,
                // Use location from Nearby Search
                latitude: place.geometry?.location?.lat,
                longitude: place.geometry?.location?.lng,
              }
            );

            if (scrapeResult.success && scrapeResult.reviews.length >= 5) {
              reviewTexts = scrapeResult.reviews.map(r => r.text);
              console.log(`[API] Scraped ${reviewTexts.length} reviews for ${place.name}`);

              // Get restaurant ID for cache
              const savedRestaurant = await restaurantRepository.findByPlaceId(place.place_id);
              if (savedRestaurant) {
                scrapedRestaurantIds.push(savedRestaurant.id);
              }

              // If we have enough reviews, no API call needed
              // Use Nearby Search data (place.name, place.formatted_address) as fallback
              needsApiCall = false;
              console.log(`[API] Scraping successful for ${place.name}, skipping Place Details API`);
            }
          }
        } catch (scrapeError) {
          console.warn(`[API] Scraping failed for ${place.name}:`, scrapeError);
        }
      }

      return { place, scrapeResult, reviewTexts, needsApiCall };
    };

    // Run all scrape attempts in PARALLEL
    console.log(`[API] Phase 1: Trying to scrape ${topPlaces.length} restaurants in parallel...`);
    const allScrapeAttempts = await Promise.all(topPlaces.map(tryScrapeFirst));

    // Count successful scrapes
    const successfulScrapes = allScrapeAttempts.filter(a => !a.needsApiCall);
    console.log(`[API] Phase 1 complete: ${successfulScrapes.length}/${topPlaces.length} restaurants scraped successfully`);

    // Phase 2: Process results - call API only for failed scrapes if needed
    const processRestaurant = async (attempt: ScrapeAttempt): Promise<RestaurantWithAnalysis | null> => {
      const { place, scrapeResult, reviewTexts: scrapeReviewTexts, needsApiCall } = attempt;
      let reviewTexts = scrapeReviewTexts;

      // Calculate keyword rating from scraped reviews
      let keywordRating: number | undefined;
      if (scrapeResult?.reviews && scrapeResult.reviews.length > 0) {
        const ratings = scrapeResult.reviews.map(r => r.rating).filter(r => r > 0);
        if (ratings.length > 0) {
          const sum = ratings.reduce((a, b) => a + b, 0);
          keywordRating = Math.round((sum / ratings.length) * 10) / 10; // 1 decimal
        }
      }

      // Get restaurant details (from scrape or API)
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
        // Use scraped data + Nearby Search data as fallback
        console.log(`[API] Using scraped/nearby data for: ${place.name}`);
        const sr = scrapeResult?.restaurant;
        details = {
          place_id: place.place_id,
          name: sr?.name || place.name,
          formatted_address: sr?.formattedAddress || place.formatted_address || '',
          geometry: {
            location: {
              lat: sr?.latitude || place.geometry?.location?.lat || 0,
              lng: sr?.longitude || place.geometry?.location?.lng || 0,
            }
          },
          rating: sr?.rating || place.rating,
          user_ratings_total: sr?.totalReviews || place.user_ratings_total,
          price_level: sr?.priceLevel || place.price_level,
          formatted_phone_number: sr?.phone,
          website: sr?.website,
          url: sr?.googleMapsUrl,
        };
      } else {
        // Need to call Place Details API
        console.log(`[API] Calling Place Details API for: ${place.name}`);
        const apiDetails = await getPlaceDetails(place.place_id);
        if (!apiDetails) {
          console.log(`[API] Failed to get details for: ${place.name}`);
          return null;
        }
        details = apiDetails;

        // If scraping failed but we need reviews, use API reviews
        if (reviewTexts.length === 0) {
          reviewTexts = details.reviews?.map(r => r.text).filter(Boolean) || [];
          console.log(`[API] Using ${reviewTexts.length} Google API reviews for ${place.name}`);
        }
      }

      const distance = calculateDistance(
        location.latitude,
        location.longitude,
        details.geometry.location.lat,
        details.geometry.location.lng
      );

      // Analyze reviews with AI
      let analysis;
      if (reviewTexts.length > 0) {
        analysis = await analyzeReviews(details.name, foodQuery, reviewTexts);
      } else {
        analysis = {
          foodScore: details.rating ? Math.round(details.rating * 2) : 5,
          positivePoints: ['Google\'da yüksek puan'],
          negativePoints: [],
          isRecommended: (details.rating || 0) >= 4,
          summary: `${details.name} - Google puanı: ${details.rating || 'N/A'}`,
        };
      }

      // Parse address
      const addressParts = details.formatted_address.split(',').map(s => s.trim());
      const district = addressParts[1] || '';
      const city = addressParts[2] || 'İstanbul';

      return {
        id: details.place_id,
        placeId: details.place_id,
        name: details.name,
        slug: details.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
        cuisineTypes: place.types?.filter(t =>
          !['restaurant', 'food', 'point_of_interest', 'establishment'].includes(t)
        ) || [],
        priceRange: getPriceRangeFromLevel(details.price_level),
        address: details.formatted_address,
        city: city.replace(/^\d+\s*/, ''),
        district,
        latitude: details.geometry.location.lat,
        longitude: details.geometry.location.lng,
        phone: details.formatted_phone_number,
        website: details.website,
        googleMapsUrl: details.url,
        avgRating: details.rating || 0,
        reviewCount: details.user_ratings_total || 0,
        distance: Math.round(distance * 10) / 10,
        aiAnalysis: analysis,
        keywordRating, // Scrape edilen yorumların yıldız ortalaması
        searchQuery: foodQuery, // Aranan yemek türü
      };
    };

    // Phase 2: Process all restaurants
    console.log(`[API] Phase 2: Processing ${allScrapeAttempts.length} restaurants...`);
    const apiCallsNeeded = allScrapeAttempts.filter(a => a.needsApiCall).length;
    console.log(`[API] API calls needed: ${apiCallsNeeded}/${allScrapeAttempts.length}`);

    const results = await Promise.all(allScrapeAttempts.map(processRestaurant));
    const analyzedRestaurants = results.filter((r): r is RestaurantWithAnalysis => r !== null);

    console.log(`[API] Processed ${analyzedRestaurants.length} restaurants (parallel)`);

    // Sort by keyword rating (scrape edilen yorumların yıldız ortalaması)
    // Fallback to AI food score if keyword rating is not available
    const sortedRestaurants = analyzedRestaurants
      .sort((a, b) => {
        const ratingA = a.keywordRating ?? (a.aiAnalysis.foodScore / 2); // AI score 0-10, rating 0-5
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
