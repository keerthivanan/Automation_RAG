const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const REPLIED_FILE = path.join(__dirname, 'replied.json');

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadReplied() {
  if (!fs.existsSync(REPLIED_FILE)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(REPLIED_FILE, 'utf-8')));
  } catch {
    return new Set();
  }
}

function saveReplied(set) {
  fs.writeFileSync(REPLIED_FILE, JSON.stringify([...set], null, 2));
}

function saveCookies(cookies) {
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
}

function mySlug() {
  const url = process.env.LINKEDIN_PROFILE_URL || '';
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

async function generateReply(client, commentText) {
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `You are replying to a LinkedIn comment on my behalf.

My background: ${process.env.BUSINESS_CONTEXT || 'I am a professional sharing insights on LinkedIn.'}

Comment: "${commentText}"

Write a genuine 1–2 sentence LinkedIn reply. Acknowledge their comment, add value, invite conversation. No hashtags, no emojis, no "Great insight!" openers. Output reply text only.`
    }]
  });
  return res.choices[0].message.content.trim();
}

// ─── Browser ──────────────────────────────────────────────────────────────────

async function createBrowser() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US'
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  return { browser, context };
}

// ─── Login ────────────────────────────────────────────────────────────────────

function loggedIn(url) {
  return !url.includes('/login') && !url.includes('/checkpoint') && !url.includes('/authwall');
}

