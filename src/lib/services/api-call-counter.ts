// API Call Counter - Monthly Google Places API call tracking via SystemSetting table
import { prisma } from '@/lib/db';
import { env } from '@/lib/config/env';

const COUNT_KEY = 'api_call_count';
const MONTH_KEY = 'api_call_month';

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

class ApiCallCounter {
  private monthlyLimit: number;

  constructor() {
    this.monthlyLimit = env.GOOGLE_API_MONTHLY_LIMIT;
  }

  /**
   * Check if we can make another API call this month
   */
  async canMakeCall(): Promise<boolean> {
    try {
      const currentMonth = getCurrentMonth();

      // Get stored month
      const monthSetting = await prisma.systemSetting.findUnique({
        where: { key: MONTH_KEY },
      });

      // If month changed, reset counter
      if (!monthSetting || monthSetting.value !== currentMonth) {
        await this.resetCounter(currentMonth);
        return true;
      }

      // Get current count
      const countSetting = await prisma.systemSetting.findUnique({
        where: { key: COUNT_KEY },
      });

      const currentCount = countSetting ? parseInt(countSetting.value, 10) : 0;
      return currentCount < this.monthlyLimit;
    } catch (error) {
      console.error('[ApiCallCounter] Error checking call limit:', error);
      // On DB error, skip API calls (safe side)
      return false;
    }
  }

  /**
   * Increment the API call counter
   */
  async increment(): Promise<void> {
    try {
      const currentMonth = getCurrentMonth();

      // Ensure month is current
      const monthSetting = await prisma.systemSetting.findUnique({
        where: { key: MONTH_KEY },
      });

      if (!monthSetting || monthSetting.value !== currentMonth) {
        await this.resetCounter(currentMonth);
      }

      // Read current count, then increment
      const countSetting = await prisma.systemSetting.findUnique({
        where: { key: COUNT_KEY },
      });
      const currentCount = countSetting ? parseInt(countSetting.value, 10) : 0;

      await prisma.systemSetting.upsert({
        where: { key: COUNT_KEY },
        update: { value: String(currentCount + 1) },
        create: {
          key: COUNT_KEY,
          value: '1',
          description: 'Monthly Google Places API call count',
        },
      });
    } catch (error) {
      console.error('[ApiCallCounter] Error incrementing counter:', error);
    }
  }

  /**
   * Reset the counter for a new month
   */
  private async resetCounter(month: string): Promise<void> {
    await prisma.systemSetting.upsert({
      where: { key: MONTH_KEY },
      update: { value: month },
      create: {
        key: MONTH_KEY,
        value: month,
        description: 'Current month for API call tracking (YYYY-MM)',
      },
    });

    await prisma.systemSetting.upsert({
      where: { key: COUNT_KEY },
      update: { value: '0' },
      create: {
        key: COUNT_KEY,
        value: '0',
        description: 'Monthly Google Places API call count',
      },
    });

    console.log(`[ApiCallCounter] Counter reset for month: ${month}`);
  }

  /**
   * Get current usage stats
   */
  async getStats(): Promise<{ count: number; limit: number; month: string }> {
    try {
      const countSetting = await prisma.systemSetting.findUnique({
        where: { key: COUNT_KEY },
      });
      const monthSetting = await prisma.systemSetting.findUnique({
        where: { key: MONTH_KEY },
      });

      return {
        count: countSetting ? parseInt(countSetting.value, 10) : 0,
        limit: this.monthlyLimit,
        month: monthSetting?.value || getCurrentMonth(),
      };
    } catch {
      return { count: 0, limit: this.monthlyLimit, month: getCurrentMonth() };
    }
  }
}

export const apiCallCounter = new ApiCallCounter();
export default apiCallCounter;
