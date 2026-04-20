const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const BROWSER_PROFILE = path.join(__dirname, 'browser-profile');
const COMMENTED_FILE  = path.join(__dirname, 'commented_posts.json');
const DAILY_FILE      = path.join(__dirname, 'daily_stats.json');

const MAX_DAILY_COMMENTS  = 20;   // hard stop at 20 comments per day
const PROMOTION_RATIO     = 0.30; // exactly 30% of comments mention Dizilo
const DELAY_BETWEEN_MS    = 50000; // 50s between comments — looks human

// ─── Dizilo ───────────────────────────────────────────────────────────────────

const DIZILO = {
  name: 'Dizilo',
  what: 'builds AI agents, workflow automation, and e-commerce stores for businesses',
  results: 'clients see 340% pipeline growth and 70% support cost reduction',
  tagline: 'We build what makes every job easier'
};

const HASHTAGS = [
  'automation', 'ecommerce', 'artificialintelligence',
  'entrepreneur', 'businessautomation', 'shopify',
  'aiagents', 'workflow', 'startup', 'productivity'
];

const MIN_LIKES = 30;

// ─── Daily stats ──────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0]; // '2026-04-21'
}

function loadDaily() {
  try {
    const data = JSON.parse(fs.readFileSync(DAILY_FILE, 'utf-8'));
    if (data.date !== today()) return { date: today(), total: 0, mentions: 0 };
    return data;
  } catch {
    return { date: today(), total: 0, mentions: 0 };
  }
}

function saveDaily(stats) {
  fs.writeFileSync(DAILY_FILE, JSON.stringify(stats, null, 2));
}

// ─── 30/70 ratio logic ────────────────────────────────────────────────────────

// Returns true if the NEXT comment should mention Dizilo,
// based on keeping the overall ratio close to 30%.
function shouldMention(stats) {
  if (stats.total === 0) return false; // never start with a promo
  const currentRatio = stats.mentions / stats.total;
  return currentRatio < PROMOTION_RATIO;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadCommented() {
  if (!fs.existsSync(COMMENTED_FILE)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(COMMENTED_FILE, 'utf-8')));
  } catch {
    return new Set();
  }
}

function saveCommented(set) {
  fs.writeFileSync(COMMENTED_FILE, JSON.stringify([...set], null, 2));
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

async function generateComment(client, postText, mentionDizilo) {
  // Explicit instruction switches based on 30/70 decision
  const mentionRule = mentionDizilo
    ? `Mention ${DIZILO.name} in ONE short natural sentence — something like "we've seen this exact pattern at ${DIZILO.name}" or "this is why we built ${DIZILO.name} — ${DIZILO.tagline}". Keep it conversational, never salesy.`
    : `Do NOT mention ${DIZILO.name} or any company at all. Write purely as an industry professional sharing a genuine insight or experience.`;

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `You are a LinkedIn professional with deep expertise in automation, AI, and e-commerce.

Post gaining engagement:
"${postText.slice(0, 600)}"

Write a comment that:
1. Leads with a real insight, perspective, or experience — make it genuinely useful
2. ${mentionRule}
3. 2-3 sentences MAX
4. No hashtags, no emojis
5. Never start with "Great post!", "This is so true!", "Love this!" or similar
6. Sound like a real person, not a brand account

Output ONLY the comment text.`
    }]
  });

  return res.choices[0].message.content.trim();
}

// ─── Browser ──────────────────────────────────────────────────────────────────

async function createContext() {
  return chromium.launchPersistentContext(BROWSER_PROFILE, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US'
  });
}

function loggedIn(url) {
  return !url.includes('/login') && !url.includes('/checkpoint') && !url.includes('/authwall');
}

async function ensureLoggedIn(context) {
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  if (loggedIn(page.url())) {
    console.log('✅ Already logged in');
    return page;
  }

  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.fill('#username', process.env.LINKEDIN_EMAIL);
  await page.waitForTimeout(Math.floor(400 + Math.random() * 400));
  await page.fill('#password', process.env.LINKEDIN_PASSWORD);
  await page.waitForTimeout(Math.floor(400 + Math.random() * 400));
  await page.click('button[type="submit"]');

  console.log('⏳ Complete any 2FA in the browser window...');
  await page.waitForSelector('nav.global-nav', { timeout: 120000 });
  await page.waitForTimeout(2000);
  console.log('✅ Logged in');
  return page;
}

// ─── Scan hashtag ─────────────────────────────────────────────────────────────

function parseLikes(text) {
  if (!text) return 0;
  const c = text.replace(/,/g, '').trim().toLowerCase();
  if (c.includes('k')) return Math.floor(parseFloat(c) * 1000);
  return parseInt(c) || 0;
}

