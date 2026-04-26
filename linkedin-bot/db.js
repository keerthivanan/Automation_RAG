const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'bot.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS influencers (
    slug        TEXT PRIMARY KEY,
    name        TEXT DEFAULT '',
    followers   INTEGER DEFAULT 0,
    checked_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS commented_posts (
    post_id       TEXT PRIMARY KEY,
    commented_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    date      TEXT PRIMARY KEY,
    total     INTEGER DEFAULT 0,
    mentions  INTEGER DEFAULT 0
  );
`);

function today() { return new Date().toISOString().split('T')[0]; }

// ── Influencers ───────────────────────────────────────────────────────────────

const stmtUpsertInfluencer = db.prepare(
  'INSERT OR REPLACE INTO influencers VALUES (?, ?, ?, ?)'
);
const stmtGetInfluencer = db.prepare(
  'SELECT * FROM influencers WHERE slug = ?'
);
const stmtListInfluencers = db.prepare(
  'SELECT slug FROM influencers WHERE followers >= ? ORDER BY followers DESC'
);

function saveInfluencer(slug, name, followers) {
  stmtUpsertInfluencer.run(slug, name || '', followers, new Date().toISOString());
}

function getInfluencer(slug) {
  return stmtGetInfluencer.get(slug) || null;
}

function listInfluencers(minFollowers) {
  return stmtListInfluencers.all(minFollowers).map(r => r.slug);
}

function countInfluencers(minFollowers) {
  return db.prepare('SELECT COUNT(*) as n FROM influencers WHERE followers >= ?').get(minFollowers).n;
}

// ── Commented Posts ───────────────────────────────────────────────────────────

const stmtIsCommented   = db.prepare('SELECT 1 FROM commented_posts WHERE post_id = ?');
const stmtMarkCommented = db.prepare('INSERT OR IGNORE INTO commented_posts VALUES (?, ?)');

function isCommented(postId)  { return !!stmtIsCommented.get(postId); }
function markCommented(postId){ stmtMarkCommented.run(postId, new Date().toISOString()); }

// ── Daily Stats ───────────────────────────────────────────────────────────────

function getStats() {
  return db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(today())
      || { date: today(), total: 0, mentions: 0 };
}

function saveStats(s) {
  db.prepare('INSERT OR REPLACE INTO daily_stats VALUES (?, ?, ?)').run(s.date, s.total, s.mentions);
}

module.exports = { saveInfluencer, getInfluencer, listInfluencers, countInfluencers,
                   isCommented, markCommented, getStats, saveStats };
