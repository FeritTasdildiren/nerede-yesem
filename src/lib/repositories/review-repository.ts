// Review Repository - Database operations for scraped reviews
import { prisma } from '@/lib/db';
import { ScrapedReviewData } from '@/types/scraping';

export interface CreateReviewInput extends ScrapedReviewData {
  restaurantId: string;
  foodKeyword: string;
}

export class ReviewRepository {
  /**
   * Create multiple reviews for a restaurant
   */
  async createMany(reviews: CreateReviewInput[]) {
    return prisma.scrapedReview.createMany({
      data: reviews.map((review) => ({
        restaurantId: review.restaurantId,
        authorName: review.authorName,
        rating: review.rating,
        text: review.text,
        pricePerPerson: review.pricePerPerson,
        relativeTime: review.relativeTime,
        foodKeyword: review.foodKeyword.toLowerCase(),
        matchedKeywords: review.matchedKeywords,
        scrapedAt: new Date(),
      })),
      skipDuplicates: true,
    });
  }

  /**
   * Find reviews by restaurant ID and food keyword
   */
  async findByRestaurantAndKeyword(
    restaurantId: string,
    foodKeyword: string,
    limit: number = 20
  ) {
    return prisma.scrapedReview.findMany({
      where: {
        restaurantId,
        foodKeyword: {
          equals: foodKeyword.toLowerCase(),
          mode: 'insensitive',
        },
      },
      orderBy: {
        scrapedAt: 'desc',
      },
      take: limit,
    });
  }

  /**
   * Find reviews by food keyword across all restaurants
   */
  async findByKeyword(foodKeyword: string, limit: number = 100) {
    return prisma.scrapedReview.findMany({
      where: {
        foodKeyword: {
          equals: foodKeyword.toLowerCase(),
          mode: 'insensitive',
        },
      },
      include: {
        restaurant: true,
      },
      orderBy: {
        scrapedAt: 'desc',
      },
      take: limit,
    });
  }

  /**
   * Delete reviews for a restaurant and keyword (before re-scraping)
   */
  async deleteByRestaurantAndKeyword(restaurantId: string, foodKeyword: string) {
    return prisma.scrapedReview.deleteMany({
      where: {
        restaurantId,
        foodKeyword: {
          equals: foodKeyword.toLowerCase(),
          mode: 'insensitive',
        },
      },
    });
  }

  /**
   * Get review count for a restaurant
   */
  async countByRestaurant(restaurantId: string) {
    return prisma.scrapedReview.count({
      where: { restaurantId },
    });
  }

  /**
   * Get review count by keyword
   */
  async countByKeyword(foodKeyword: string) {
    return prisma.scrapedReview.count({
      where: {
        foodKeyword: {
          equals: foodKeyword.toLowerCase(),
          mode: 'insensitive',
        },
      },
    });
  }

  /**
   * Get average rating for a restaurant by keyword
   */
  async getAverageRatingByKeyword(restaurantId: string, foodKeyword: string) {
    const result = await prisma.scrapedReview.aggregate({
      where: {
        restaurantId,
        foodKeyword: {
          equals: foodKeyword.toLowerCase(),
          mode: 'insensitive',
        },
      },
      _avg: {
        rating: true,
      },
      _count: {
        rating: true,
      },
    });

    return {
      averageRating: result._avg.rating || 0,
      count: result._count.rating,
    };
  }

  /**
   * Get reviews with high ratings (4-5 stars) for a keyword
   */
  async findHighRatedByKeyword(foodKeyword: string, limit: number = 50) {
    return prisma.scrapedReview.findMany({
      where: {
        foodKeyword: {
          equals: foodKeyword.toLowerCase(),
          mode: 'insensitive',
        },
        rating: {
          gte: 4,
        },
      },
      include: {
        restaurant: true,
      },
      orderBy: {
        rating: 'desc',
      },
      take: limit,
    });
  }

  /**
   * Delete old reviews (for cleanup)
   */
  async deleteOlderThan(days: number) {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - days);

    return prisma.scrapedReview.deleteMany({
      where: {
        scrapedAt: {
          lt: threshold,
        },
      },
    });
  }

  /**
   * Get unique food keywords
   */
  async getUniqueKeywords() {
    const result = await prisma.scrapedReview.findMany({
      distinct: ['foodKeyword'],
      select: {
        foodKeyword: true,
      },
    });
    return result.map((r) => r.foodKeyword);
  }
}

export const reviewRepository = new ReviewRepository();
export default reviewRepository;
