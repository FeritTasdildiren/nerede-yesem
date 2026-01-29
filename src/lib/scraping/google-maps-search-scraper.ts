// Google Maps Search Scraper - Scrapes restaurant listings from Google Maps search results
// Uses Puppeteer to load the search results page with 4+ star filter and extract restaurant cards
import puppeteer, { Browser, Page } from 'puppeteer';
import { proxyService } from './proxy-service';
import { Proxy } from '@/types/scraping';
import { env } from '@/lib/config/env';

export interface SearchScrapedRestaurant {
  name: string;
  rating?: number;
  reviewCount?: number;
  address?: string;
  latitude?: number;
  longitude?: number;
  priceLevel?: number;
  googleMapsUrl?: string;
  isSponsored: boolean;
}

export interface SearchScrapeResult {
  success: boolean;
  restaurants: SearchScrapedRestaurant[];
  totalFound: number;
  error?: string;
}

/**
 * Map radius (km) to Google Maps zoom level
 */
function radiusToZoom(radiusKm: number): number {
  if (radiusKm <= 1) return 15;
  if (radiusKm <= 2) return 14;
  if (radiusKm <= 3) return 13;
  if (radiusKm <= 5) return 12;
  return 11; // 10km+
}

/**
 * Build Google Maps search URL with 4+ star filter
 * The data parameter !4m4!2m3!5m1!4e3!6e5 enables the 4+ star filter
 */
function buildSearchUrl(
  locationText: string,
  foodQuery: string,
  latitude: number,
  longitude: number,
  radiusKm: number
): string {
  const zoom = radiusToZoom(radiusKm);
  const query = encodeURIComponent(`${locationText} ${foodQuery}`);
  // !4m4!2m3!5m1!4e3!6e5 = 4+ star filter parameters
  return `https://www.google.com/maps/search/${query}/@${latitude},${longitude},${zoom}z/data=!3m1!1e3!4m4!2m3!5m1!4e3!6e5`;
}

class GoogleMapsSearchScraper {
  private maxResults: number;
  private timeout: number;

  constructor() {
    this.maxResults = env.SEARCH_SCRAPE_MAX_RESULTS;
    this.timeout = env.SCRAPE_TIMEOUT_MS;
  }

  private async initBrowser(proxy?: Proxy): Promise<Browser> {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--lang=tr-TR',
    ];

    if (proxy) {
      args.push(`--proxy-server=${proxy.protocol}://${proxy.address}:${proxy.port}`);
    }