async function ensureLoggedIn(context, existingPage = null) {
  const page = existingPage || await context.newPage();

  if (!existingPage) {
    // Try 1: saved cookies from previous runs (freshest session)
    if (fs.existsSync(COOKIES_FILE)) {
      try {
        await context.addCookies(JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8')));
      } catch { /* bad file — skip */ }

      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      if (loggedIn(page.url())) {
        console.log('✅ Session restored from saved cookies');
        return page;
      }
      console.log('⚠️  Saved session expired');
    }

    // Try 2: li_at cookie from env (no login form, no 2FA)
    if (process.env.LINKEDIN_LI_AT) {
      await context.addCookies([{
        name: 'li_at',
        value: process.env.LINKEDIN_LI_AT,
        domain: '.linkedin.com',
        path: '/',
        httpOnly: true,
        secure: true
      }]);

      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      if (loggedIn(page.url())) {
        console.log('✅ Logged in via li_at cookie');
        saveCookies(await context.cookies());
        return page;
      }
      console.log('⚠️  li_at expired — falling back to email/password');
    }
  }

  // Try 3: email/password fallback
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.fill('#username', process.env.LINKEDIN_EMAIL);
  await page.waitForTimeout(Math.floor(400 + Math.random() * 400));
  await page.fill('#password', process.env.LINKEDIN_PASSWORD);
  await page.waitForTimeout(Math.floor(400 + Math.random() * 400));
  await page.click('button[type="submit"]');

  console.log('⏳ Waiting for login — complete any 2FA in the browser window...');
  await page.waitForSelector('nav.global-nav', { timeout: 120000 });
  await page.waitForTimeout(2000);

  console.log('✅ Logged in successfully');
  saveCookies(await context.cookies());
  return page;
}

// ─── Comment helpers ──────────────────────────────────────────────────────────

async function getCommentId(comment) {
  const id = await comment.getAttribute('data-id').catch(() => null);
  if (id) return id;

  const authorPath = await comment.$eval(
    'a[href*="/in/"]',
    el => new URL(el.href).pathname.replace(/\/$/, '')
  ).catch(() => '');

  const text = await comment.$eval(
    '.comments-comment-item__main-content',
    el => el.innerText.trim().slice(0, 60)
  ).catch(() => '');

  return (authorPath || text) ? `${authorPath}::${text}` : null;
}

// LinkedIn hides Edit/Delete in a dropdown so they're never in the live DOM.
// Profile link comparison is the only reliable way to detect own comments.
async function isOwnComment(comment) {
  const slug = mySlug();
  if (!slug) return false;
  const href = await comment.$eval(
    '.comments-post-meta a[href*="/in/"], a.comments-post-meta__actor-link',
    el => el.href.toLowerCase()
  ).catch(() => '');
  return href.includes(`/in/${slug}`);
}

async function hasAlreadyReplied(comment) {
  const slug = mySlug();
  if (!slug) return false;
  const nested = await comment.$$('.comments-comment-item');
  for (const reply of nested) {
    const href = await reply.$eval(
      '.comments-post-meta a[href*="/in/"], a.comments-post-meta__actor-link',
      el => el.href.toLowerCase()
    ).catch(() => '');
    if (href.includes(`/in/${slug}`)) return true;
  }
  return false;
}

async function postReply(page, comment, replyText) {
  const replyBtn = await comment.$(
    'button[aria-label*="Reply"], button[aria-label*="reply"]'
  );
  if (!replyBtn) return false;

  await replyBtn.click();
  await page.waitForTimeout(2000);

  const replyBox = await comment.$('.ql-editor[contenteditable="true"]');
  if (!replyBox) return false;

  await replyBox.click();
  await page.waitForTimeout(400);
  await replyBox.type(replyText, { delay: Math.floor(55 + Math.random() * 35) });
  await page.waitForTimeout(1000);

  // Try submit button selectors in order — aria-label first (stable), CSS class as fallback
  for (const sel of [
    'button[aria-label="Post reply"]',
    'button[aria-label="Post comment"]',
    'button[aria-label="Done"]',
    'button.comments-comment-box__submit-button--cr',
    'button.comments-comment-box__submit-button',
  ]) {
    const btn = await comment.$(sel);
    if (btn && await btn.isEnabled()) {
      await btn.click();
      await page.waitForTimeout(2500);
      return true;
    }
  }

  // Keyboard fallback — Ctrl+Enter submits in LinkedIn's Quill editor
  await replyBox.press('Control+Return');
  await page.waitForTimeout(2500);
  return true;
}

// ─── Main scan ────────────────────────────────────────────────────────────────

async function checkAndReply(page, context, client, replied) {
  const profileUrl = process.env.LINKEDIN_PROFILE_URL.replace(/\/$/, '');
  const slug = mySlug();

  await page.goto(`${profileUrl}/recent-activity/all/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await page.waitForTimeout(4000);

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(800);
  }

  const posts = await page.$$('.feed-shared-update-v2');
  console.log(`  📄 Found ${posts.length} posts`);

  let count = 0;

  for (const post of posts) {
    try {
      // Skip posts NOT authored by me (recent-activity shows other people's posts too)
      if (slug) {
        const authorHref = await post.$eval(
          '.update-components-actor__meta a[href*="/in/"], ' +
          '.feed-shared-actor__meta a[href*="/in/"]',
          el => el.href.toLowerCase()
        ).catch(() => '');
        if (authorHref && !authorHref.includes(`/in/${slug}`)) continue;
      }

      // Expand comments — scoped to social counts area to avoid clicking "Write a comment"
      const commentBtn = await post.$(
        '.social-details-social-counts button[aria-label*="comment"], ' +
        '.social-details-social-counts button[aria-label*="Comment"]'
      );
      if (commentBtn) {
        await commentBtn.click();
        await page.waitForTimeout(3000);
      }

      const comments = await post.$$('.comments-comment-item');

      for (const comment of comments) {
        try {
          const commentId = await getCommentId(comment);
          if (!commentId || replied.has(commentId)) continue;

          if (await isOwnComment(comment)) {
            replied.add(commentId);
            continue;
          }

          if (await hasAlreadyReplied(comment)) {
            replied.add(commentId);
            continue;
          }

          const commentText = await comment.$eval(
            '.comments-comment-item__main-content',
            el => el.innerText.trim()
          ).catch(() => null);

          if (!commentText || commentText.length < 3) continue;

          console.log(`\n  💬 "${commentText.slice(0, 90)}"`);

          const reply = await generateReply(client, commentText);
          console.log(`  🤖 "${reply}"`);

          await page.waitForTimeout(Math.floor(2500 + Math.random() * 3500));

          const posted = await postReply(page, comment, reply);

          if (posted) {
            console.log('  ✅ Reply posted');
            replied.add(commentId);
            saveReplied(replied);
            saveCookies(await context.cookies());
            count++;
            await page.waitForTimeout(Math.floor(8000 + Math.random() * 6000));
          } else {
            console.log('  ⚠️  Could not post reply — reply button not found');
          }
        } catch (err) {
          console.error(`  ⚠️  Comment error: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`  ⚠️  Post error: ${err.message}`);
    }
  }

  return count;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  const interval = parseInt(process.env.CHECK_INTERVAL_MS || '180000');
  const replied = loadReplied();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const { browser, context } = await createBrowser();
  let page = await ensureLoggedIn(context);

  console.log(`\n🤖 Bot running — checking every ${interval / 1000}s`);
  console.log(`📍 ${process.env.LINKEDIN_PROFILE_URL}\n`);

  const tick = async () => {
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] 🔍 Checking comments...`);

    try {
      const url = page.url();
      if (url.includes('/login') || url.includes('/checkpoint') || url.includes('/authwall')) {
        console.log('  ⚠️  Session expired — re-logging in');
        page = await ensureLoggedIn(context, page);
        return;
      }

      const n = await checkAndReply(page, context, client, replied);
      if (n === 0) console.log('  📭 No new comments');
      else console.log(`  ✅ Replied to ${n} comment(s)\n`);
    } catch (err) {
      console.error(`  ❌ Tick error: ${err.message}`);
    }
  };

  await tick();
  setInterval(tick, interval);
  await new Promise(() => {});
}

module.exports = { run };