async function scanHashtag(page, hashtag, commented) {
  const found = [];

  await page.goto(`https://www.linkedin.com/feed/hashtag/${hashtag}/`, {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await page.waitForTimeout(4000);

  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.waitForTimeout(700);
  }

  const posts = await page.$$('.feed-shared-update-v2');

  for (const post of posts) {
    try {
      const postId = await post.getAttribute('data-id').catch(() => null);
      if (!postId || commented.has(postId)) continue;

      const text = await post.$eval(
        '.feed-shared-update-v2__description, .feed-shared-text, .break-words',
        el => el.innerText.trim()
      ).catch(() => '');
      if (!text || text.length < 80) continue;

      const likesText = await post.$eval(
        '.social-details-social-counts__reactions-count',
        el => el.innerText.trim()
      ).catch(() => '0');

      const likes = parseLikes(likesText);
      if (likes < MIN_LIKES) continue;

      found.push({ post, postId, text, likes, hashtag });
    } catch { /* skip */ }
  }

  return found;
}

// ─── Post comment ─────────────────────────────────────────────────────────────

async function postComment(page, post, commentText) {
  const commentBtn = await post.$(
    'button[aria-label="Comment"], button[aria-label*="comment"]'
  );
  if (!commentBtn) return false;

  await commentBtn.click();
  await page.waitForTimeout(2500);

  const editor = await post.$('.ql-editor[contenteditable="true"]');
  if (!editor) return false;

  await editor.click();
  await page.waitForTimeout(400);
  await editor.type(commentText, { delay: Math.floor(60 + Math.random() * 30) });
  await page.waitForTimeout(1000);

  for (const sel of [
    'button[aria-label="Post comment"]',
    'button[aria-label="Add comment"]',
    'button.comments-comment-box__submit-button--cr',
    'button.comments-comment-box__submit-button',
  ]) {
    const btn = await post.$(sel);
    if (btn && await btn.isEnabled()) {
      await btn.click();
      await page.waitForTimeout(2500);
      return true;
    }
  }

  await editor.press('Control+Return');
  await page.waitForTimeout(2500);
  return true;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  const stats     = loadDaily();
  const commented = loadCommented();
  const client    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const remaining = MAX_DAILY_COMMENTS - stats.total;
  if (remaining <= 0) {
    console.log(`\n🛑 Already hit ${MAX_DAILY_COMMENTS} comments today. Come back tomorrow.\n`);
    return;
  }

  console.log(`\n🚀 Dizilo LinkedIn Promoter`);
  console.log(`📊 Today: ${stats.total}/${MAX_DAILY_COMMENTS} comments | ${stats.mentions} Dizilo mentions (${Math.round((stats.mentions / (stats.total || 1)) * 100)}%)`);
  console.log(`📌 Slots remaining today: ${remaining}`);
  console.log(`📌 Scanning hashtags...\n`);

  const context = await createContext();
  const page    = await ensureLoggedIn(context);

  // Collect posts
  let allPosts = [];
  for (const hashtag of HASHTAGS) {
    process.stdout.write(`  #${hashtag}... `);
    const posts = await scanHashtag(page, hashtag, commented);
    console.log(`${posts.length} posts`);
    allPosts = allPosts.concat(posts);
  }

  // Deduplicate
  const seen = new Set();
  allPosts = allPosts.filter(p => {
    if (seen.has(p.postId)) return false;
    seen.add(p.postId);
    return true;
  });

  // Sort by engagement
  allPosts.sort((a, b) => b.likes - a.likes);

  const targets = allPosts.slice(0, remaining);
  console.log(`\n📊 ${allPosts.length} unique posts — commenting on ${targets.length}\n`);

  let done = 0;

  for (const { post, postId, text, likes, hashtag } of targets) {
    try {
      const mention = shouldMention(stats);
      const label   = mention ? '🎯 DIZILO MENTION' : '💡 VALUE ONLY';

      console.log(`\n[${done + 1}/${targets.length}] #${hashtag} — ${likes} likes — ${label}`);
      console.log(`  📄 "${text.slice(0, 110)}..."`);

      const comment = await generateComment(client, text, mention);
      console.log(`  💬 "${comment}"`);

      await page.waitForTimeout(Math.floor(4000 + Math.random() * 4000));

      const posted = await postComment(page, post, comment);

      if (posted) {
        console.log('  ✅ Posted!');
        commented.add(postId);
        saveCommented(commented);

        stats.total++;
        if (mention) stats.mentions++;
        saveDaily(stats);

        done++;

        const ratio = Math.round((stats.mentions / stats.total) * 100);
        console.log(`  📊 Today: ${stats.total}/${MAX_DAILY_COMMENTS} | Dizilo mentions: ${stats.mentions} (${ratio}%)`);

        if (done < targets.length) {
          console.log(`  ⏳ Waiting ${DELAY_BETWEEN_MS / 1000}s...\n`);
          await page.waitForTimeout(DELAY_BETWEEN_MS);
        }
      } else {
        console.log('  ⚠️  Could not post');
      }
    } catch (err) {
      console.error(`  ❌ ${err.message}`);
    }
  }

  console.log(`\n✅ Done! ${done} comments posted today total: ${stats.total}/${MAX_DAILY_COMMENTS}`);
  console.log(`📊 Dizilo mentions: ${stats.mentions} / ${stats.total} = ${Math.round((stats.mentions / (stats.total || 1)) * 100)}%\n`);

  await context.close();
}

module.exports = { run };
