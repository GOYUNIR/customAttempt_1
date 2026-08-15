import { chromium } from 'playwright-core';

const BASE = 'http://localhost:3000';
const FAKE_TOKEN = 'pk.eyJ1IjoiZmFrZSIsImEiOiJmYWtlIn0';

// Full feature returned by the retrieve endpoint.
function retrieveFeature() {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'address.mock-1',
        geometry: { type: 'Point', coordinates: [-77.0365, 38.8977] },
        properties: {
          mapbox_id: 'mock-1',
          feature_type: 'address',
          full_address: '1600 Pennsylvania Ave NW, Washington, DC 20500, United States',
          name: '1600 Pennsylvania Ave NW',
          place_formatted: 'Washington, DC 20500',
          address_line1: '1600 Pennsylvania Ave NW',
          address_level1: 'DC',
          address_level2: 'Washington',
          postcode: '20500',
          country: 'United States',
          country_code: 'us',
        },
      },
    ],
  };
}

function suggestPayload(accuracy) {
  return {
    suggestions: [
      {
        name: '1600 Pennsylvania Ave NW',
        feature_name: '1600 Pennsylvania Ave NW',
        address_line1: '1600 Pennsylvania Ave NW',
        place_formatted: 'Washington, DC 20500',
        full_address: '1600 Pennsylvania Ave NW, Washington, DC 20500, United States',
        feature_type: 'address',
        accuracy,
        action: { id: 'mock-1' },
      },
    ],
  };
}

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript((token) => {
  window.ENV_MAPBOX_TOKEN = token;
}, FAKE_TOKEN);

const page = await context.newPage();

const ACCURACY = process.env.SUGGEST_ACCURACY || 'street';
console.log('>> Using suggestion accuracy:', ACCURACY);

const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));

// Mock the Mapbox autofill API.
await page.route('https://api.mapbox.com/**', async (route) => {
  const url = route.request().url();
  if (url.includes('/autofill/v1/suggest')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(suggestPayload(ACCURACY)),
    });
  } else if (url.includes('/autofill/v1/retrieve/')) {
    console.log('>> retrieve API was CALLED');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(retrieveFeature()),
    });
  } else {
    await route.continue();
  }
});

console.log('>> Navigating to product page...');
await page.goto(`${BASE}/elysian-white-launch-draw`, { waitUntil: 'domcontentloaded', timeout: 40000 });

// Wait for the address input to mount.
await page.waitForSelector('input[autocomplete*="street-address"]', { timeout: 20000 });
await page.waitForTimeout(4000); // let the SDK lazy-load + attach

const input = page.locator('input[autocomplete*="street-address"]').first();
await input.click();
await input.pressSequentially('1600 Pennsylvania', { delay: 60 });
await page.waitForTimeout(2500);

// Check dropdown + select first suggestion via keyboard.
console.log('>> Pressing ArrowDown + Enter to pick the suggestion...');
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(300);
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);

const result = await page.evaluate(() => {
  const ins = Array.from(document.querySelectorAll('input[autocomplete*="street-address"], input[autocomplete*="address-line1"]'));
  const listboxes = Array.from(document.querySelectorAll('mapbox-search-listbox')).map((el) => el.tagName);
  return {
    inputs: ins.map((i) => ({
      value: i.value,
      autocomplete: i.getAttribute('autocomplete'),
      dataset: { fullFill: i.dataset.mapboxFullFill || '', verified: i.dataset.mapboxVerified || '' },
    })),
    listboxes,
    status: window.__GOYUNIR_MAPBOX__ || null,
  };
});

console.log('==== FINAL STATE ====');
console.log(JSON.stringify(result, null, 2));
console.log('==== CONSOLE (last 30) ====');
console.log(logs.slice(-30).join('\n'));

await browser.close();
