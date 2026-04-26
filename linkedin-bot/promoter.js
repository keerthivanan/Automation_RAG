const { chromium } = require('playwright');
const path = require('path');
const OpenAI = require('openai');
const { listInfluencers, isCommented, markCommented, getStats, saveStats } = require('./db');

const BROWSER_PROFILE    = path.join(__dirname, 'browser-profile');
const MAX_DAILY_COMMENTS = 20;
const PROMOTION_RATIO    = 0.30;
const DELAY_BETWEEN_MS   = 45000;
const MAX_POST_AGE_HOURS = 6;
const MIN_FOLLOWERS      = 15000;

const PROMO_ENDINGS = [
  "We've been solving this exact problem at ",
  "This is exactly what we build at ",
  "Seen this pattern across clients — it's what drives our work at ",
  "We're tackling this challenge head-on at ",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shouldMention(stats) {
  if (stats.total === 0) return false;
  return (stats.mentions / stats.total) < PROMOTION_RATIO;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getHoursOld(datetime) {
  if (!datetime) return Infinity;
  const t = new Date(datetime);
  if (isNaN(t.getTime())) return Infinity;
  return (Date.now() - t.getTime()) / 3600000;
}

function loggedIn(url) {
  return !url.includes('/login') && !url.includes('/checkpoint') && !url.includes('/authwall');
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

async function generateComment(client, postText, authorFirstName) {
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `You are a senior AI/automation professional on LinkedIn.

Post by ${authorFirstName}:
"${postText.slice(0, 500)}"

Write a LinkedIn comment:
- 1 to 3 SHORT lines MAX — one line is often enough
- Announcement/update: appreciate naturally + add one relevant thought
- Insight/opinion: give your honest take from real experience
- Sound like a real practitioner, not a marketer
- Never start with: "Great post", "Love this", "Absolutely", "This is so true", "Congrats", "Impressive"
- No hashtags, no emojis, no bullet points
- Direct and human — peer talking to peer
- Do NOT mention any company or product
- Do NOT include @mentions

Output ONLY the comment text. Nothing else.`
    }]
  });
  return res.choices[0].message.content.trim();
}

// ─── Browser ──────────────────────────────────────────────────────────────────

async function createContext() {
  return chromium.launchPersistentContext(BROWSER_PROFILE, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-session-crashed-bubble',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
  });
}

async function ensureLoggedIn(context) {
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  if (loggedIn(page.url())) { console.log('✅ Already logged in'); return page; }

  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.fill('#username', process.env.LINKEDIN_EMAIL);
  await page.waitForTimeout(400 + Math.floor(Math.random() * 400));
  await page.fill('#password', process.env.LINKEDIN_PASSWORD);
  await page.waitForTimeout(400 + Math.floor(Math.random() * 400));
  await page.click('button[type="submit"]');

  console.log('⏳ Complete any 2FA in the browser...');
  await page.waitForFunction(
    () => { const u = window.location.href;
      return !u.includes('/login') && !u.includes('/checkpoint') &&
             !u.includes('/authwall') && !u.includes('/uas/'); },
    { timeout: 180000, polling: 1000 }
  );
  await page.waitForTimeout(2000);
  console.log(`✅ Logged in`);
  return page;
}

// ─── Get recent posts from an influencer profile ──────────────────────────────

async function getRecentPosts(page, slug) {
  const profileUrl = `https://www.linkedin.com/in/${slug}/recent-activity/all/`;

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // If redirected away (session issue, private profile), skip
  if (!page.url().includes('linkedin.com')) return [];

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
    await page.waitForTimeout(900);
  }

  const posts = await page.evaluate(() => {
    const extract = (root) => {
      const textEls = [...root.querySelectorAll('[data-testid="expandable-text-box"]')];
      if (!textEls.length) return null;

      return textEls.map((el, i) => {
        let node = el;
        let datetime = '', authorName = '';

        for (let d = 0; d < 15; d++) {
          node = node.parentElement;
          if (!node) break;

          // Timestamp
          const timeEl = node.querySelector('time[datetime]');
          if (timeEl && !datetime) datetime = timeEl.getAttribute('datetime') || '';

          // Author name
          const ctrl = node.querySelector('button[aria-label*="control menu for post"]');
          if (ctrl) {
            const m = (ctrl.getAttribute('aria-label') || '').match(/post by (.+)$/i);
            if (m) authorName = m[1].trim();
            break;
          }
        }

        return { text: el.innerText || el.textContent || '', datetime, authorName, index: i };
      });
    };

    let result = extract(document);
    if (!result?.length) {
      const host = document.querySelector('#interop-outlet');
      if (host?.shadowRoot) result = extract(host.shadowRoot);
    }
    return result || [];
  }).catch(() => []);

  const eligible = [];
  for (const p of posts) {
    const text = (p.text || '').trim();
    if (text.length < 80) continue;
    if (/buy now|try it free|sign up today|limited offer|coupon code|click the link/i.test(text)) continue;
    if (getHoursOld(p.datetime) > MAX_POST_AGE_HOURS) continue;

    const postId = `${slug}::${text.slice(0, 80).replace(/\s+/g, ' ')}`;
    if (isCommented(postId)) continue;

    eligible.push({ postId, text, index: p.index, authorName: p.authorName || slug,
                    hoursOld: getHoursOld(p.datetime) });
  }
  return eligible;
}

