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
    const proxyTimeout = 25000; // 25sn per proxy attempt (Google Maps SPA is heavy)
    const label = options.restaurantName || placeId.substring(0, 15);

    try {
      const reviewsUrl = this.buildReviewsUrl(googleMapsUrl, placeId);

      // Retry loop: try different proxies until one connects
      let page: Page | null = null;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxProxyAttempts; attempt++) {
        try {
          proxy = await proxyService.getProxy(placeId);
          browser = await this.initBrowser(proxy || undefined);
          page = await this.createPage(browser, proxy || undefined);

          // Set Google consent cookies BEFORE navigating to bypass consent dialog
          await page.setCookie(
            {
              name: 'CONSENT',
              value: 'YES+cb.20240101-01-p0.en+FX+111',
              domain: '.google.com',
              path: '/',
            },
            {
              name: 'SOCS',
              value: 'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwMTE1LjA4X3AxGgJlbiADGgYIgOL_pwY',
              domain: '.google.com',
              path: '/',
            }
          );

          console.log(`[Scraper:${label}] Proxy attempt ${attempt}/${maxProxyAttempts}: ${proxy?.address || 'direct'}`);

          // Use 'domcontentloaded' instead of 'networkidle0':
          // Google Maps SPA continuously loads map tiles, analytics, etc.
          // networkidle0 (0 connections for 500ms) almost never fires within timeout.
          // domcontentloaded fires once HTML is parsed — sufficient for SPA shell.
          await page.goto(reviewsUrl, {
            waitUntil: 'domcontentloaded',
            timeout: proxyTimeout,
          });

          // Success - page loaded
          console.log(`[Scraper:${label}] Connected via proxy ${proxy?.address} (attempt ${attempt})`);
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          console.warn(`[Scraper:${label}] Proxy attempt ${attempt} failed (${proxy?.address}): ${lastError.message.substring(0, 80)}`);

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

      // Accept cookies if prompted (consent cookies already set, this is a fallback)
      await this.acceptCookies(page);

      const pageTitle = await page.title();
      console.log(`[Scraper:${label}] Page title: ${pageTitle}`);

      // Wait for place to load
      try {
        await page.waitForSelector('div[role="main"]', { timeout: 5000 });
        console.log(`[Scraper:${label}] Main content loaded`);
      } catch {
        console.log(`[Scraper:${label}] Could not find main content`);
      }

      // Wait for restaurant detail panel to render (SPA lazy load)
      // The tab bar (Genel Bakış, Yorumlar, Hakkında) renders after the Maps shell
      let panelReady = false;
      for (let wait = 0; wait < 5; wait++) {
        panelReady = await page.evaluate(() => {
          // Check for tab bar buttons with restaurant-specific text
          const tabs = document.querySelectorAll('button[role="tab"]');
          if (tabs.length > 0) return true;
          // Check for restaurant name heading (h1 or h2 inside the detail panel)
          const heading = document.querySelector('h1, h2.fontHeadlineLarge');
          if (heading && heading.textContent && heading.textContent.trim().length > 2) return true;
          // Check for rating section (star display)
          const ratingSection = document.querySelector('div[role="img"][aria-label*="yıldız"], div[role="img"][aria-label*="star"]');
          if (ratingSection) return true;
          return false;
        });
        if (panelReady) {
          console.log(`[Scraper:${label}] Restaurant detail panel loaded (wait ${wait + 1})`);
          break;
        }
        console.log(`[Scraper:${label}] Waiting for restaurant panel to render (${wait + 1}/5)...`);
        await this.delay(2000);
      }
      if (!panelReady) {
        console.log(`[Scraper:${label}] Restaurant panel may not have fully rendered`);
      }

      // Click reviews tab
      await this.clickReviewsTab(page, label);
      await this.delay(2000);

      // Wait for reviews to load
      try {
        await page.waitForSelector('div[class*="m6QErb"], div[data-review-id], div[role="main"]', { timeout: 5000 });
        console.log(`[Scraper:${label}] Reviews section found`);
      } catch {
        console.log(`[Scraper:${label}] Could not find reviews section - taking screenshot`);
        await page.screenshot({ path: `/tmp/debug-${placeId}.png`, fullPage: true });
      }

      // Search for keyword in reviews
      const searchSuccess = await this.searchInReviews(page, options.foodKeyword, label);
      if (searchSuccess) {
        await this.delay(3000);
      }

      // Sort by newest
      await this.sortByNewest(page, label);
      await this.delay(2000);

      // Collect reviews
      const reviews = await this.collectReviews(page, options, label);

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
  private async clickReviewsTab(page: Page, label: string = ''): Promise<void> {
    try {
      console.log(`[Scraper:${label}] Looking for Yorumlar tab...`);

      let clickedTab: string | null = null;

      // Retry loop: Google Maps SPA renders tab text asynchronously.
      // The tab bar may appear empty on first check and populate after 1-3 seconds.
      const maxTabAttempts = 5;
      for (let tabAttempt = 1; tabAttempt <= maxTabAttempts; tabAttempt++) {

        // Method 1: Search ALL element types for EXACT "Yorumlar" or "Reviews" text
        // Google Maps tabs may be <a>, <div>, <span>, or <button> — not necessarily role="tab"
        clickedTab = await page.evaluate(() => {
          const allElements = document.querySelectorAll('button, a, div, span');
          for (const el of allElements) {
            const directText = (el.textContent || '').trim();
            if (directText.length < 30 && (
              /^yorumlar$/i.test(directText) ||
              /^reviews$/i.test(directText) ||
              /^yorumlar\s*\(/i.test(directText) ||
              /^reviews\s*\(/i.test(directText)
            )) {
              (el as HTMLElement).click();
              return `exact-text: "${directText}"`;
            }
          }
          return null;
        });
        if (clickedTab) break;

        // Method 2: Click on the review count button near the rating (e.g., "3.842 yorum" or "(3.842)")
        clickedTab = await page.evaluate(() => {
          const allElements = document.querySelectorAll('button, a, span');
          for (const el of allElements) {
            const text = (el.textContent || '').trim();
            if (text.length < 30 && /^\(?[\d.,]+\)?\s*(yorum|review)/i.test(text)) {
              const clickable = el.closest('button, a, [role="button"]') || el;
              (clickable as HTMLElement).click();
              return `review-count: "${text}"`;
            }
          }
          return null;
        });
        if (clickedTab) break;

        // Method 3: Search for role="tab" buttons with strict matching
        clickedTab = await page.evaluate(() => {
          const tabs = document.querySelectorAll('button[role="tab"], [role="tab"]');
          for (const tab of tabs) {
            const text = (tab.textContent || '').toLowerCase().trim();
            const ariaLabel = (tab.getAttribute('aria-label') || '').toLowerCase();
            if (/^yorumlar$/i.test(text) || /^reviews$/i.test(text) ||
                /^yorumlar$/i.test(ariaLabel) || /^reviews$/i.test(ariaLabel)) {
              (tab as HTMLElement).click();
              return `role-tab: text="${text}" aria="${ariaLabel}"`;
            }
          }
          return null;
        });
        if (clickedTab) break;

        // Method 4: Find tablist container children with "yorum" text (NO positional fallback)
        clickedTab = await page.evaluate(() => {
          const tabLists = document.querySelectorAll('div[role="tablist"], div[class*="tabBar"]');
          for (const tabList of tabLists) {
            const children = tabList.querySelectorAll('button, a, [role="tab"]');
            for (const child of children) {
              const text = ((child as HTMLElement).textContent || '').toLowerCase();
              if (text.includes('yorum') || text.includes('review')) {
                (child as HTMLElement).click();
                return `tablist-child: "${text.substring(0, 20)}"`;
              }
            }
          }
          return null;
        });
        if (clickedTab) break;

        // Method 5: Direct click on review summary area (the review count near the star rating)
        clickedTab = await page.evaluate(() => {
          const ratingArea = document.querySelector('div[class*="F7nice"], div[role="img"][aria-label*="yıldız"], div[role="img"][aria-label*="star"]');
          if (ratingArea) {
            const parent = ratingArea.closest('div');
            if (parent) {
              const siblings = parent.parentElement?.querySelectorAll('button, a, span') || [];
              for (const sib of siblings) {
                const text = (sib.textContent || '').trim();
                if (/yorum|review/i.test(text) && text.length < 30) {
                  const clickable = sib.closest('button, a, [role="button"]') || sib;
                  (clickable as HTMLElement).click();
                  return `rating-area: "${text}"`;
                }
              }
            }
          }
          return null;
        });
        if (clickedTab) break;

        // No method worked — wait for SPA to render and retry
        if (tabAttempt < maxTabAttempts) {
          console.log(`[Scraper:${label}] Tab detection attempt ${tabAttempt}/${maxTabAttempts} failed, waiting for SPA render...`);
          await this.delay(2000);
        }
      }

      if (clickedTab) {
        console.log(`[Scraper:${label}] Clicked Yorumlar tab via ${clickedTab}`);
        await this.delay(3000);
      } else {
        // Enhanced debug: log ALL elements containing "yorum" with their context
        const debugInfo = await page.evaluate(() => {
          const results: Array<{tag: string; text: string; ariaLabel: string; role: string; className: string; parentTag: string}> = [];
          const all = document.querySelectorAll('*');
          for (const el of all) {
            const text = (el.textContent || '').trim();
            const ariaLabel = el.getAttribute('aria-label') || '';
            if ((text.toLowerCase().includes('yorum') || ariaLabel.toLowerCase().includes('yorum')) && text.length < 100) {
              results.push({
                tag: el.tagName,
                text: text.substring(0, 60),
                ariaLabel: ariaLabel.substring(0, 60),
                role: el.getAttribute('role') || '',
                className: (el.className || '').toString().substring(0, 40),
                parentTag: el.parentElement?.tagName || '',
              });
            }
            if (results.length >= 15) break;
          }
          return results;
        });
        console.log(`[Scraper:${label}] No Yorumlar tab found after ${maxTabAttempts} attempts. Elements with "yorum":`, JSON.stringify(debugInfo, null, 0));

        // Take debug screenshot
        await page.screenshot({ path: `/tmp/debug-tab-${label.replace(/\s+/g, '-')}.png`, fullPage: false });
        console.log(`[Scraper:${label}] Debug screenshot saved`);
        return;
      }

      // Dismiss any sign-in dialogs that may appear (e.g., after clicking "yorum yazın")
      await this.delay(1000);
      await page.evaluate(() => {
        const dialogs = document.querySelectorAll('div[role="dialog"]');
        for (const dialog of dialogs) {
          const cancelBtn = dialog.querySelector('button');
          if (cancelBtn) {
            const text = (cancelBtn.textContent || '').toLowerCase();
            if (text.includes('iptal') || text.includes('cancel') || text.includes('kapat') || text.includes('close')) {
              (cancelBtn as HTMLElement).click();
            }
          }
        }
      });

      // Wait and verify reviews panel loaded (check for multiple star spans)
      await this.delay(2000);
      let reviewsLoaded = false;
      for (let retry = 0; retry < 3; retry++) {
        const starCount = await page.evaluate(() => {
          let count = 0;
          document.querySelectorAll('span').forEach(span => {
            if (span.children.length === 5 && Array.from(span.children).every(c => c.tagName === 'SPAN')) {
              count++;
            }
          });
          return count;
        });

        if (starCount > 1) {
          console.log(`[Scraper:${label}] Reviews panel loaded: ${starCount} star spans found`);
          reviewsLoaded = true;
          break;
        }

        console.log(`[Scraper:${label}] Waiting for reviews to load (attempt ${retry + 1}/3, stars: ${starCount})...`);
        await this.delay(3000);
      }

      if (!reviewsLoaded) {
        console.log(`[Scraper:${label}] Reviews panel may not have fully loaded`);
        await page.screenshot({ path: `/tmp/debug-reviews-${label.replace(/\s+/g, '-')}.png`, fullPage: false });
      }
    } catch (error) {
      console.warn(`[Scraper:${label}] Could not click reviews tab:`, error);
    }
  }

  /**
   * Search for keyword in reviews
   */
  private async searchInReviews(page: Page, keyword: string, label: string = ''): Promise<boolean> {
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
  private async sortByNewest(page: Page, label: string = ''): Promise<void> {
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
    options: ScrapeOptions,
    label: string = ''
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
      // Count data-review-id elements
      const dataReviewElements = document.querySelectorAll('[data-review-id]');
      info.push(`data-review-id elements: ${dataReviewElements.length}`);
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
    console.log(`[Scraper:${label}] Debug info:`, debugInfo.join(', '));

    while (reviews.length < maxReviews && scrollAttempts < maxScrollAttempts) {
      // Expand all "Diğer" (More) buttons first
      await this.expandReviews(page, label);

      // Extract reviews using structural DOM approach
      const newReviews = await page.evaluate(() => {
        const extracted: Array<{
          authorName: string;
          rating: number;
          text: string;
          relativeTime?: string;
          pricePerPerson?: string;
          _debug?: string;
        }> = [];

        // Find the reviews scrollable container
        const container = document.querySelector('div[class*="m6QErb"][class*="DxyBCb"]') ||
                          document.querySelector('div[class*="m6QErb"]');
        if (!container) return extracted;

        // Helper: check if element has a star span (5-child pattern)
        const hasStar = (el: Element): boolean => {
          return Array.from(el.querySelectorAll('span')).some(
            s => s.children.length === 5 && Array.from(s.children).every(c => c.tagName === 'SPAN')
          );
        };

        // Helper: find first star span within element
        const findStar = (el: Element): Element | null => {
          for (const span of el.querySelectorAll('span')) {
            if (span.children.length === 5 && Array.from(span.children).every(c => c.tagName === 'SPAN')) {
              return span;
            }
          }
          return null;
        };

        // Helper: count stars within element
        const countStars = (el: Element): number => {
          let count = 0;
          for (const span of el.querySelectorAll('span')) {
            if (span.children.length === 5 && Array.from(span.children).every(c => c.tagName === 'SPAN')) {
              count++;
            }
          }
          return count;
        };

        // Build list of {reviewCard, starContainer} pairs using multiple strategies

        // Strategy A: Use data-review-id attribute (most reliable when available)
        // Deduplicate by review ID — Google Maps nests elements with same data-review-id
        let reviewPairs: Array<{card: HTMLElement; star: Element}> = [];
        const dataReviewCards = container.querySelectorAll('[data-review-id]');
        if (dataReviewCards.length > 0) {
          const seenIds = new Set<string>();
          for (const card of dataReviewCards) {
            const reviewId = card.getAttribute('data-review-id') || '';
            if (seenIds.has(reviewId)) continue;
            seenIds.add(reviewId);
            const star = findStar(card);
            if (star) {
              reviewPairs.push({ card: card as HTMLElement, star });
            }
          }
        }

        // Strategy B: Top-down from container children
        if (reviewPairs.length === 0) {
          for (const child of container.children) {
            const childEl = child as HTMLElement;
            const childStarCount = countStars(childEl);

            if (childStarCount === 0) continue;

            if (childStarCount === 1) {
              // This child IS an individual review card
              const star = findStar(childEl);
              if (star) reviewPairs.push({ card: childEl, star });
            } else {
              // This child contains MULTIPLE stars — find individual review level
              // Recursively look for the level where each element has ≤1 star
              const findIndividualCards = (el: HTMLElement, depth: number): void => {
                if (depth > 5) return; // Safety limit
                for (const sub of el.children) {
                  const subEl = sub as HTMLElement;
                  const subStarCount = countStars(subEl);
                  if (subStarCount === 0) continue;
                  if (subStarCount === 1) {
                    const star = findStar(subEl);
                    if (star) reviewPairs.push({ card: subEl, star });
                  } else {
                    findIndividualCards(subEl, depth + 1);
                  }
                }
              };
              findIndividualCards(childEl, 0);
            }
          }
        }

        // Strategy C: Original star-walking approach (fallback)
        if (reviewPairs.length === 0) {
          const starContainers: Element[] = [];
          container.querySelectorAll('span').forEach(span => {
            if (span.children.length === 5 &&
                Array.from(span.children).every(c => c.tagName === 'SPAN')) {
              starContainers.push(span);
            }
          });

          const processedCards = new Set<Element>();
          for (const starContainer of starContainers) {
            let reviewCard: HTMLElement | null = null;
            let current: HTMLElement | null = starContainer as HTMLElement;
            for (let d = 0; d < 15 && current; d++) {
              if (current.parentElement === container) {
                reviewCard = current;
                break;
              }
              current = current.parentElement;
            }
            if (!reviewCard || processedCards.has(reviewCard)) continue;
            processedCards.add(reviewCard);
            reviewPairs.push({ card: reviewCard, star: starContainer });
          }
        }

        // Log strategy info
        const strategy = dataReviewCards.length > 0 ? 'data-review-id' :
                         reviewPairs.length > 0 ? 'top-down' : 'star-walk';

        for (const { card: reviewCard, star: starContainer } of reviewPairs) {
          try {

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
            let text = '';

            // Method 1: Known Google Maps review text class
            const knownTextEl = reviewCard.querySelector('span.wiI7pd');
            if (knownTextEl) {
              text = (knownTextEl.textContent || '').trim();
            }

            // Method 2: Find longest span NOT inside author button and NOT a profile description
            if (!text) {
              // Find author button to exclude its children
              const authorButton = reviewCard.querySelector('button');
              const allSpans = reviewCard.querySelectorAll('span');
              let longestReviewText = '';
              for (const span of allSpans) {
                // Skip star container and its children
                if (starContainer.contains(span) || span.contains(starContainer)) continue;
                // Skip elements inside the author button only (not all buttons/links)
                if (authorButton && authorButton.contains(span)) continue;
                const t = (span.textContent || '').trim();
                // Skip short texts
                if (t.length <= 15) continue;
                // Skip profile descriptions (e.g., "Yerel Rehber · 72 yorum · 9 fotoğraf")
                if (t.match(/\d+\s*(yorum|review)/i) && t.match(/(fotoğraf|photo|Rehber|Guide)/i)) continue;
                // Skip time indicators
                if (t.match(/^\d+\s*(gün|hafta|ay|yıl|day|week|month|year)\s*(önce|ago)/i)) continue;
                // Skip author name concatenated with profile
                if (t.startsWith(authorName) && t.match(/(Rehber|yorum|review|Guide)/i)) continue;
                if (t.length > longestReviewText.length) {
                  longestReviewText = t;
                }
              }
              if (longestReviewText.length > 15) {
                text = longestReviewText.replace(/\s*Diğer\s*$/, '').trim();
              }
            }

            // Method 3: Search all divs and spans for longest non-author text
            if (!text) {
              const authorButton = reviewCard.querySelector('button');
              const allEls = reviewCard.querySelectorAll('div, span');
              let longestText = '';
              for (const el of allEls) {
                // Skip star-related
                if (starContainer.contains(el) || el.contains(starContainer)) continue;
                // Skip author button contents
                if (authorButton && authorButton.contains(el)) continue;
                const t = (el.textContent || '').trim();
                if (t.length <= 15) continue;
                // Skip profile/time patterns
                if (t.match(/\d+\s*(yorum|review)/i) && t.match(/(fotoğraf|photo|Rehber|Guide)/i)) continue;
                if (t.match(/^\d+\s*(gün|hafta|ay|yıl|day|week|month|year)\s*(önce|ago)/i)) continue;
                if (t.startsWith(authorName) && t.length < 100) continue;
                if (t.length > longestText.length) {
                  longestText = t;
                }
              }
              if (longestText.length > 15) {
                text = longestText.replace(/\s*Diğer\s*$/, '').trim();
              }
            }

            // --- Relative time ---
            let relativeTime: string | undefined;
            // Search entire review card for time
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
                _debug: strategy,
              });
            }
          } catch {
            // Skip malformed review cards
          }
        }

        return extracted;
      });

      // Debug: log extraction results
      if (newReviews.length > 0) {
        const snippet = newReviews[0].text.substring(0, 80);
        const debugStrategy = newReviews[0]._debug || 'unknown';
        console.log(`[Scraper:${label}] Extracted ${newReviews.length} reviews (strategy: ${debugStrategy}), first: "${snippet}..."`);
        // Log each review's author + text snippet to detect duplicate text issues
        if (newReviews.length <= 20) {
          for (let ri = 0; ri < newReviews.length; ri++) {
            const r = newReviews[ri];
            console.log(`[Scraper:${label}]   [${ri}] ${r.authorName} (${r.rating}★): "${r.text.substring(0, 60)}..."`);
          }
        }
      } else {
        console.log(`[Scraper:${label}] Extracted 0 reviews from evaluate`);
      }

      // Add unique reviews
      let addedCount = 0;
      let dupCount = 0;
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
          addedCount++;
        } else {
          dupCount++;
        }
      }
      console.log(`[Scraper:${label}] Dedup: extracted=${newReviews.length}, new=${addedCount}, dup=${dupCount}, total=${reviews.length}`);

      // Check if we got new reviews
      if (reviews.length === lastReviewCount) {
        noNewReviewsCount++;
        if (noNewReviewsCount >= 3) {
          console.log(`[Scraper:${label}] No new reviews found after 3 scrolls, stopping`);
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
      console.log(`[Scraper:${label}] Collected ${reviews.length} reviews (scroll ${scrollAttempts})`);
    }

    return reviews.slice(0, maxReviews);
  }

  /**
   * Expand "More" buttons on reviews
   */
  private async expandReviews(page: Page, label: string = ''): Promise<void> {
    try {
      const expandedCount = await page.evaluate(() => {
        let count = 0;
        // Find the reviews container first - only expand buttons INSIDE it
        const container = document.querySelector('div[class*="m6QErb"][class*="DxyBCb"]') ||
                          document.querySelector('div[class*="m6QErb"]');
        if (!container) return count;

        // Only search for "Diğer" buttons inside the review container
        // This prevents clicking star/rating related buttons that destroy DOM structure
        const reviewButtons = container.querySelectorAll('button, span');
        reviewButtons.forEach((el) => {
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
        console.log(`[Scraper:${label}] Expanded ${expandedCount} "Diğer" buttons`);
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

      const lbl = options.restaurantName || fullRestaurantData.name;
      console.log(
        `[Scraper:${lbl}] Saved ${result.reviews.length} reviews for ${fullRestaurantData.name}`
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
