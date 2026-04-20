require('dotenv').config();
const { run } = require('./bot');

const missing = ['OPENAI_API_KEY', 'LINKEDIN_EMAIL', 'LINKEDIN_PASSWORD', 'LINKEDIN_PROFILE_URL']
  .filter(k => !process.env[k]);

if (missing.length) {
  console.error(`\n❌ Missing values in .env: ${missing.join(', ')}`);
  console.error('   Copy .env.example to .env and fill in the values.\n');
  process.exit(1);
}

console.log('🚀 Starting LinkedIn Auto-Reply Bot...\n');
run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
