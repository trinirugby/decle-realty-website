import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { renderPropertyPage } from './property-template.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, '..');
const URLS_FILE = join(__dirname, 'featured-urls.txt');
const IMAGES_DIR = join(SITE_ROOT, 'properties-images');
const PAGES_DIR = join(SITE_ROOT, 'properties');
const DATA_JSON = join(__dirname, 'listings-data.json');
const DATA_JS = join(SITE_ROOT, 'listings-data.js');
const AUTHOR_BASE = 'https://mybunchofkeys.com/author/declerealty/';

const args = process.argv.slice(2);
const argSet = new Set(args);
const DISCOVER_ALL = argSet.has('--all');
const ONLY_FLAG = args.find((a) => a.startsWith('--only='));
const ONLY_URL = ONLY_FLAG ? ONLY_FLAG.slice('--only='.length) : null;
const CONCURRENCY = 4;

const slugFromUrl = (url) => {
  const m = url.match(/\/property\/([^/]+)\/?/);
  // Allow long slugs — only truncate for filesystem safety at 200 chars
  return (m ? m[1] : url.replace(/\W+/g, '-')).slice(0, 200);
};

async function fetchHtml(url, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.status >= 500 && attempt < retries) {
        const wait = 1500 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      return res.text();
    } catch (err) {
      if (attempt >= retries) throw err;
      const wait = 1500 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`exhausted retries for ${url}`);
}

async function downloadImage(imgUrl, destPath) {
  const sizes = ['1440x1080', '1024x768', '810x1080', '768x1024', '800x600', '640x480'];
  const candidates = [imgUrl];
  const sized = imgUrl.match(/-(\d+x\d+)(\.(?:jpe?g|png|webp))$/i);
  if (sized) {
    const [, , ext] = sized;
    const base = imgUrl.replace(sized[0], '');
    for (const s of sizes) candidates.push(`${base}-${s}${ext}`);
    candidates.push(`${base}${ext}`);
  }
  let lastErr;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        lastErr = new Error(`${res.status} for ${url}`);
        continue;
      }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
      return url;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('all image candidates failed');
}

async function discoverAll() {
  const urls = new Set();
  for (let page = 1; page <= 15; page++) {
    const url = page === 1 ? AUTHOR_BASE : `${AUTHOR_BASE}page/${page}/`;
    try {
      const html = await fetchHtml(url);
      const $ = cheerio.load(html);
      const before = urls.size;
      $('a[href*="/property/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const clean = href.split('?')[0].split('#')[0];
        const m = clean.match(/^(https?:\/\/[^/]+\/property\/[^/]+)\/?$/);
        if (m) urls.add(m[1] + '/');
      });
      const added = urls.size - before;
      console.log(`Author page ${page}: +${added} URLs (${urls.size} total)`);
      if (added === 0 && page > 1) break;
    } catch (e) {
      console.warn(`Author page ${page}: ${e.message}`);
      break;
    }
  }
  return Array.from(urls);
}

function parsePrice(priceStr) {
  const matches = [...String(priceStr).matchAll(/\$\s*([\d,]+)/g)];
  const values = matches.map((m) => parseInt(m[1].replace(/,/g, ''), 10));
  const isMonthly = /\/\s*Mth/i.test(priceStr);
  const isUSD = /\bUSD\b/i.test(priceStr);
  if (values.length === 0) return { sale: null, rent: null, currency: 'TTD' };
  if (values.length === 1) {
    return isMonthly
      ? { sale: null, rent: values[0], currency: isUSD ? 'USD' : 'TTD' }
      : { sale: values[0], rent: null, currency: isUSD ? 'USD' : 'TTD' };
  }
  return { sale: values[0], rent: values[values.length - 1], currency: isUSD ? 'USD' : 'TTD' };
}

function parseSpecsFromText(text) {
  const out = {};
  const pick = (re) => {
    const m = text.match(re);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
  };
  out.beds = pick(/Bedrooms?:\s*(\d+)/i);
  out.baths = pick(/Bathrooms?:\s*(\d+)/i);
  out.parking = pick(/Parking:\s*(\d+)/i);
  out.sqft = pick(/Sq\.\s*Footage:\s*([\d,]+)\s*sq\.?\s*ft/i);
  return out;
}

function cleanRegionHtml(html) {
  // Strip "View More X Listings" buttons (links back to mybunchofkeys) and other internal links.
  let cleaned = html;
  cleaned = cleaned.replace(/<a[^>]*class="button"[^>]*>.*?<\/a>/gis, '');
  cleaned = cleaned.replace(/<p[^>]*class="small"[^>]*>\s*<\/p>/gi, '');
  // Strip any remaining external links pointing back to mybunchofkeys.
  cleaned = cleaned.replace(/<a[^>]*href="[^"]*mybunchofkeys\.com[^"]*"[^>]*>([^<]*)<\/a>/gi, '$1');
  return cleaned;
}

