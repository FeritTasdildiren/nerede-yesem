// Common Types for Nerede Yesem?

export interface Location {
  latitude: number;
  longitude: number;
}

export interface SearchFilters {
  foodQuery: string;
  location: Location;
  radius?: number; // km, default 5
  minReviews?: number; // default 50
  priceRange?: PriceRange[];
}

export type PriceRange = 'budget' | 'moderate' | 'expensive' | 'luxury';

export interface Restaurant {
  id: string;
  name: string;
  slug: string;
  description?: string;
  cuisineTypes: string[];
  priceRange: PriceRange;
  address: string;
  city: string;
  district?: string;
  latitude: number;
  longitude: number;
  phone?: string;
  website?: string;
  avgRating: number;
  reviewCount: number;
  coverImage?: string;
  distance?: number; // calculated
}

export interface RestaurantWithAnalysis extends Restaurant {
  aiAnalysis: {
    foodScore: number;
    positivePoints: string[];
    negativePoints: string[];
    isRecommended: boolean;
    summary: string;
  };
}

export interface SearchResult {
  query: string;
  location: Location;
  recommendations: RestaurantWithAnalysis[];
  message: string;
  searchedAt: Date;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  preferences: UserPreferences;
}

export interface UserPreferences {
  cuisines: string[];
  priceRange: PriceRange[];
  notifications: boolean;
}
