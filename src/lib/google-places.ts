// Google Places API Service

export interface PlaceResult {
  place_id: string;
  name: string;
  formatted_address: string;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
  rating?: number;
  user_ratings_total?: number;
  price_level?: number;
  types?: string[];
  opening_hours?: {
    open_now?: boolean;
  };
  photos?: Array<{
    photo_reference: string;
  }>;
}

interface PlaceDetails {
  place_id: string;
  name: string;
  formatted_address: string;
  formatted_phone_number?: string;
  website?: string;
  rating?: number;
  user_ratings_total?: number;
  price_level?: number;
  reviews?: Array<{
    author_name: string;
    rating: number;
    text: string;
    time: number;
    relative_time_description: string;
  }>;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
  url?: string; // Google Maps URL
}

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

export async function searchNearbyRestaurants(
  latitude: number,
  longitude: number,
  keyword: string,
  radius: number = 2000 // meters (default 2km)
): Promise<PlaceResult[]> {
  if (!GOOGLE_PLACES_API_KEY) {
    throw new Error('Google Places API key is not configured');
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
  url.searchParams.set('location', `${latitude},${longitude}`);
  url.searchParams.set('radius', radius.toString());
  url.searchParams.set('type', 'restaurant');
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('language', 'tr');
  url.searchParams.set('key', GOOGLE_PLACES_API_KEY);

  const response = await fetch(url.toString());
  const data = await response.json();

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    console.error('Google Places API error:', data.status, data.error_message);
    throw new Error(`Google Places API error: ${data.status}`);
  }

  // Sort by rating * review count (prominence score) to get best results
  const results = data.results || [];
  return results.sort((a: PlaceResult, b: PlaceResult) => {
    const scoreA = (a.rating || 0) * Math.log10((a.user_ratings_total || 1) + 1);
    const scoreB = (b.rating || 0) * Math.log10((b.user_ratings_total || 1) + 1);
    return scoreB - scoreA;
  });
}

export async function getPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
  if (!GOOGLE_PLACES_API_KEY) {
    throw new Error('Google Places API key is not configured');
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'place_id,name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,price_level,reviews,geometry,url');
  url.searchParams.set('language', 'tr');
  url.searchParams.set('reviews_sort', 'newest');
  url.searchParams.set('key', GOOGLE_PLACES_API_KEY);

  const response = await fetch(url.toString());
  const data = await response.json();

  if (data.status !== 'OK') {
    console.error('Google Places Details API error:', data.status, data.error_message, 'for placeId:', placeId);
    return null;
  }

  return data.result;
}

export function getPriceRangeFromLevel(priceLevel?: number): 'budget' | 'moderate' | 'expensive' | 'luxury' {
  switch (priceLevel) {
    case 0:
    case 1:
      return 'budget';
    case 2:
      return 'moderate';
    case 3:
      return 'expensive';
    case 4:
      return 'luxury';
    default:
      return 'moderate';
  }
}

export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in km
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
