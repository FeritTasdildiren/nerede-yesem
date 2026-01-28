// Restaurant Repository - Database operations for scraped restaurants
import { prisma } from '@/lib/db';
import { ScrapedRestaurantData } from '@/types/scraping';

export class RestaurantRepository {
  /**
   * Find a scraped restaurant by Google Place ID
   */
  async findByPlaceId(googlePlaceId: string) {
    return prisma.scrapedRestaurant.findUnique({
      where: { googlePlaceId },
      include: {
        reviews: true,
      },
    });
  }

  /**
   * Create or update a scraped restaurant
   */
  async upsert(data: ScrapedRestaurantData) {
    return prisma.scrapedRestaurant.upsert({
      where: { googlePlaceId: data.googlePlaceId },
      update: {
        name: data.name,
        formattedAddress: data.formattedAddress,
        latitude: data.latitude,
        longitude: data.longitude,
        rating: data.rating,
        totalReviews: data.totalReviews,
        priceLevel: data.priceLevel,
        phone: data.phone,
        website: data.website,
        googleMapsUrl: data.googleMapsUrl,
        lastRefreshAt: new Date(),
      },
      create: {
        googlePlaceId: data.googlePlaceId,
        name: data.name,
        formattedAddress: data.formattedAddress,
        latitude: data.latitude,
        longitude: data.longitude,
        rating: data.rating,
        totalReviews: data.totalReviews,
        priceLevel: data.priceLevel,
        phone: data.phone,
        website: data.website,
        googleMapsUrl: data.googleMapsUrl,
        scrapedAt: new Date(),
      },
    });
  }

  /**
   * Get restaurants by IDs
   */
  async findByIds(ids: string[]) {
    return prisma.scrapedRestaurant.findMany({
      where: {
        id: { in: ids },
      },
      include: {
        reviews: true,
      },
    });
  }

  /**
   * Get restaurants by Google Place IDs
   */
  async findByPlaceIds(placeIds: string[]) {
    return prisma.scrapedRestaurant.findMany({
      where: {
        googlePlaceId: { in: placeIds },
      },
      include: {
        reviews: true,
      },
    });
  }

  /**
   * Get restaurants that need refresh (older than specified days)
   */
  async findStaleRestaurants(olderThanDays: number, limit: number = 10) {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - olderThanDays);

    return prisma.scrapedRestaurant.findMany({
      where: {
        OR: [
          { lastRefreshAt: null },
          { lastRefreshAt: { lt: threshold } },
        ],
      },
      orderBy: {
        lastRefreshAt: 'asc',
      },
      take: limit,
    });
  }

  /**
   * Delete a restaurant and its reviews
   */
  async delete(id: string) {
    return prisma.scrapedRestaurant.delete({
      where: { id },
    });
  }

  /**
   * Get restaurant count
   */
  async count() {
    return prisma.scrapedRestaurant.count();
  }

  /**
   * Get restaurants with reviews for a specific food keyword
   */
  async findWithReviewsByKeyword(keyword: string, limit: number = 20) {
    return prisma.scrapedRestaurant.findMany({
      where: {
        reviews: {
          some: {
            foodKeyword: {
              equals: keyword.toLowerCase(),
              mode: 'insensitive',
            },
          },
        },
      },
      include: {
        reviews: {
          where: {
            foodKeyword: {
              equals: keyword.toLowerCase(),
              mode: 'insensitive',
            },
          },
          orderBy: {
            scrapedAt: 'desc',
          },
        },
      },
      take: limit,
    });
  }
}

export const restaurantRepository = new RestaurantRepository();
export default restaurantRepository;
