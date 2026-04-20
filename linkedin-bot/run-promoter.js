require('dotenv').config();
const { run } = require('./promoter');

const missing = ['OPENAI_API_KEY', 'LINKEDIN_EMAIL', 'LINKEDIN_PASSWORD']
  .filter(k => !process.env[k]);

if (missing.length) {
  console.error(`\n❌ Missing in .env: ${missing.join(', ')}\n`);
  process.exit(1);
}

console.log('🚀 Starting Dizilo LinkedIn Promoter...\n');
run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
