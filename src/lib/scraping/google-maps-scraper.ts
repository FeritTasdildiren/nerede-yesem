// Google Maps Scraper - Puppeteer-based review scraping with keyword filtering
import puppeteer, { Browser, Page } from 'puppeteer';
import { env } from '@/lib/config/env';
import { proxyService } from './proxy-service';
import { restaurantRepository } from '@/lib/repositories/restaurant-repository';
import { reviewRepository } from '@/lib/repositories/review-repository';
import {
  ScrapeResult,
  ScrapeOptions,
  ScrapedReviewData,
  ScrapedRestaurantData,
  Proxy,
} from '@/types/scraping';

export class GoogleMapsScraper {
  private maxReviews: number;
  private timeout: number;

  constructor() {
    this.maxReviews = env.MAX_REVIEWS_PER_RESTAURANT;
    this.timeout = env.SCRAPE_TIMEOUT_MS;
  }

  /**
   * Initialize browser instance
   */
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

    const browser = await puppeteer.launch({
      headless: true,
      args,
      executablePath: '/usr/bin/chromium',
    });

    return browser;
  }

  /**
   * Create a new page with stealth settings
   */
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

  /**
   * Build reviews page URL from place_id
   * Use Google Maps search API with query_place_id for reliable navigation
   */
  private buildReviewsUrl(googleMapsUrl: string, placeId?: string): string {
    // If we have a proper place_id, use the search API format
    if (placeId && placeId.startsWith('ChIJ')) {
      return `https://www.google.com/maps/place/?q=place_id:${placeId}`;
    }

    // If URL already has reviews tab indicator, return as is
    if (googleMapsUrl.includes('!1b1')) {
      return googleMapsUrl;
    }

    // Extract place info and add reviews tab
    // Format: https://www.google.com/maps/place/NAME/@LAT,LNG,ZOOM/data=...!1b1
    if (googleMapsUrl.includes('/place/')) {
      // Add reviews tab parameter
      if (googleMapsUrl.includes('/data=')) {
        return googleMapsUrl.replace('/data=', '/data=!3m1!1b1!');
      }
    }

    return googleMapsUrl;
  }

  /**
   * Scrape reviews for a restaurant with keyword filtering
   */
  async scrapeReviews(
    googleMapsUrl: string,
    placeId: string,
    options: ScrapeOptions
  ): Promise<ScrapeResult> {
    const startTime = Date.now();
    let proxy: Proxy | null = null;
    let browser: Browser | null = null;
    const maxProxyAttempts = 10;
    const proxyTimeout = 10000; // 10sn per proxy attempt

    try {
      const reviewsUrl = this.buildReviewsUrl(googleMapsUrl, placeId);

      // Retry loop: try different proxies until one connects
      let page: Page | null = null;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxProxyAttempts; attempt++) {
        try {
          proxy = await proxyService.getProxy(placeId, 'high');
          browser = await this.initBrowser(proxy || undefined);
          page = await this.createPage(browser, proxy || undefined);

          console.log(`[Scraper] Proxy attempt ${attempt}/${maxProxyAttempts}: ${proxy?.address || 'direct'} → ${reviewsUrl}`);

          await page.goto(reviewsUrl, {
            waitUntil: 'networkidle0',
            timeout: proxyTimeout,
          });

          // Success - page loaded
          console.log(`[Scraper] Connected via proxy ${proxy?.address} (attempt ${attempt})`);
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          console.warn(`[Scraper] Proxy attempt ${attempt} failed (${proxy?.address}): ${lastError.message.substring(0, 80)}`);

          if (proxy) {
            await proxyService.recordUsage({
              proxyAddress: proxy.address,
              tier: proxy.tier,
              targetPlaceId: placeId,
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

      // Accept cookies if prompted
      await this.acceptCookies(page);

      const pageTitle = await page.title();
      console.log(`[Scraper] Page title: ${pageTitle}`);

      // Wait for place to load
      try {
        await page.waitForSelector('div[role="main"]', { timeout: 5000 });
        console.log('[Scraper] Main content loaded');
      } catch {
        console.log('[Scraper] Could not find main content');
      }

      // Click reviews tab
      await this.clickReviewsTab(page);
      await this.delay(2000);

      // Wait for reviews to load
      try {
        await page.waitForSelector('div[class*="m6QErb"], div[data-review-id], div[role="main"]', { timeout: 5000 });
        console.log('[Scraper] Reviews section found');
      } catch {
        console.log('[Scraper] Could not find reviews section - taking screenshot');
        await page.screenshot({ path: `/tmp/debug-${placeId}.png`, fullPage: true });
      }

      // Search for keyword in reviews
      const searchSuccess = await this.searchInReviews(page, options.foodKeyword);
      if (searchSuccess) {
        await this.delay(3000);
      }

      // Sort by newest
      await this.sortByNewest(page);
      await this.delay(2000);

      // Collect reviews
      const reviews = await this.collectReviews(page, options);

      // Get restaurant info
      const restaurantData = await this.extractRestaurantInfo(page, placeId);

      if (proxy) {
        await proxyService.recordUsage({
          proxyAddress: proxy.address,
          tier: proxy.tier,
          targetPlaceId: placeId,
          success: true,
          responseTimeMs: Date.now() - startTime,
        });
      }

      return {
        success: true,
        restaurant: restaurantData,
        reviews,
        scrapedAt: new Date(),
        proxyUsed: proxy?.address,
      };
    } catch (error) {
      console.error('[Scraper] Error:', error);

      return {
        success: false,
        reviews: [],
        error: error instanceof Error ? error.message : 'Unknown error',
        scrapedAt: new Date(),
        proxyUsed: proxy?.address,
      };
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Accept cookies if the dialog appears
   */
  private async acceptCookies(page: Page): Promise<void> {
    try {
      // Check if we're on the consent page by looking for the title or buttons
      const pageTitle = await page.title();
      console.log(`[Scraper] Checking for consent dialog, page title: ${pageTitle}`);

      // If we see the consent page title, we need to accept cookies
      if (pageTitle.includes('devam etmeden') || pageTitle.includes('before you continue')) {
        console.log('[Scraper] Consent dialog detected, attempting to accept...');

        // Try to find and click the "Accept all" button
        // In Turkish: "Tümünü kabul et"
        const acceptClicked = await page.evaluate(() => {
          // Look for buttons with "kabul" or "accept" text
          const buttons = document.querySelectorAll('button');
          for (const button of buttons) {
            const text = (button.textContent || '').toLowerCase();
            // "Tümünü kabul et" = Accept all
            if (text.includes('tümünü kabul') || text.includes('accept all')) {
              (button as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (acceptClicked) {
          console.log('[Scraper] Clicked accept all button');
          await this.delay(2000);

          // Wait for navigation to complete
          try {
            await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 });
            console.log('[Scraper] Navigation after consent completed');
          } catch {
            console.log('[Scraper] No navigation after consent (page might have updated in-place)');
          }

          await this.delay(2000);
          return;
        }

        // Alternative: try clicking any form submission button
        const formClicked = await page.evaluate(() => {
          const form = document.querySelector('form');
          if (form) {
            const submitBtn = form.querySelector('button[type="submit"], button:not([type="button"])');
            if (submitBtn) {
              (submitBtn as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (formClicked) {
          console.log('[Scraper] Clicked form submit button');
          await this.delay(2000);
        }
      }
    } catch (error) {
      console.warn('[Scraper] Error handling cookies:', error);
    }
  }

  /**
   * Click on the reviews tab and open full reviews panel
   */
  private async clickReviewsTab(page: Page): Promise<void> {
    try {
      console.log('[Scraper] Looking for Yorumlar tab...');

      // Method 1: Try XPath for Yorumlar tab (user-provided)
      const yorumlarXPath = '/html/body/div[1]/div[2]/div[9]/div[8]/div/div/div[1]/div[2]/div/div[1]/div/div/div[3]/div/div[1]/button[3]';

      let clickedTab = await page.evaluate((xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const element = result.singleNodeValue as HTMLElement | null;
        if (element) {
          element.click();
          return 'yorumlar-xpath';
        }
        return null;
      }, yorumlarXPath);

      if (clickedTab) {
        console.log(`[Scraper] Clicked Yorumlar tab via XPath`);
        await this.delay(3000);
      }

      // Method 2: Try CSS selector for tab buttons
      if (!clickedTab) {
        clickedTab = await page.evaluate(() => {
          // Look for tab buttons with "Yorumlar" text
          const buttons = document.querySelectorAll('button[role="tab"], button');
          for (const btn of buttons) {
            const text = (btn.textContent || '').toLowerCase().trim();
            // Match "Yorumlar" or buttons containing review count like "1.234 yorum"
            if (text === 'yorumlar' || text === 'reviews' ||
                /^\d[\d.,]*\s*yorum/i.test(text) ||
                /yorumlar$/i.test(text)) {
              (btn as HTMLElement).click();
              return 'yorumlar-button';
            }
          }
          return null;
        });

        if (clickedTab) {
          console.log(`[Scraper] Clicked Yorumlar button: ${clickedTab}`);
          await this.delay(3000);
        }
      }

      // Method 3: Fallback - click on review count text
      if (!clickedTab) {
        clickedTab = await page.evaluate(() => {
          const spans = document.querySelectorAll('span, div');
          for (const el of spans) {
            const text = (el.textContent || '').trim();
            if (/^\d[\d.,]*\s*(yorum|review)/i.test(text)) {
              const parent = el.closest('button, a, [role="button"]') || el;
              (parent as HTMLElement).click();
              return 'review-count';
            }
          }
          return null;
        });

        if (clickedTab) {
          console.log(`[Scraper] Clicked review count: ${clickedTab}`);
          await this.delay(3000);
        }
      }

      // Wait for reviews section to load
      await this.delay(2000);

      // Check if we're now in the reviews section with search input
      const hasSearchInput = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input');
        for (const input of inputs) {
          const placeholder = (input.placeholder || '').toLowerCase();
          const label = (input.getAttribute('aria-label') || '').toLowerCase();
          if (placeholder.includes('ara') || placeholder.includes('search') ||
              label.includes('ara') || label.includes('search') ||
              label.includes('yorum')) {
            console.log('Found search input:', placeholder, label);
            return true;
          }
        }
        return false;
      });

      if (hasSearchInput) {
        console.log('[Scraper] Full reviews panel with search input found');
      } else {
        console.log('[Scraper] No search input visible yet');
        // Debug: list all inputs
        const inputs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('input')).map(i => ({
            placeholder: i.placeholder,
            ariaLabel: i.getAttribute('aria-label'),
            type: i.type
          }));
        });
        console.log(`[Scraper] Available inputs: ${JSON.stringify(inputs.slice(0, 5))}`);
      }
    } catch (error) {
      console.warn('[Scraper] Could not click reviews tab:', error);
    }
  }

  /**
   * Search for keyword in reviews
   */
  private async searchInReviews(page: Page, keyword: string): Promise<boolean> {
    try {
      console.log(`[Scraper] Looking for search input to search for: ${keyword}`);

      // Try XPath first (most reliable based on user-provided path)
      const searchXPath = '/html/body/div[1]/div[2]/div[9]/div[8]/div/div/div[1]/div[2]/div/div[1]/div/div/div[4]/div[9]/input';

      // Use evaluate with XPath
      const foundXPath = await page.evaluate((xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const element = result.singleNodeValue as HTMLInputElement | null;
        if (element) {
          element.focus();
          element.click();
          return true;
        }
        return false;
      }, searchXPath);

      if (foundXPath) {
        console.log('[Scraper] Found search input via XPath');
        await this.delay(300);
        await page.keyboard.type(keyword, { delay: 50 });
        await this.delay(500);
        await page.keyboard.press('Enter');
        console.log(`[Scraper] Searched for: ${keyword}`);
        return true;
      }

      // Fallback: Try CSS selectors
      const searchSelectors = [
        'input[aria-label="Yorumlarda ara"]',
        'input[aria-label="Yorumlarda arayın"]',
        'input[aria-label*="Yorumlarda"]',
        'input[aria-label="Search reviews"]',
        'div[class*="m6QErb"] input',
        'input[placeholder*="ara"]',
      ];

      let searchInput = null;
      for (const selector of searchSelectors) {
        searchInput = await page.$(selector);
        if (searchInput) {
          console.log(`[Scraper] Found search input with CSS selector: ${selector}`);
          break;
        }
      }

      if (searchInput) {
        await searchInput.click();
        await this.delay(300);
        await page.keyboard.type(keyword, { delay: 50 });
        await this.delay(500);
        await page.keyboard.press('Enter');
        console.log(`[Scraper] Searched for: ${keyword}`);
        return true;
      }

      console.log('[Scraper] Search input not found - will scrape all reviews without keyword filter');
      return false;
    } catch (error) {
      console.warn('[Scraper] Search failed:', error);
      return false;
    }
  }

  /**
   * Sort reviews by newest
   */
  private async sortByNewest(page: Page): Promise<void> {
    try {
      console.log('[Scraper] Looking for sort dropdown...');

      // Try XPath first (most reliable based on user-provided path)
      const sortXPath = '/html/body/div[1]/div[2]/div[9]/div[8]/div/div/div[1]/div[2]/div/div[1]/div/div/div[4]/div[10]/button';

      // Use evaluate with XPath
      const foundXPath = await page.evaluate((xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const element = result.singleNodeValue as HTMLElement | null;
        if (element) {
          element.click();
          return true;
        }
        return false;
      }, sortXPath);

      if (foundXPath) {
        console.log('[Scraper] Found sort dropdown via XPath');
        await this.delay(1000);

        // Click "En yeni" option
        const clicked = await page.evaluate(() => {
          const items = document.querySelectorAll('div[role="menuitemradio"], li[role="menuitemradio"], div[role="option"], div[data-index]');
          for (const item of items) {
            const text = (item.textContent || '').toLowerCase();
            if (text.includes('en yeni') || text.includes('newest')) {
              (item as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (clicked) {
          console.log('[Scraper] Sorted by newest');
          return;
        }

        // Fallback: use keyboard
        await page.keyboard.press('ArrowDown');
        await this.delay(200);
        await page.keyboard.press('Enter');
        console.log('[Scraper] Sorted by newest (keyboard)');
        return;
      }

      // Fallback: Try CSS selectors for sort button
      const sortButton = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('en alakalı') || text.includes('most relevant') ||
              text.includes('sırala') || text.includes('sort')) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (sortButton) {
        console.log('[Scraper] Clicked sort dropdown via CSS');
        await this.delay(1000);

        const clicked = await page.evaluate(() => {
          const items = document.querySelectorAll('div[role="menuitemradio"], li[role="menuitemradio"], div[role="option"]');
          for (const item of items) {
            const text = (item.textContent || '').toLowerCase();
            if (text.includes('en yeni') || text.includes('newest')) {
              (item as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (clicked) {
          console.log('[Scraper] Sorted by newest');
        } else {
          await page.keyboard.press('ArrowDown');
          await this.delay(200);
          await page.keyboard.press('Enter');
          console.log('[Scraper] Sorted (keyboard fallback)');
        }
      } else {
        console.log('[Scraper] Sort button not found - using default sort order');
      }
    } catch (error) {
      console.warn('[Scraper] Sort failed:', error);
    }
  }

  /**
   * Collect reviews by scrolling
   */
  private async collectReviews(
    page: Page,
    options: ScrapeOptions
  ): Promise<ScrapedReviewData[]> {
    const reviews: ScrapedReviewData[] = [];
    const maxReviews = options.maxReviews || this.maxReviews;
    let scrollAttempts = 0;
    const maxScrollAttempts = 10;
    let lastReviewCount = 0;
    let noNewReviewsCount = 0;

    // Debug: Log available review-like elements
    const debugInfo = await page.evaluate(() => {
      const info: string[] = [];
      info.push(`HTML length: ${document.body.innerHTML.length}`);
      const reviewsContainer = document.querySelector('div[class*="m6QErb"][class*="DxyBCb"]') ||
                               document.querySelector('div[class*="m6QErb"]');
      info.push(`Reviews container: ${reviewsContainer ? `yes (${reviewsContainer.children.length} children)` : 'no'}`);
      // Count spans with role="img" (old method)
      const roleImgSpans = document.querySelectorAll('span[role="img"][aria-label*="yıldız"]');
      info.push(`Star spans (role=img): ${roleImgSpans.length}`);
      // Count spans with exactly 5 child spans (structural star detection)
      let fiveChildSpans = 0;
      document.querySelectorAll('span').forEach(span => {
        if (span.children.length === 5 && Array.from(span.children).every(c => c.tagName === 'SPAN')) {
          fiveChildSpans++;
        }
      });
      info.push(`Star spans (5-child): ${fiveChildSpans}`);
      // Count Diğer buttons
      let digerCount = 0;
      document.querySelectorAll('button, span').forEach(el => {
        if ((el.textContent || '').trim() === 'Diğer' || (el.textContent || '').trim() === 'More') digerCount++;
      });
      info.push(`Diğer buttons: ${digerCount}`);
      // Trace DOM structure from star span upward to understand nesting
      if (reviewsContainer && fiveChildSpans > 0) {
        const allSpans = document.querySelectorAll('span');
        for (const span of allSpans) {
          if (span.children.length === 5 && Array.from(span.children).every(c => c.tagName === 'SPAN')) {
            // Walk up from star span and log each level
            const p1 = span.parentElement;
            const p2 = p1?.parentElement;
            const p3 = p2?.parentElement;
            const p4 = p3?.parentElement;
            const p5 = p4?.parentElement;
            info.push(`Up from star: ${p5?.tagName}(${p5?.children.length}ch) > ${p4?.tagName}(${p4?.children.length}ch) > ${p3?.tagName}(${p3?.children.length}ch) > ${p2?.tagName}(${p2?.children.length}ch) > ${p1?.tagName}(${p1?.children.length}ch) > SPAN(5ch)`);
            // Check if any of these is a direct child of container
            const containerChildren = Array.from(reviewsContainer.children);
            const directChild = [p5, p4, p3, p2, p1].findIndex(p => p ? containerChildren.includes(p) : false);
            info.push(`Direct child of container at level: p${directChild + 1} (0=p5/card, counted from star)`);
            break;
          }
        }
      }
      return info;
    });
    console.log('[Scraper] Debug info:', debugInfo.join(', '));

    while (reviews.length < maxReviews && scrollAttempts < maxScrollAttempts) {
      // Expand all "Diğer" (More) buttons first
      await this.expandReviews(page);

      // Extract reviews using structural DOM approach
      // Based on XPath: .../div[N]/div/div/div[4]/div[1]/span[1] (star container with 5 child spans)
      const newReviews = await page.evaluate(() => {
        const extracted: Array<{
          authorName: string;
          rating: number;
          text: string;
          relativeTime?: string;
          pricePerPerson?: string;
        }> = [];

        // Find the reviews scrollable container
        const container = document.querySelector('div[class*="m6QErb"][class*="DxyBCb"]') ||
                          document.querySelector('div[class*="m6QErb"]');
        if (!container) return extracted;

        // Strategy: Find all star containers (span with 5 child spans) inside container,
        // then walk UP from each to find the review card and extract data.
        // This avoids rigid top-down traversal that breaks with varying nesting depths.
        const starContainers: Element[] = [];
        container.querySelectorAll('span').forEach(span => {
          if (span.children.length === 5 &&
              Array.from(span.children).every(c => c.tagName === 'SPAN')) {
            starContainers.push(span);
          }
        });

        for (const starContainer of starContainers) {
          try {
            // Walk up from star to find the review card (direct child of container)
            let reviewCard: HTMLElement | null = null;
            let current: HTMLElement | null = starContainer as HTMLElement;
            for (let d = 0; d < 15 && current; d++) {
              if (current.parentElement === container) {
                reviewCard = current;
                break;
              }
              current = current.parentElement;
            }
            if (!reviewCard) continue;

            // --- Rating ---
            let rating = 0;
            // Method 1: aria-label on star container or its parent
            const starLabel = starContainer.getAttribute('aria-label') ||
                              starContainer.parentElement?.getAttribute('aria-label') || '';
            const ratingMatch = starLabel.match(/([\d,\.]+)\s*(yıldız|star)/i);
            if (ratingMatch) {
              rating = parseFloat(ratingMatch[1].replace(',', '.'));
            }
            // Method 2: count filled stars (class elGi1d = filled, gnOR4e = empty)
            if (rating === 0) {
              const filledStars = starContainer.querySelectorAll('.elGi1d');
              if (filledStars.length > 0) rating = filledStars.length;
            }

            // --- Author name ---
            let authorName = 'Anonim';
            const authorBtn = reviewCard.querySelector('button div');
            if (authorBtn?.textContent) {
              const name = authorBtn.textContent.trim();
              if (name.length > 0 && name.length < 100) authorName = name;
            }

            // --- Review text ---
            // Find the longest text block in the review that isn't author/rating/time
            let text = '';
            // Walk up from star to its "section" ancestor (grandparent or great-grandparent)
            // Then look at siblings for text content
            const starParent1 = starContainer.parentElement; // span(2ch) or div
            const starParent2 = starParent1?.parentElement;  // div (rating row)
            const ratingSection = starParent2?.parentElement; // div (section containing rating + text)

            if (ratingSection) {
              // Look at ratingSection's children for text (skip the one containing stars)
              for (const child of Array.from(ratingSection.children)) {
                if (child.contains(starContainer)) continue;
                const candidateText = (child.textContent || '').trim();
                if (candidateText.length > 10) {
                  text = candidateText.replace(/\s*Diğer\s*$/, '').trim();
                  break;
                }
              }
            }

            // Fallback: search all text-containing elements in review card
            if (!text) {
              const allEls = reviewCard.querySelectorAll('div, span');
              let longestText = '';
              for (const el of allEls) {
                // Skip elements that contain child divs (not leaf text)
                if (el.tagName === 'DIV' && el.querySelector(':scope > div')) continue;
                // Skip star-related and author elements
                if (starContainer.contains(el) || el.contains(starContainer)) continue;
                const t = (el.textContent || '').trim();
                if (t.length > longestText.length && t.length > 10 && t !== authorName) {
                  longestText = t;
                }
              }
              if (longestText.length > 10) {
                text = longestText.replace(/\s*Diğer\s*$/, '').trim();
              }
            }

            // --- Relative time ---
            let relativeTime: string | undefined;
            // Time is usually a sibling span of the star container's parent
            const timeSearch = starParent2 || starParent1;
            if (timeSearch) {
              const spans = timeSearch.querySelectorAll('span');
              for (const span of spans) {
                if (span === starContainer || starContainer.contains(span)) continue;
                const spanText = (span.textContent || '').trim();
                if (spanText.length < 50 && spanText.match(/(önce|ago|gün|hafta|ay|yıl|week|month|year|day)/i)) {
                  relativeTime = spanText;
                  break;
                }
              }
            }
            // Fallback: search entire review card
            if (!relativeTime) {
              const allSpans = reviewCard.querySelectorAll('span');
              for (const span of allSpans) {
                if (starContainer.contains(span)) continue;
                const spanText = (span.textContent || '').trim();
                if (spanText.length < 50 && spanText.match(/(önce|ago|gün|hafta|ay|yıl|week|month|year|day)/i)) {
                  relativeTime = spanText;
                  break;
                }
              }
            }

            // --- Price per person ---
            let pricePerPerson: string | undefined;
            const allText = reviewCard.textContent || '';
            const priceMatch = allText.match(/kişi başı[:\s]*([\d.,]+\s*₺)/i);
            if (priceMatch) pricePerPerson = priceMatch[1];

            if (text && text.length > 10) {
              extracted.push({
                authorName,
                rating,
                text,
                relativeTime,
                pricePerPerson,
              });
            }
          } catch {
            // Skip malformed review cards
          }
        }

        return extracted;
      });

      // Add unique reviews
      for (const review of newReviews) {
        const isDuplicate = reviews.some(
          (r) => r.text === review.text && r.authorName === review.authorName
        );
        if (!isDuplicate && reviews.length < maxReviews) {
          const matchedKeywords = this.findKeywordMatches(review.text, options.foodKeyword);
          reviews.push({
            ...review,
            matchedKeywords,
          });
        }
      }

      // Check if we got new reviews
      if (reviews.length === lastReviewCount) {
        noNewReviewsCount++;
        if (noNewReviewsCount >= 3) {
          console.log('[Scraper] No new reviews found, stopping');
          break;
        }
      } else {
        noNewReviewsCount = 0;
      }
      lastReviewCount = reviews.length;

      // Scroll down
      await page.evaluate(() => {
        // Try to find the scrollable container
        const scrollSelectors = [
          'div[class*="m6QErb"][class*="DxyBCb"]',
          'div[class*="m6QErb"]',
          'div[role="main"]',
          'div[tabindex="-1"]',
        ];

        for (const selector of scrollSelectors) {
          const scrollable = document.querySelector(selector);
          if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) {
            scrollable.scrollTop = scrollable.scrollHeight;
            return;
          }
        }

        // Fallback: scroll the window
        window.scrollTo(0, document.body.scrollHeight);
      });

      await this.delay(1500);
      scrollAttempts++;
      console.log(`[Scraper] Collected ${reviews.length} reviews (scroll ${scrollAttempts})`);
    }

    return reviews.slice(0, maxReviews);
  }

  /**
   * Expand "More" buttons on reviews
   */
  private async expandReviews(page: Page): Promise<void> {
    try {
      const expandedCount = await page.evaluate(() => {
        let count = 0;
        // "Diğer" buttons inside review text containers
        // These are <button> or <span> elements with text "Diğer"
        const allButtons = document.querySelectorAll('button, span');
        allButtons.forEach((el) => {
          try {
            const text = (el.textContent || '').trim();
            if (text === 'Diğer' || text === 'More') {
              (el as HTMLElement).click();
              count++;
            }
          } catch {}
        });
        return count;
      });
      if (expandedCount > 0) {
        console.log(`[Scraper] Expanded ${expandedCount} "Diğer" buttons`);
        await this.delay(500);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Extract restaurant info from the page (including price level)
   */
  private async extractRestaurantInfo(
    page: Page,
    placeId: string
  ): Promise<ScrapedRestaurantData> {
    const result = await page.evaluate((pid) => {
      // Restaurant name
      let name = '';
      const nameSelectors = ['h1[class*="DUwDvf"]', 'h1[class*="fontHeadlineLarge"]', 'div[role="main"] h1'];
      for (const sel of nameSelectors) {
        const el = document.querySelector(sel);
        if (el?.textContent) {
          name = el.textContent.trim();
          break;
        }
      }

      // Address - try multiple selectors
      let address = '';
      const addressSelectors = [
        'button[data-item-id="address"]',
        'button[aria-label*="Adres"]',
        'div[data-item-id="address"]',
      ];
      for (const sel of addressSelectors) {
        const el = document.querySelector(sel);
        if (el?.textContent) {
          address = el.textContent.trim();
          break;
        }
      }

      // Phone - try multiple selectors
      let phone: string | undefined;
      const phoneSelectors = [
        'button[data-item-id*="phone"]',
        'button[aria-label*="Telefon"]',
        'a[data-item-id*="phone"]',
      ];
      for (const sel of phoneSelectors) {
        const el = document.querySelector(sel);
        if (el?.textContent) {
          phone = el.textContent.trim();
          break;
        }
      }

      // Website
      let website: string | undefined;
      const websiteEl = document.querySelector('a[data-item-id="authority"]');
      if (websiteEl) {
        website = websiteEl.getAttribute('href') || undefined;
      }

      // Rating
      let rating: number | undefined;
      const ratingEl = document.querySelector('div[class*="F7nice"] span[aria-hidden="true"]');
      if (ratingEl?.textContent) {
        rating = parseFloat(ratingEl.textContent.replace(',', '.'));
      }

      // Total reviews
      let totalReviews: number | undefined;
      const reviewCountEl = document.querySelector('button[class*="HHrUdb"]');
      if (reviewCountEl?.textContent) {
        const match = reviewCountEl.textContent.match(/(\d[\d.,]*)/);
        if (match) {
          totalReviews = parseInt(match[1].replace(/[.,]/g, ''));
        }
      }

      // Price level - try XPath first, then CSS selectors
      let priceLevel: number | undefined;

      // Try XPath for price level (user-provided)
      const priceLevelXPath = '/html/body/div[1]/div[2]/div[9]/div[8]/div/div/div[1]/div[2]/div/div[1]/div/div/div[2]/div/div[1]/div[2]/div/div[1]/span/span/span/span[2]/span/span';
      try {
        const xpathResult = document.evaluate(priceLevelXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const priceEl = xpathResult.singleNodeValue as HTMLElement | null;
        if (priceEl?.textContent) {
          // Count ₺ symbols or $ symbols
          const priceText = priceEl.textContent.trim();
          const liraCount = (priceText.match(/₺/g) || []).length;
          const dollarCount = (priceText.match(/\$/g) || []).length;
          priceLevel = liraCount || dollarCount || undefined;
        }
      } catch {
        // XPath failed, try CSS selectors
      }

      // Fallback: CSS selectors for price level
      if (!priceLevel) {
        const priceSelectors = [
          'span[aria-label*="Fiyat"]',
          'span[aria-label*="price"]',
          'span:has(> span:contains("₺"))',
        ];
        for (const sel of priceSelectors) {
          try {
            const el = document.querySelector(sel);
            if (el?.textContent) {
              const text = el.textContent.trim();
              const count = (text.match(/₺/g) || []).length || (text.match(/\$/g) || []).length;
              if (count > 0) {
                priceLevel = count;
                break;
              }
            }
          } catch {
            // Selector failed
          }
        }
      }

      return {
        googlePlaceId: pid,
        name,
        formattedAddress: address,
        latitude: 0,
        longitude: 0,
        rating,
        totalReviews,
        priceLevel,
        phone,
        website,
        googleMapsUrl: window.location.href,
      };
    }, placeId);

    return result as ScrapedRestaurantData;
  }

  /**
   * Find keyword matches in review text
   */
  private findKeywordMatches(text: string, keyword: string): string[] {
    const matches: string[] = [];
    const lowerText = text.toLowerCase();
    const keywords = keyword.toLowerCase().split(/\s+/);

    for (const kw of keywords) {
      if (lowerText.includes(kw)) {
        matches.push(kw);
      }
    }

    // Common Turkish food variations
    const variations: Record<string, string[]> = {
      'lahmacun': ['lahmacun', 'lahmacunu', 'lahmacunlar', 'lahmacunları'],
      'kebap': ['kebap', 'kebabı', 'kebapları', 'kebab', 'kebaplar'],
      'pide': ['pide', 'pidesi', 'pideleri', 'pideler'],
      'döner': ['döner', 'döneri', 'dönerler', 'dönerleri'],
      'köfte': ['köfte', 'köftesi', 'köfteler', 'köfteleri'],
      'tantuni': ['tantuni', 'tantunisi', 'tantuniler'],
      'iskender': ['iskender', 'iskenderi'],
      'adana': ['adana', 'adanası'],
      'urfa': ['urfa', 'urfası'],
    };

    for (const [base, vars] of Object.entries(variations)) {
      if (keyword.toLowerCase().includes(base)) {
        for (const v of vars) {
          if (lowerText.includes(v) && !matches.includes(v)) {
            matches.push(v);
          }
        }
      }
    }

    return matches;
  }

  /**
   * Scrape and save to database
   */
  async scrapeAndSave(
    googleMapsUrl: string,
    placeId: string,
    options: ScrapeOptions,
    restaurantData?: Partial<ScrapedRestaurantData>
  ): Promise<ScrapeResult> {
    const result = await this.scrapeReviews(googleMapsUrl, placeId, options);

    if (result.success && result.restaurant) {
      const fullRestaurantData: ScrapedRestaurantData = {
        ...result.restaurant,
        ...restaurantData,
        latitude: restaurantData?.latitude || result.restaurant.latitude,
        longitude: restaurantData?.longitude || result.restaurant.longitude,
      };

      const savedRestaurant = await restaurantRepository.upsert(fullRestaurantData);

      await reviewRepository.deleteByRestaurantAndKeyword(
        savedRestaurant.id,
        options.foodKeyword
      );

      if (result.reviews.length > 0) {
        await reviewRepository.createMany(
          result.reviews.map((review) => ({
            ...review,
            restaurantId: savedRestaurant.id,
            foodKeyword: options.foodKeyword,
          }))
        );
      }

      console.log(
        `[Scraper] Saved ${result.reviews.length} reviews for ${fullRestaurantData.name}`
      );
    }

    return result;
  }

  /**
   * Utility: delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const googleMapsScraper = new GoogleMapsScraper();
export default googleMapsScraper;