    return puppeteer.launch({
      headless: true,
      args,
      executablePath: '/usr/bin/chromium',
    });
  }

  private async createPage(browser: Browser, proxy?: Proxy): Promise<Page> {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    if (proxy?.username && proxy?.password) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    return page;
  }

  private async acceptCookies(page: Page): Promise<void> {
    try {
      const pageTitle = await page.title();
      if (pageTitle.includes('devam etmeden') || pageTitle.includes('before you continue')) {
        const acceptClicked = await page.evaluate(() => {
          const buttons = document.querySelectorAll('button');
          for (const button of buttons) {
            const text = (button.textContent || '').toLowerCase();
            if (text.includes('tümünü kabul') || text.includes('accept all')) {
              (button as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (acceptClicked) {
          console.log('[SearchScraper] Accepted cookies');
          await this.delay(2000);
          try {
            await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 });
          } catch {
            // Page may update in-place
          }
          await this.delay(2000);
        }
      }
    } catch (error) {
      console.warn('[SearchScraper] Error handling cookies:', error);
    }
  }

  /**
   * Scrape restaurant search results from Google Maps
   */
  async scrapeSearchResults(
    locationText: string,
    foodQuery: string,
    latitude: number,
    longitude: number,
    radiusKm: number
  ): Promise<SearchScrapeResult> {
    let browser: Browser | null = null;
    let proxy: Proxy | null = null;
    const maxProxyAttempts = 10;
    const proxyTimeout = 10000; // 10sn per proxy attempt
    const startTime = Date.now();

    try {
      const searchUrl = buildSearchUrl(locationText, foodQuery, latitude, longitude, radiusKm);
      console.log(`[SearchScraper] Navigating to: ${searchUrl}`);

      // Retry loop: try different proxies until one connects
      let page: Page | null = null;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxProxyAttempts; attempt++) {
        try {
          proxy = await proxyService.getProxy('search-scrape');
          browser = await this.initBrowser(proxy || undefined);
          page = await this.createPage(browser, proxy || undefined);

          console.log(`[SearchScraper] Proxy attempt ${attempt}/${maxProxyAttempts}: ${proxy?.address || 'direct'}`);

          await page.goto(searchUrl, {
            waitUntil: 'networkidle0',
            timeout: proxyTimeout,
          });

          // Success - page loaded
          console.log(`[SearchScraper] Connected via proxy ${proxy?.address} (attempt ${attempt})`);
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          console.warn(`[SearchScraper] Proxy attempt ${attempt} failed (${proxy?.address}): ${lastError.message.substring(0, 80)}`);

          if (proxy) {
            await proxyService.recordUsage({
              proxyAddress: proxy.address,
              tier: proxy.tier,
              targetPlaceId: 'search-scrape',
              success: false,
              responseTimeMs: Date.now() - startTime,
              errorMessage: lastError.message,
            });
          }

          // Close failed browser before retrying
          if (browser) { await browser.close(); browser = null; }
          page = null;

          if (attempt === maxProxyAttempts) {
            throw new Error(`All ${maxProxyAttempts} proxy attempts failed. Last: ${lastError.message}`);
          }
        }
      }

      if (!page || !browser) {
        throw new Error('No page available after proxy attempts');
      }

      await this.delay(3000);
      await this.acceptCookies(page);

      // Wait for search results to load
      try {
        await page.waitForSelector('div[role="feed"], div[class*="m6QErb"]', { timeout: 10000 });
        console.log('[SearchScraper] Search results container found');
      } catch {
        console.log('[SearchScraper] Could not find results container');
        return { success: false, restaurants: [], totalFound: 0, error: 'Results container not found' };
      }

      // Scroll to load more results
      const restaurants = await this.scrollAndCollect(page);

      console.log(`[SearchScraper] Collected ${restaurants.length} restaurants`);

      if (proxy) {
        await proxyService.recordUsage({
          proxyAddress: proxy.address,
          tier: proxy.tier,
          targetPlaceId: 'search-scrape',
          success: true,
          responseTimeMs: Date.now() - startTime,
        });
      }

      return {
        success: true,
        restaurants,
        totalFound: restaurants.length,
      };
    } catch (error) {
      console.error('[SearchScraper] Error:', error);

      return {
        success: false,
        restaurants: [],
        totalFound: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Scroll through search results and collect restaurant data
   */
  private async scrollAndCollect(page: Page): Promise<SearchScrapedRestaurant[]> {
    const allRestaurants: SearchScrapedRestaurant[] = [];
    const seenNames = new Set<string>();
    let scrollAttempts = 0;
    const maxScrolls = 15;
    let noNewCount = 0;

    while (allRestaurants.length < this.maxResults && scrollAttempts < maxScrolls) {
      const newRestaurants = await this.extractRestaurants(page);

      let addedCount = 0;
      for (const r of newRestaurants) {
        // Skip sponsored results
        if (r.isSponsored) continue;

        // Skip duplicates
        const nameKey = r.name.toLowerCase().trim();
        if (seenNames.has(nameKey)) continue;

        seenNames.add(nameKey);
        allRestaurants.push(r);
        addedCount++;

        if (allRestaurants.length >= this.maxResults) break;
      }

      if (addedCount === 0) {
        noNewCount++;
        if (noNewCount >= 3) {
          console.log('[SearchScraper] No new results after 3 scrolls, stopping');
          break;
        }
      } else {
        noNewCount = 0;
      }

      // Scroll the results feed
      await page.evaluate(() => {
        const feedSelectors = [
          'div[role="feed"]',
          'div[class*="m6QErb"][class*="DxyBCb"]',
          'div[class*="m6QErb"]',
        ];
        for (const selector of feedSelectors) {
          const feed = document.querySelector(selector);
          if (feed && feed.scrollHeight > feed.clientHeight) {
            feed.scrollTop = feed.scrollHeight;
            return;
          }
        }
      });

      await this.delay(2000);
      scrollAttempts++;
      console.log(`[SearchScraper] Scroll ${scrollAttempts}: ${allRestaurants.length} restaurants collected`);
    }

    return allRestaurants;
  }

  /**
   * Extract restaurant data from currently visible search result cards
   */
  private async extractRestaurants(page: Page): Promise<SearchScrapedRestaurant[]> {
    return page.evaluate(() => {
      const results: Array<{
        name: string;
        rating?: number;
        reviewCount?: number;
        address?: string;
        latitude?: number;
        longitude?: number;
        priceLevel?: number;
        googleMapsUrl?: string;
        isSponsored: boolean;
      }> = [];

      // Find all restaurant card elements
      const cardSelectors = [
        'div[class*="Nv2PK"]',    // Main result card class
        'a[class*="hfpxzc"]',     // Link-based cards
      ];

      let cards: NodeListOf<Element> | null = null;
      for (const selector of cardSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          cards = elements;
          break;
        }
      }

      if (!cards) return results;

      cards.forEach((card) => {
        try {
          // Check if sponsored
          const cardText = card.textContent || '';
          const isSponsored =
            cardText.includes('Sponsorlu') ||
            cardText.includes('Sponsored') ||
            cardText.includes('Ad ·') ||
            !!card.querySelector('[data-text="Sponsorlu"], [data-text="Sponsored"]');

          // Name
          let name = '';
          const nameSelectors = [
            'div[class*="qBF1Pd"]',
            'span[class*="fontHeadlineSmall"]',
            'div[class*="fontHeadlineSmall"]',
            'a[aria-label]',
          ];
          for (const sel of nameSelectors) {
            const el = card.querySelector(sel);
            if (el) {
              name = el.textContent?.trim() || el.getAttribute('aria-label')?.trim() || '';
              if (name) break;
            }
          }

          // If card is an anchor element, try aria-label
          if (!name && card.tagName === 'A') {
            name = card.getAttribute('aria-label') || '';
          }

          if (!name) return;

          // Rating from star image aria-label
          let rating: number | undefined;
          const ratingEl = card.querySelector('span[role="img"][aria-label]');
          if (ratingEl) {
            const label = ratingEl.getAttribute('aria-label') || '';
            // Matches "4,5 yıldız" or "4.5 stars"
            const match = label.match(/([\d,\.]+)\s*(yıldız|star)/i);
            if (match) {
              rating = parseFloat(match[1].replace(',', '.'));
            }
          }

          // Review count
          let reviewCount: number | undefined;
          const reviewSelectors = [
            'span[class*="UY7F9"]',
            'span[class*="e4rVHe"]',
          ];
          for (const sel of reviewSelectors) {
            const el = card.querySelector(sel);
            if (el?.textContent) {
              const text = el.textContent.trim();
              // Match "(1.234)" or "(1234)"
              const match = text.match(/\(?([\d.,]+)\)?/);
              if (match) {
                reviewCount = parseInt(match[1].replace(/[.,]/g, ''), 10);
                break;
              }
            }
          }

          // Address
          let address: string | undefined;
          // Address is usually in spans after the rating section
          const textSpans = card.querySelectorAll('span, div[class*="W4Efsd"]');
          for (const span of textSpans) {
            const text = (span.textContent || '').trim();
            // Address typically contains street info, district names, etc.
            if (text.length > 10 && text.length < 200 &&
                !text.includes('yıldız') && !text.includes('star') &&
                !text.includes('Sponsorlu') && !text.includes('Açık') &&
                !text.includes('Kapalı') && !text.match(/^\([\d.,]+\)$/)) {
              // Check if it looks like an address (contains comma or district-like words)
              if (text.includes(',') || text.includes('Mah') || text.includes('Cad') ||
                  text.includes('Sok') || text.includes('No')) {
                address = text;
                break;
              }
            }
          }

          // Lat/Lng from link URL
          let latitude: number | undefined;
          let longitude: number | undefined;
          let googleMapsUrl: string | undefined;

          // Find the link element
          const link = card.tagName === 'A' ? card : card.querySelector('a[href*="google.com/maps"]');
          if (link) {
            const href = link.getAttribute('href') || '';
            googleMapsUrl = href;
            // Parse coordinates from /@LAT,LNG,ZOOMz/
            const coordMatch = href.match(/@(-?[\d.]+),(-?[\d.]+)/);
            if (coordMatch) {
              latitude = parseFloat(coordMatch[1]);
              longitude = parseFloat(coordMatch[2]);
            }
          }

          // Price level (count of currency symbols)
          let priceLevel: number | undefined;
          const priceText = cardText;
          // Look for consecutive ₺ symbols
          const priceMatch = priceText.match(/(₺{1,4})/);
          if (priceMatch) {
            priceLevel = priceMatch[1].length;
          }

          results.push({
            name,
            rating,
            reviewCount,
            address,
            latitude,
            longitude,
            priceLevel,
            googleMapsUrl,
            isSponsored,
          });
        } catch {
          // Skip malformed cards
        }
      });

      return results;
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const googleMapsSearchScraper = new GoogleMapsSearchScraper();
export default googleMapsSearchScraper;