// ─── Post a comment ───────────────────────────────────────────────────────────

async function postComment(page, index, commentText, authorName, mentionDizilo) {
  // Verify page is still alive
  const alive = await page.evaluate(() => true).catch(() => false);
  if (!alive) return false;

  // Click Comment button via JS (bypasses shadow DOM + CSS-hidden buttons)
  const clicked = await page.evaluate((idx) => {
    const find = (root) => [...root.querySelectorAll('button')]
      .filter(b => (b.textContent || '').trim() === 'Comment');
    let btns = find(document);
    if (!btns.length) {
      const host = document.querySelector('#interop-outlet');
      if (host?.shadowRoot) btns = find(host.shadowRoot);
    }
    if (!btns[idx]) return false;
    btns[idx].scrollIntoView({ block: 'center', behavior: 'instant' });
    btns[idx].click();
    return true;
  }, index);
  if (!clicked) return false;

  await page.waitForTimeout(2500);

  // Wait for comment editor
  const editorReady = await page.waitForFunction(() => {
    const all = [...document.querySelectorAll('[contenteditable="true"]')];
    const host = document.querySelector('#interop-outlet');
    if (host?.shadowRoot) all.push(...host.shadowRoot.querySelectorAll('[contenteditable="true"]'));
    return all.some(e => { const r = e.getBoundingClientRect(); return r.width > 50 && r.height > 10; });
  }, { timeout: 10000, polling: 400 }).catch(() => null);
  if (!editorReady) return false;

  // Focus editor
  const focused = await page.evaluate(() => {
    const all = [...document.querySelectorAll('[contenteditable="true"]')];
    const host = document.querySelector('#interop-outlet');
    if (host?.shadowRoot) all.push(...host.shadowRoot.querySelectorAll('[contenteditable="true"]'));
    const el = all.find(e => { const r = e.getBoundingClientRect(); return r.width > 50 && r.height > 10; });
    if (!el) return false;
    el.focus(); return true;
  });
  if (!focused) return false;
  await page.waitForTimeout(300);

  // @mention the post author
  const firstName = (authorName || '').split(' ')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 5);
  if (firstName) {
    await page.keyboard.type(`@${firstName}`, { delay: 110 });
    await page.waitForTimeout(2200);

    // Try to click matching suggestion, fallback to ArrowDown+Enter
    const picked = await page.evaluate((name) => {
      const sel = '[role="option"], [data-test-typeahead-item], li[id*="typeahead"], li[id*="mention"]';
      const items = [...document.querySelectorAll(sel)];
      const host = document.querySelector('#interop-outlet');
      if (host?.shadowRoot) items.push(...host.shadowRoot.querySelectorAll(sel));
      for (const item of items) {
        if ((item.textContent || '').toLowerCase().includes(name.toLowerCase())) {
          item.click(); return true;
        }
      }
      return false;
    }, firstName);

    if (!picked) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(700);
    await page.keyboard.type(' ', { delay: 50 });
    await page.waitForTimeout(200);
  }

  // Insert opinion text at cursor (after @mention chip)
  await page.evaluate((text) => {
    document.execCommand('insertText', false, text);
  }, commentText);
  await page.waitForTimeout(500);

  // Optional @Dizilo promo ending
  if (mentionDizilo) {
    const ending = PROMO_ENDINGS[Math.floor(Math.random() * PROMO_ENDINGS.length)];
    await page.evaluate((t) => { document.execCommand('insertText', false, t); }, '\n\n' + ending);
    await page.waitForTimeout(400);
    await page.keyboard.type('@dizilo', { delay: 120 });
    await page.waitForTimeout(2200);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
  }

  await page.waitForTimeout(1000);

  // Submit
  const submitted = await page.evaluate(() => {
    const all = [...document.querySelectorAll('button')];
    const host = document.querySelector('#interop-outlet');
    if (host?.shadowRoot) all.push(...host.shadowRoot.querySelectorAll('button'));
    const btn = all.find(b => {
      const lbl = (b.getAttribute('aria-label') || b.textContent || '').trim();
      return /^(Post|Submit|Post comment|Add comment)$/i.test(lbl) && !b.disabled;
    });
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!submitted) await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(3000);
  return true;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  const stats      = getStats();
  const influencers = listInfluencers(MIN_FOLLOWERS);
  const client     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  if (influencers.length === 0) {
    console.log('\n❌  No 15K+ profiles in database. Run first: node fetch-influencers.js\n');
    return;
  }

  if (stats.total >= MAX_DAILY_COMMENTS) {
    console.log(`\n🛑  Already hit ${MAX_DAILY_COMMENTS} comments today. Come back tomorrow.\n`);
    return;
  }

  console.log(`\n🚀  Dizilo LinkedIn Promoter`);
  console.log(`👥  ${influencers.length} profiles in database`);
  console.log(`📊  Today: ${stats.total}/${MAX_DAILY_COMMENTS} | @Dizilo: ${stats.mentions}\n`);

  const context = await createContext();
  const page    = await ensureLoggedIn(context);
  let done = 0;
  let contextLost = false;

  const shuffled = [...influencers].sort(() => Math.random() - 0.5);

  for (const slug of shuffled) {
    if (stats.total >= MAX_DAILY_COMMENTS || contextLost) break;

    process.stdout.write(`\n  @${slug}... `);

    // Get recent posts from this influencer
    let posts = [];
    try {
      posts = await getRecentPosts(page, slug);
    } catch (err) {
      if (err.message.includes('closed') || err.message.includes('Target page')) {
        contextLost = true; console.log('browser closed'); break;
      }
      console.log(`error: ${err.message.slice(0, 60)}`);
      continue;
    }

    if (posts.length === 0) { console.log('no recent posts'); continue; }

    console.log(`${posts.length} recent post(s)`);

    // Only comment on the FIRST eligible post per influencer (avoids page state issues)
    const post = posts[0];
    const { postId, text, authorName, index, hoursOld } = post;

    try {
      const mention   = shouldMention(stats);
      const label     = mention ? '🎯 @Dizilo' : '💡 value';
      const firstName = (authorName || slug).split(' ')[0];

      console.log(`\n  [${stats.total + 1}/${MAX_DAILY_COMMENTS}] @${slug} | ${label} | ${hoursOld.toFixed(1)}h ago`);
      console.log(`  📄 "${text.slice(0, 120)}..."`);

      const comment = await generateComment(client, text, firstName);
      const preview = (firstName ? `@${firstName} ` : '') + comment
                    + (mention ? `\n\n${PROMO_ENDINGS[0]}@Dizilo` : '');
      console.log(`  💬 ${preview}`);

      // Post comment — we're still on the influencer's recent-activity page
      const posted = await postComment(page, index, comment, authorName, mention);

      if (posted) {
        console.log('  ✅ Posted!');
        markCommented(postId);
        stats.total++;
        if (mention) stats.mentions++;
        saveStats(stats);
        done++;

        const ratio = Math.round((stats.mentions / stats.total) * 100);
        console.log(`  📊 ${stats.total}/${MAX_DAILY_COMMENTS} | @Dizilo: ${stats.mentions} (${ratio}%)`);

        if (stats.total < MAX_DAILY_COMMENTS) {
          console.log(`  ⏳ Waiting ${DELAY_BETWEEN_MS / 1000}s before next comment...`);
          // Keep alive check during wait
          for (let i = 0; i < DELAY_BETWEEN_MS / 5000; i++) {
            await page.waitForTimeout(5000).catch(() => {});
            const alive = await page.evaluate(() => true).catch(() => false);
            if (!alive) { contextLost = true; break; }
          }
          if (contextLost) { console.log('  ↩️  Browser closed — stopping'); break; }
        }
      } else {
        console.log('  ⚠️  Could not post — skipping');
      }
    } catch (err) {
      if (err.message.includes('closed') || err.message.includes('Target page')) {
        contextLost = true; console.log('  ↩️  Browser closed — stopping');
      } else {
        console.error(`  ❌ ${err.message}`);
      }
    }
  }

  console.log(`\n✅  Done! ${done} comments posted today`);
  console.log(`📊  Total: ${stats.total}/${MAX_DAILY_COMMENTS} | @Dizilo mentions: ${stats.mentions}\n`);
  await context.close().catch(() => {});
}

module.exports = { run };
