import { NextRequest, NextResponse } from 'next/server';
import { analyzeReviews, generateRecommendationMessage } from '@/lib/ai/openai';
import { ApiResponse, SearchResult, RestaurantWithAnalysis } from '@/types';

// Mesafe hesaplama (Haversine formula) - km cinsinden
function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Dünya yarıçapı km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Mock data - Türkiye genelinde restoranlar
const mockRestaurants = [
  // İstanbul - Kadıköy
  {
    id: '1',
    name: 'Halil Lahmacun',
    cuisineTypes: ['turkish', 'lahmacun'],
    priceRange: 'budget' as const,
    address: 'Kadıköy Çarşı',
    city: 'İstanbul',
    district: 'Kadıköy',
    latitude: 40.9906,
    longitude: 29.0261,
    avgRating: 4.7,
    reviewCount: 890,
    reviews: [
      'En iyi lahmacun burada! İnce hamur, bol malzeme.',
      'Lahmacunları efsane, ayran da çok güzel.',
      'Biraz kalabalık ama beklemeye değer.',
      'Fiyat performans harika, lahmacun çıtır çıtır.',
    ],
  },
  {
    id: '2',
    name: 'Çiya Sofrası',
    cuisineTypes: ['turkish', 'regional'],
    priceRange: 'moderate' as const,
    address: 'Güneşlibahçe Sokak No: 43, Kadıköy',
    city: 'İstanbul',
    district: 'Kadıköy',
    latitude: 40.9901,
    longitude: 29.0245,
    avgRating: 4.8,
    reviewCount: 2100,
    reviews: [
      'Anadolu mutfağının en iyisi! Lahmacun dahil her şey leziz.',
      'Lahmacunları el yapımı ve çok taze.',
      'Döner de çok güzel, kebaplar harika.',
      'Vejetaryen seçenekleri de var.',
    ],
  },
  // İstanbul - Fatih/Sultanahmet
  {
    id: '3',
    name: 'Tarihi Sultanahmet Köftecisi',
    cuisineTypes: ['turkish', 'grill'],
    priceRange: 'moderate' as const,
    address: 'Divanyolu Caddesi No: 12, Sultanahmet',
    city: 'İstanbul',
    district: 'Fatih',
    latitude: 41.0082,
    longitude: 28.9784,
    avgRating: 4.5,
    reviewCount: 1250,
    reviews: [
      'Köfteleri muhteşem, etler taze ve lezzetli.',
      'Piyaz çok güzel, köfteler biraz tuzlu geldi.',
      'Servis hızlı, fiyatlar makul.',
      'Klasik İstanbul lezzeti.',
    ],
  },
  // İstanbul - Beşiktaş
  {
    id: '4',
    name: 'Karadeniz Pide Salonu',
    cuisineTypes: ['turkish', 'pide'],
    priceRange: 'budget' as const,
    address: 'Beşiktaş Çarşı',
    city: 'İstanbul',
    district: 'Beşiktaş',
    latitude: 41.0422,
    longitude: 29.0067,
    avgRating: 4.6,
    reviewCount: 650,
    reviews: [
      'Karadeniz pidesi muhteşem!',
      'Kuşbaşılı pide favorim.',
      'Lahmacun da var ve güzel.',
      'Fiyatlar uygun, lezzet harika.',
    ],
  },
  // İstanbul - Büyükçekmece / Alkent
  {
    id: '5',
    name: 'Alkent Lahmacun Evi',
    cuisineTypes: ['turkish', 'lahmacun'],
    priceRange: 'budget' as const,
    address: 'Alkent 2000 Mahallesi, Büyükçekmece',
    city: 'İstanbul',
    district: 'Büyükçekmece',
    latitude: 41.0195,
    longitude: 28.5831,
    avgRating: 4.4,
    reviewCount: 320,
    reviews: [
      'Mahallede en iyi lahmacun burada.',
      'Lahmacunlar taze ve lezzetli.',
      'Fiyatlar çok uygun.',
      'Ayran da ev yapımı, süper.',
    ],
  },
  {
    id: '6',
    name: 'Büyükçekmece Döner',
    cuisineTypes: ['turkish', 'doner'],
    priceRange: 'budget' as const,
    address: 'Fatih Mahallesi, Büyükçekmece',
    city: 'İstanbul',
    district: 'Büyükçekmece',
    latitude: 41.0210,
    longitude: 28.5750,
    avgRating: 4.3,
    reviewCount: 180,
    reviews: [
      'Döner et kalitesi çok iyi.',
      'İskender porsiyon doyurucu.',
      'Lahmacun da yapıyorlar, fena değil.',
      'Servis biraz yavaş.',
    ],
  },
  {
    id: '7',
    name: 'Mimaroba Pide & Lahmacun',
    cuisineTypes: ['turkish', 'pide', 'lahmacun'],
    priceRange: 'budget' as const,
    address: 'Mimaroba, Büyükçekmece',
    city: 'İstanbul',
    district: 'Büyükçekmece',
    latitude: 41.0150,
    longitude: 28.6100,
    avgRating: 4.5,
    reviewCount: 420,
    reviews: [
      'Lahmacun ince ve çıtır.',
      'Pideleri de çok güzel.',
      'Aile ortamı, temiz mekan.',
      'Fiyat performans harika.',
    ],
  },
  // Ankara
  {
    id: '8',
    name: 'Hacı Arif Bey',
    cuisineTypes: ['turkish', 'kebab'],
    priceRange: 'moderate' as const,
    address: 'Kızılay, Ankara',
    city: 'Ankara',
    district: 'Çankaya',
    latitude: 39.9208,
    longitude: 32.8541,
    avgRating: 4.6,
    reviewCount: 980,
    reviews: [
      'Ankara kebabının en iyisi.',
      'Lahmacun da var, güzel.',
      'Servis kaliteli.',
      'Fiyatlar biraz yüksek.',
    ],
  },
];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { foodQuery, location, radius = 10 } = body;

    if (!foodQuery || !location) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'foodQuery ve location gerekli' },
        { status: 400 }
      );
    }

    console.log('[API] Search request:', { foodQuery, location, radius });

    // Kullanıcı konumuna göre restoranları filtrele
    const nearbyRestaurants = mockRestaurants
      .map((restaurant) => {
        const distance = calculateDistance(
          location.latitude,
          location.longitude,
          restaurant.latitude,
          restaurant.longitude
        );
        return { ...restaurant, distance };
      })
      .filter((r) => r.distance <= radius) // Radius içindekiler
      .sort((a, b) => a.distance - b.distance); // Yakından uzağa sırala

    console.log('[API] Nearby restaurants:', nearbyRestaurants.length);

    if (nearbyRestaurants.length === 0) {
      return NextResponse.json<ApiResponse<SearchResult>>({
        success: true,
        data: {
          query: foodQuery,
          location,
          recommendations: [],
          message: `${radius} km yarıçapında restoran bulunamadı. Daha geniş bir alan deneyin.`,
          searchedAt: new Date(),
        },
      });
    }

    // Analyze each restaurant with AI
    const analyzedRestaurants: RestaurantWithAnalysis[] = await Promise.all(
      nearbyRestaurants.map(async (restaurant) => {
        const analysis = await analyzeReviews(
          restaurant.name,
          foodQuery,
          restaurant.reviews
        );

        return {
          id: restaurant.id,
          name: restaurant.name,
          slug: restaurant.name.toLowerCase().replace(/\s+/g, '-'),
          cuisineTypes: restaurant.cuisineTypes,
          priceRange: restaurant.priceRange,
          address: restaurant.address,
          city: restaurant.city,
          district: restaurant.district,
          latitude: restaurant.latitude,
          longitude: restaurant.longitude,
          avgRating: restaurant.avgRating,
          reviewCount: restaurant.reviewCount,
          distance: Math.round(restaurant.distance * 10) / 10, // 1 decimal
          aiAnalysis: analysis,
        };
      })
    );

    // Sort by AI food score
    const sortedRestaurants = analyzedRestaurants
      .filter((r) => r.aiAnalysis.foodScore > 0)
      .sort((a, b) => b.aiAnalysis.foodScore - a.aiAnalysis.foodScore)
      .slice(0, 5);

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
      { success: false, error: 'Bir hata oluştu' },
      { status: 500 }
    );
  }
}