function cleanDescriptionHtml(html) {
  let cleaned = html;
  // Remove any links back to mybunchofkeys.
  cleaned = cleaned.replace(/<a[^>]*href="[^"]*mybunchofkeys\.com[^"]*"[^>]*>([^<]*)<\/a>/gi, '$1');
  return cleaned;
}

function extractListing(html, sourceUrl) {
  const $ = cheerio.load(html);
  const slug = slugFromUrl(sourceUrl);

  const title =
    $('h1').first().text().trim() ||
    $('title').text().replace(/\|.*$/, '').trim();

  // Price from the first <h4> with $
  let price = '';
  $('h4').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (!price && /\$/.test(t)) price = t;
  });

  // Status — look for status banner image
  let status = 'available';
  $('img.status-banner').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (/rented-banner/i.test(src)) status = 'rented';
    else if (/sold-banner/i.test(src)) status = 'sold';
  });
  if (status === 'available' && $('.property-unavailable').length) {
    // Generic unavailable fallback
    status = 'rented';
  }

  // Specs from the property-details column
  const propertyDetailsText = $('.column.property-details').text();
  const specs = parseSpecsFromText(propertyDetailsText);

  // Property type from the "Find More In:" links
  const postedIn = $('.column.posted-in');
  let propertyType = '';
  postedIn.find('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/\/property_style\/([^/]+)/.test(href) && !propertyType) {
      propertyType = $(el).text().trim();
    }
  });

  // Property ID
  let propertyId = '';
  $('p').each((_, el) => {
    const t = $(el).text();
    const m = t.match(/Property ID:\s*\n?\s*BOK-([\d]+)/i) || t.match(/BOK-(\d+)/i);
    if (m && !propertyId) propertyId = `BOK-${m[1]}`;
  });

  // Features — under .column.features. Two formats:
  // 1. .feature-icons divs with <span>NAME</span>
  // 2. <span class="feature">..<span class="icon X">NAME</span></span>
  const features = new Set();
  $('.column.features .feature-icons span').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length > 1 && t.length < 60 && !/highlights/i.test(t)) features.add(t);
  });
  $('.column.features span.feature').each((_, el) => {
    // Get the text inside the inner .icon span
    const innerIcon = $(el).find('span.icon');
    let name = innerIcon.text().trim();
    if (!name) {
      // If no .icon child has text, try the feature span itself
      const allText = $(el).clone().children('span.icon').remove().end().text().trim();
      name = allText;
    }
    if (name && name.length > 1 && name.length < 60) features.add(name);
  });

  // Description: <div id="description"> inside .column.property-desc
  let descriptionHtml = '';
  let descriptionText = '';
  const descContainer = $('div#description').first();
  if (descContainer.length) {
    descriptionHtml = cleanDescriptionHtml(descContainer.html() || '');
    descriptionText = descContainer.text().trim().replace(/\s+/g, ' ');
  }

  // Region: <div class="region-desc">
  let regionHtml = '';
  const regionContainer = $('.region-desc').first();
  if (regionContainer.length) {
    regionHtml = cleanRegionHtml(regionContainer.html() || '');
  }

  // Photos: hero + figure.gallery-item anchors → all unique full-size URLs
  const photoUrls = [];
  const seenBases = new Set();

  // Hero first
  const heroLink = $('.intro .hero a').attr('href') || $('.intro .hero img').attr('src') || '';
  if (heroLink && /\.(jpe?g|png|webp)/i.test(heroLink)) {
    const base = heroLink.replace(/-\d+x\d+(\.(?:jpe?g|png|webp))$/i, '$1');
    seenBases.add(base);
    photoUrls.push(heroLink);
  }

  $('figure.gallery-item a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href || !href.includes('/wp-content/uploads/')) return;
    if (!/\.(jpe?g|png|webp)/i.test(href)) return;
    const base = href.replace(/-\d+x\d+(\.(?:jpe?g|png|webp))$/i, '$1');
    if (seenBases.has(base)) return;
    seenBases.add(base);
    photoUrls.push(href);
  });

  // Fallback: if no gallery photos found, scan all images
  if (photoUrls.length <= 1) {
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (!src || !src.includes('/wp-content/uploads/')) return;
      if (!/\.(jpe?g|png|webp)/i.test(src)) return;
      const base = src.replace(/-\d+x\d+(\.(?:jpe?g|png|webp))$/i, '$1');
      if (seenBases.has(base)) return;
      seenBases.add(base);
      // Try to upgrade to a larger size
      const upgraded = src.replace(/-\d+x\d+(\.(?:jpe?g|png|webp))$/i, '-1440x1080$1');
      photoUrls.push(upgraded);
    });
  }

  // Title-derived location label
  const location = title.split(/[–—-]/)[0].trim().replace(/[.,]+$/, '');

  // Blurb (kept for listings.html cards): first paragraph of description text
  let blurb = descriptionText.slice(0, 220);
  if (blurb.length === 220) {
    const sp = blurb.lastIndexOf(' ');
    if (sp > 160) blurb = blurb.slice(0, sp) + '…';
  }

  const { sale, rent, currency } = parsePrice(price);
  let type = 'other';
  if (sale && rent) type = 'sale-rent';
  else if (sale) type = 'sale';
  else if (rent) type = 'rent';

  return {
    title,
    price,
    sale,
    rent,
    currency,
    type,
    location,
    blurb,
    descriptionHtml,
    descriptionText,
    regionHtml,
    features: [...features],
    beds: specs.beds,
    baths: specs.baths,
    parking: specs.parking,
    sqft: specs.sqft,
    propertyType,
    propertyId,
    status,
    sourceUrl,
    photoUrls,
    slug,
  };
}

