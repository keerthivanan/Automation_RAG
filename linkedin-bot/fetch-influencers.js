// fetch-influencers.js
// Silent — no browser window opens
// 1. Headless browser searches LinkedIn → collects profile IDs
// 2. Visits each profile → reads REAL follower count from the page
// 3. Saves profile ID + followers to SQLite (bot.db)
// Usage: node fetch-influencers.js

require('dotenv').config();
const { chromium } = require('playwright');
const { saveInfluencer, getInfluencer, countInfluencers } = require('./db');
const path = require('path');

const BROWSER_PROFILE = path.join(__dirname, 'browser-profile');
const MIN_FOLLOWERS   = 15000;

const SEARCH_QUERIES = [
  'AI automation', 'AI agents founder', 'workflow automation',
  'generative AI', 'LLM expert', 'no code automation',
  'artificial intelligence', 'machine learning', 'ChatGPT automation',
  'AI productivity tools',
];

(async () => {
  console.log('\n📋 Building profile database (silent, no window)\n');

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE, {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run',
           '--no-default-browser-check', '--disable-session-crashed-bubble'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 }, locale: 'en-US',
  });

  const page = await context.newPage();

  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    await context.close();
    console.error(`❌ Network error: ${err.message.split('\n')[0]}\n`);
    process.exit(1);
  }
  await page.waitForTimeout(3000);

  if (page.url().includes('/login') || page.url().includes('/authwall')) {
    await context.close();
    console.error('❌ Session expired. Run: node run-promoter.js once to log in first.\n');
    process.exit(1);
  }
  console.log('✅ Session valid\n');

  // ── Step 1: collect profile slugs from LinkedIn people search ──────────────
  console.log('🔍 Step 1: Collecting profile IDs...\n');
  const slugSet = new Set();

  for (const query of SEARCH_QUERIES) {
    process.stdout.write(`  "${query}"... `);
    try {
      await page.goto(
        `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}`,
        { waitUntil: 'domcontentloaded', timeout: 30000 }
      ).catch(() => {});
      await page.waitForTimeout(3000).catch(() => {});

      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, 800)).catch(() => {});
        await page.waitForTimeout(700).catch(() => {});
      }

      const slugs = await page.evaluate(() => {
        const found = new Set();
        document.querySelectorAll('a[href*="/in/"]').forEach(a => {
          const m = (a.href || '').match(/linkedin\.com\/in\/([^/?#\s]+)/);
          if (m && m[1].length > 2 && !m[1].includes('search') && !m[1].includes('feed'))
            found.add(m[1].toLowerCase());
        });
        return [...found];
      }).catch(() => []);

      slugs.forEach(s => slugSet.add(s));
      console.log(`${slugs.length} profiles`);
      await page.waitForTimeout(1500).catch(() => {});
    } catch (err) {
      if (err.message.includes('closed')) { console.log('session closed'); break; }
      console.log('skip');
    }
  }

  // Only check new slugs not already in DB
  const toCheck = [...slugSet].filter(s => !getInfluencer(s));
  console.log(`\n📊 ${slugSet.size} found | ${toCheck.length} new to check\n`);

  if (toCheck.length === 0) {
    await context.close();
    const total = countInfluencers(MIN_FOLLOWERS);
    console.log(`✅ Already up to date — ${total} profiles with ${MIN_FOLLOWERS / 1000}K+ followers`);
    console.log('\nRun: node run-promoter.js\n');
    return;
  }

  // ── Step 2: visit each profile and read actual follower count ──────────────
  console.log(`🤖 Step 2: Reading follower counts from ${toCheck.length} profiles...\n`);

  let saved = 0;
  for (let i = 0; i < toCheck.length; i++) {
    const slug = toCheck[i];
    try {
      await page.goto(`https://www.linkedin.com/in/${slug}/`, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      }).catch(() => {});
      await page.waitForTimeout(2000).catch(() => {});

      const { followers, name } = await page.evaluate(() => {
        // Most reliable: find the followers link on the profile (links to /followers/ page)
        let followers = 0;
        const links = [...document.querySelectorAll('a[href*="followers"]')];
        for (const a of links) {
          const m = (a.textContent || '').replace(/,/g, '').match(/[\d]+/);
          if (m) { followers = parseInt(m[0]); break; }
        }

        // Fallback: search only the first 3000 chars of body text (profile header area)
        if (!followers) {
          const top = document.body.innerText.slice(0, 3000);
          const m = top.match(/([\d,]+)\s*followers/i);
          if (m) followers = parseInt(m[1].replace(/,/g, '')) || 0;
        }

        const name = document.querySelector('h1')?.textContent?.trim() || '';
        return { followers, name };
      }).catch(() => ({ followers: 0, name: '' }));

      saveInfluencer(slug, name, followers);

      if (followers >= MIN_FOLLOWERS) {
        saved++;
        console.log(`  ✅ [${i + 1}/${toCheck.length}] ${name || slug} — ${(followers / 1000).toFixed(0)}K followers`);
      } else {
        const fStr = followers >= 1000 ? `${(followers / 1000).toFixed(1)}K` : String(followers);
        process.stdout.write(`  [${i + 1}/${toCheck.length}] ${slug}: ${fStr} — skip\r`);
      }
    } catch {
      saveInfluencer(slug, '', 0);
    }

    await page.waitForTimeout(800).catch(() => {});
  }

  await context.close();

  const total = countInfluencers(MIN_FOLLOWERS);
  console.log(`\n\n✅ Done! ${saved} profiles with ${MIN_FOLLOWERS / 1000}K+ followers saved`);
  console.log(`👥 Total in database: ${total}`);
  if (total > 0) console.log('\nNow run: node run-promoter.js\n');
  else console.log('\n⚠️  No 15K+ accounts found — try running again or LinkedIn search returned local accounts.\n');
})();
