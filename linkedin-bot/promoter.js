const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const BROWSER_PROFILE = path.join(__dirname, 'browser-profile');
const COMMENTED_FILE = path.join(__dirname, 'commented_posts.json');

// ─── Dizilo context ───────────────────────────────────────────────────────────

const DIZILO = {
  name: 'Dizilo',
  what: 'We build AI agents, workflow automation systems, and e-commerce stores for businesses',
  results: "clients see 340% pipeline growth and 70% support cost reduction",
  speed: 'idea to production in 2 weeks',
  tagline: 'We build what makes every job easier'
};

// Hashtags where Dizilo's ideal customers hang out
const HASHTAGS = [
  'automation',
  'ecommerce',
  'artificialintelligence',
  'entrepreneur',
  'businessautomation',
  'shopify',
  'aiagents',
  'workflow',
  'startup',
  'productivity'
];

const MIN_LIKES = 30;          // only target posts with real engagement
const MAX_COMMENTS_PER_RUN = 8; // max comments per session (stay under radar)
const DELAY_BETWEEN_COMMENTS_MS = 50000; // ~50 seconds between comments

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

async function generateComment(client, postText) {
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 220,
    messages: [{
      role: 'user',
      content: `You are a LinkedIn professional who works at ${DIZILO.name}.

About ${DIZILO.name}: ${DIZILO.what}. ${DIZILO.results}. ${DIZILO.tagline}.

Here is a LinkedIn post getting good engagement:
"${postText.slice(0, 600)}"

Write a LinkedIn comment that:
1. Genuinely adds value or insight to the discussion — make it actually useful
2. If the topic naturally connects to what ${DIZILO.name} does (automation, AI, ecommerce, manual work, scaling), mention ${DIZILO.name} in ONE natural sentence — like "we've seen this firsthand at ${DIZILO.name}" or "this is exactly why we built ${DIZILO.name}"
3. If it doesn't connect naturally, write a good comment WITHOUT mentioning ${DIZILO.name} — a helpful comment still builds brand
4. Sound like a real person, not a company
5. 2-3 sentences MAX
6. No hashtags, no emojis, no "Great post!" or "This is so true!" openers
7. Never sound like an ad or a pitch

Output ONLY the comment text. Nothing else.`
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

// ─── Engagement parsing ───────────────────────────────────────────────────────

function parseLikeCount(text) {
  if (!text) return 0;
  const clean = text.replace(/,/g, '').trim().toLowerCase();
  if (clean.includes('k')) return Math.floor(parseFloat(clean) * 1000);
  return parseInt(clean) || 0;
}

// ─── Scan hashtag feed ────────────────────────────────────────────────────────

async function scanHashtag(page, hashtag, commented) {
  const found = [];

  await page.goto(`https://www.linkedin.com/feed/hashtag/${hashtag}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
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

      const likes = parseLikeCount(likesText);
      if (likes < MIN_LIKES) continue;

      found.push({ post, postId, text, likes, hashtag });
    } catch { /* skip */ }
  }

  return found;
}

// ─── Post comment ─────────────────────────────────────────────────────────────

async function postComment(page, post, commentText) {
  // Click the Comment action button to open the comment box
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
  const commented = loadCommented();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const context = await createContext();
  const page = await ensureLoggedIn(context);

  console.log(`\n🚀 Dizilo LinkedIn Promoter`);
  console.log(`📌 Scanning ${HASHTAGS.length} hashtags for viral posts...\n`);

  // Collect posts across all hashtags
  let allPosts = [];
  for (const hashtag of HASHTAGS) {
    process.stdout.write(`  #${hashtag}... `);
    const posts = await scanHashtag(page, hashtag, commented);
    console.log(`${posts.length} posts`);
    allPosts = allPosts.concat(posts);
  }

  // Deduplicate by postId
  const seen = new Set();
  allPosts = allPosts.filter(p => {
    if (seen.has(p.postId)) return false;
    seen.add(p.postId);
    return true;
  });

  // Sort: most viral first
  allPosts.sort((a, b) => b.likes - a.likes);

  const targets = allPosts.slice(0, MAX_COMMENTS_PER_RUN);
  console.log(`\n📊 ${allPosts.length} unique posts found — commenting on top ${targets.length}\n`);

  let done = 0;

  for (const { post, postId, text, likes, hashtag } of targets) {
    try {
      console.log(`\n[${done + 1}/${targets.length}] #${hashtag} — ${likes} likes`);
      console.log(`  📄 "${text.slice(0, 120)}..."`);

      const comment = await generateComment(client, text);
      console.log(`  💬 "${comment}"`);

      await page.waitForTimeout(Math.floor(4000 + Math.random() * 4000));

      const posted = await postComment(page, post, comment);

      if (posted) {
        console.log('  ✅ Posted!');
        commented.add(postId);
        saveCommented(commented);
        done++;

        if (done < targets.length) {
          console.log(`  ⏳ Waiting ${DELAY_BETWEEN_COMMENTS_MS / 1000}s...`);
          await page.waitForTimeout(DELAY_BETWEEN_COMMENTS_MS);
        }
      } else {
        console.log('  ⚠️  Could not post — comment button not found');
      }
    } catch (err) {
      console.error(`  ❌ ${err.message}`);
    }
  }

  console.log(`\n✅ Done! Commented on ${done} posts.`);
  await context.close();
}

module.exports = { run };