async function pLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { __error: err.message, __input: items[idx] };
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function downloadAllPhotos(record) {
  const slugDir = join(IMAGES_DIR, record.slug);
  await mkdir(slugDir, { recursive: true });
  const localPhotos = [];

  for (let i = 0; i < record.photoUrls.length; i++) {
    const url = record.photoUrls[i];
    const ext = (url.match(/\.(jpe?g|png|webp)/i) || ['.jpg'])[0];
    const num = String(i + 1).padStart(2, '0');
    const localRel = `properties-images/${record.slug}/${num}${ext}`;
    const localAbs = join(SITE_ROOT, localRel);
    if (existsSync(localAbs)) {
      localPhotos.push(localRel);
      continue;
    }
    try {
      await downloadImage(url, localAbs);
      localPhotos.push(localRel);
    } catch (err) {
      // Skip this photo on persistent failure but don't break the whole record.
      console.warn(`\n  ⚠ ${record.slug} photo ${num}: ${err.message}`);
    }
  }
  return localPhotos;
}

async function main() {
  await mkdir(IMAGES_DIR, { recursive: true });
  await mkdir(PAGES_DIR, { recursive: true });

  let urls;
  if (ONLY_URL) {
    urls = [ONLY_URL];
    console.log(`Single URL mode: ${ONLY_URL}\n`);
  } else if (DISCOVER_ALL) {
    console.log('Discovering all listings from author archive...');
    urls = await discoverAll();
    console.log(`Discovered ${urls.length} listing URLs.\n`);
    await writeFile(URLS_FILE, urls.join('\n') + '\n');
  } else {
    urls = (await readFile(URLS_FILE, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    console.log(`Read ${urls.length} URLs from featured-urls.txt\n`);
  }

  // Step 1: parallel HTML fetch + extract
  console.log(`Fetching ${urls.length} property pages (concurrency ${CONCURRENCY})...`);
  let done = 0;
  const records = await pLimit(urls, CONCURRENCY, async (url) => {
    const html = await fetchHtml(url);
    const data = extractListing(html, url);
    done++;
    process.stdout.write(`\r  fetched ${done}/${urls.length}`);
    return data;
  });
  console.log('\n');

  const valid = records.filter((r) => r && !r.__error);
  const errored = records.filter((r) => r && r.__error);
  console.log(`Got ${valid.length} valid records, ${errored.length} errors.`);

  // Step 2: parallel photo downloads (all photos per listing)
  console.log(`\nDownloading photos (all gallery images per listing)...`);
  let imgDone = 0;
  await pLimit(valid, CONCURRENCY, async (data) => {
    const localPhotos = await downloadAllPhotos(data);
    data.photos = localPhotos;
    imgDone++;
    const total = data.photoUrls.length;
    process.stdout.write(`\r  ${imgDone}/${valid.length} listings (${data.slug}: ${localPhotos.length}/${total} photos)`);
  });
  console.log('\n');

  // Step 3: generate per-listing detail pages
  console.log(`Generating ${valid.length} property detail pages...`);
  for (const data of valid) {
    const html = renderPropertyPage(data);
    await writeFile(join(PAGES_DIR, `${data.slug}.html`), html);
  }
  console.log(`  ✓ ${valid.length} pages written to ${PAGES_DIR}\n`);

  // Step 4: write data files
  await writeFile(DATA_JSON, JSON.stringify(valid, null, 2));
  console.log(`Wrote ${valid.length} records → ${DATA_JSON}`);

  const publicData = valid.map((d) => ({
    title: d.title,
    price: d.price,
    sale: d.sale,
    rent: d.rent,
    currency: d.currency,
    type: d.type,
    location: d.location,
    blurb: d.blurb,
    img: d.photos?.[0] || '',
    photoCount: d.photos?.length || 0,
    beds: d.beds,
    baths: d.baths,
    parking: d.parking,
    sqft: d.sqft,
    propertyType: d.propertyType,
    status: d.status,
    pageUrl: `properties/${d.slug}.html`,
    slug: d.slug,
  }));

  const js =
    `// Auto-generated by scripts/scrape-listings.mjs. Do not edit by hand.\n` +
    `window.LISTINGS = ${JSON.stringify(publicData, null, 2)};\n`;
  await writeFile(DATA_JS, js);
  console.log(`Wrote browser data → ${DATA_JS}`);

  if (errored.length) {
    console.log(`\nErrors:`);
    for (const e of errored) console.log(`  ${e.__input}: ${e.__error}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
