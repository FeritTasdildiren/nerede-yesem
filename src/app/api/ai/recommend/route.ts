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

    // Process each restaurant in PARALLEL
    const scrapedRestaurantIds: string[] = [];

    const processRestaurant = async (place: typeof topPlaces[0]): Promise<RestaurantWithAnalysis | null> => {
      console.log(`[API] Processing: ${place.name}`);

      const details = await getPlaceDetails(place.place_id);
      if (!details) {
        console.log(`[API] Failed to get details for: ${place.name}`);
        return null;
      }

      const distance = calculateDistance(
        location.latitude,
        location.longitude,
        details.geometry.location.lat,
        details.geometry.location.lng
      );

      let reviewTexts: string[] = [];
      let analysis;

      // Try to get scraped reviews from DB or scrape new ones
      if (DB_ENABLED && details.url) {
        try {
          // Check if we have recent reviews for this keyword
          const existingRestaurant = await restaurantRepository.findByPlaceId(place.place_id);

          if (existingRestaurant) {
            const existingReviews = await reviewRepository.findByRestaurantAndKeyword(
              existingRestaurant.id,
              foodQuery,
              env.MAX_REVIEWS_PER_RESTAURANT
            );

            if (existingReviews.length >= 5) {
              // Use existing reviews
              console.log(`[API] Using ${existingReviews.length} cached reviews for ${place.name}`);
              reviewTexts = existingReviews.map((r: { text: string }) => r.text);
              scrapedRestaurantIds.push(existingRestaurant.id);
            }
          }

          // If not enough reviews, scrape new ones
          if (reviewTexts.length < 5) {
            console.log(`[API] Scraping reviews for ${place.name}...`);
            const scrapeResult = await googleMapsScraper.scrapeAndSave(
              details.url,
              place.place_id,
              { foodKeyword: foodQuery },
              {
                googlePlaceId: place.place_id,
                name: details.name,
                formattedAddress: details.formatted_address,
                latitude: details.geometry.location.lat,
                longitude: details.geometry.location.lng,
                rating: details.rating,
                totalReviews: details.user_ratings_total,
                priceLevel: details.price_level,
                phone: details.formatted_phone_number,
                website: details.website,
                googleMapsUrl: details.url,
              }
            );

            if (scrapeResult.success && scrapeResult.reviews.length > 0) {
              reviewTexts = scrapeResult.reviews.map(r => r.text);
              console.log(`[API] Scraped ${reviewTexts.length} reviews for ${place.name}`);

              // Get restaurant ID for cache
              const savedRestaurant = await restaurantRepository.findByPlaceId(place.place_id);
              if (savedRestaurant) {
                scrapedRestaurantIds.push(savedRestaurant.id);
              }
            }
          }
        } catch (scrapeError) {
          console.warn(`[API] Scraping failed for ${place.name}:`, scrapeError);
        }
      }

      // Fallback to Google Places API reviews
      if (reviewTexts.length === 0) {
        reviewTexts = details.reviews?.map(r => r.text).filter(Boolean) || [];
        console.log(`[API] Using ${reviewTexts.length} Google API reviews for ${place.name}`);
      }

      // Analyze reviews with AI
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
      };
    };

    // Run all restaurant processing in PARALLEL
    console.log(`[API] Starting parallel processing for ${topPlaces.length} restaurants...`);
    const results = await Promise.all(topPlaces.map(processRestaurant));
    const analyzedRestaurants = results.filter((r): r is RestaurantWithAnalysis => r !== null);

    console.log(`[API] Processed ${analyzedRestaurants.length} restaurants (parallel)`);

    // Sort by AI food score
    const sortedRestaurants = analyzedRestaurants
      .sort((a, b) => b.aiAnalysis.foodScore - a.aiAnalysis.foodScore);

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
