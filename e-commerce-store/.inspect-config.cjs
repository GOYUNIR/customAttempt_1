const { Redis } = require('@upstash/redis');
const fs = require('fs');
const env = fs.readFileSync('.env.local', 'utf8');
function getEnv(key) {
  const re = new RegExp('^' + key + '="?([^\\r\\n"]+)', 'm');
  const m = env.match(re);
  return m ? m[1].trim() : '';
}
(async () => {
  const r = new Redis({
    url: getEnv('UPSTASH_REDIS_REST_URL'),
    token: getEnv('UPSTASH_REDIS_REST_TOKEN'),
  });
  const raw = await r.get('store:config');
  const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
  console.log('themeColors:', JSON.stringify(c.themeColors, null, 1));
  console.log('availableSizes:', JSON.stringify(c.availableSizes));
  console.log('borderRadius value/type:', JSON.stringify(c.themeColors.borderRadius), typeof c.themeColors.borderRadius);
})().catch((e) => { console.error(e); process.exit(1); });
