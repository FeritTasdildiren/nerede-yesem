import { NextRequest, NextResponse } from 'next/server';
import { analyzeReviews, generateRecommendationMessage } from '@/lib/ai/openai';
import { searchNearbyRestaurants, getPlaceDetails, getPriceRangeFromLevel, calculateDistance } from '@/lib/google-places';
import { ApiResponse, SearchResult, RestaurantWithAnalysis } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { foodQuery, location, radius = 3 } = body; // Default 3km radius

    if (!foodQuery || !location) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'foodQuery ve location gerekli' },
        { status: 400 }
      );
    }

    console.log('[API] Search request:', { foodQuery, location, radius });

    // Search for restaurants using Google Places API
    const radiusInMeters = radius * 1000; // Convert km to meters
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

    // Filter for quality places: minimum 50 reviews AND 4+ stars
    const qualityPlaces = places.filter(p =>
      (p.user_ratings_total || 0) >= 50 && (p.rating || 0) >= 4.0
    );

    console.log(`[API] Quality filter: ${qualityPlaces.length}/${places.length} places have 50+ reviews and 4+ stars`);

    // If not enough quality places, relax the filter
    let topPlaces;
    if (qualityPlaces.length >= 3) {
      topPlaces = qualityPlaces.slice(0, 5);
    } else {
      // Fallback: minimum 10 reviews and 3.5 stars
      console.log('[API] Not enough quality places, using relaxed filter');
      topPlaces = places
        .filter(p => (p.user_ratings_total || 0) >= 10 && (p.rating || 0) >= 3.5)
        .slice(0, 5);

      if (topPlaces.length === 0) {
        topPlaces = places.slice(0, 5);
      }
    }

    console.log('[API] Top places selected:', topPlaces.map(p => `${p.name} (${p.rating}⭐, ${p.user_ratings_total} reviews)`));

    // Get detailed info including reviews for each place
    const analyzedRestaurants: RestaurantWithAnalysis[] = [];

    for (const place of topPlaces) {
      const details = await getPlaceDetails(place.place_id);

      if (!details) continue;

      // Extract reviews text
      const reviewTexts = details.reviews?.map(r => r.text).filter(Boolean) || [];

      // Calculate distance
      const distance = calculateDistance(
        location.latitude,
        location.longitude,
        details.geometry.location.lat,
        details.geometry.location.lng
      );

      // Analyze reviews with AI (only if we have reviews)
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

      // Parse address to get city and district
      const addressParts = details.formatted_address.split(',').map(s => s.trim());
      const district = addressParts[1] || '';
      const city = addressParts[2] || 'İstanbul';

      analyzedRestaurants.push({
        id: details.place_id,
        placeId: details.place_id,
        name: details.name,
        slug: details.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
        cuisineTypes: place.types?.filter(t => !['restaurant', 'food', 'point_of_interest', 'establishment'].includes(t)) || [],
        priceRange: getPriceRangeFromLevel(details.price_level),
        address: details.formatted_address,
        city: city.replace(/^\d+\s*/, ''), // Remove postal codes
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
      });
    }

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
    });
  } catch (error) {
    console.error('[API] /ai/recommend error:', error);
    return NextResponse.json<ApiResponse<null>>(
      { success: false, error: 'Bir hata oluştu: ' + (error instanceof Error ? error.message : 'Bilinmeyen hata') },
      { status: 500 }
    );
  }
}
