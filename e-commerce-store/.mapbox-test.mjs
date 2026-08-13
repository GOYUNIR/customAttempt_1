import { chromium } from 'playwright-core';

const BASE = 'http://localhost:3000';
const FAKE_TOKEN = 'pk_test_dummy_invalid_token_for_attach_check';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript((token) => {
  window.ENV_MAPBOX_TOKEN = token;
}, FAKE_TOKEN);

const page = await context.newPage();

const consoleLogs = [];
const failedRequests = [];
const mapboxRequests = [];

page.on('console', (msg) => {
  consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
});
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('api.mapbox.com')) {
    mapboxRequests.push(`${req.method()} ${u.split('?')[0]}`);
  }
});
page.on('requestfailed', (req) => {
  failedRequests.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`);
});
page.on('response', (resp) => {
  const u = resp.url();
  if (u.includes('api.mapbox.com')) {
    mapboxRequests.push(`RESP ${resp.status()} ${u.split('?')[0]}`);
  }
});

console.log('>> Navigating to product page...');
await page.goto(`${BASE}/elysian-white-launch-draw`, { waitUntil: 'domcontentloaded', timeout: 30000 });

// Wait for the address input to mount.
await page.waitForSelector('input[autocomplete="shipping street-address"]', { timeout: 15000 });

await page.waitForTimeout(4000); // let the SDK lazy-load + attach

const state = await page.evaluate(() => {
  const input = document.querySelector('input[autocomplete="shipping street-address"]');
  const searchMarker = document.getElementById('search-js');
  const listboxes = Array.from(document.querySelectorAll('mapbox-search-listbox, [class*="Search"]')).map((el) => el.tagName + '|' + el.className);
  return {
    status: window.__GOYUNIR_MAPBOX__ || null,
    inputExists: !!input,
    inputName: input ? input.getAttribute('name') : null,
    inputRole: input ? input.getAttribute('role') : null,
    inputAriaAutocomplete: input ? input.getAttribute('aria-autocomplete') : null,
    inputLpIgnore: input ? input.getAttribute('data-lpignore') : null,
    dataMapboxToken: searchMarker ? searchMarker.getAttribute('data-mapbox-token') : null,
    listboxesOnBody: listboxes,
    bodyChildrenContainingSearch: Array.from(document.body.children).filter((el) => el.tagName.includes('MAPBOX') || el.tagName.includes('SEARCH')).map((el) => el.tagName),
  };
});

console.log('==== ATTACH STATE ====');
console.log(JSON.stringify(state, null, 2));

console.log('>> Focusing address input and typing...');
await page.click('input[autocomplete="shipping street-address"]');
await page.type('input[autocomplete="shipping street-address"]', '1600 Pennsylvania Ave', { delay: 80 });
await page.waitForTimeout(3000);

// Inspect whether a results dropdown exists and is visible.
const dropdownState = await page.evaluate(() => {
  const hosts = Array.from(document.querySelectorAll('mapbox-search-listbox'));
  const out = hosts.map((host) => {
    let root = host.shadowRoot;
    const mapboxSearch = root ? root.querySelector('.MapboxSearch') : null;
    const results = root ? root.querySelector('.Results') : null;
    let style = null;
    if (mapboxSearch) {
      const cs = getComputedStyle(mapboxSearch);
      style = { display: cs.display, width: cs.width, position: cs.position, zIndex: cs.zIndex };
    }
    return {
      tag: host.tagName,
      shadow: !!root,
      mapboxSearchDisplay: mapboxSearch ? style : null,
      resultsAriaHidden: results ? results.getAttribute('aria-hidden') : null,
      resultsChildren: results ? results.childElementCount : null,
      resultsTop: results ? results.style.top : null,
      resultsLeft: results ? results.style.left : null,
      suggestionCount: results ? results.querySelectorAll('[class*="Suggestion"]').length : null,
    };
  });
  return { hosts, input: (() => {
    const i = document.querySelector('input[autocomplete="shipping street-address"]');
    return i ? { name: i.getAttribute('name'), role: i.getAttribute('role'), ariaExpanded: i.getAttribute('aria-expanded') } : null;
  })() };
});

console.log('==== DROPDOWN STATE AFTER TYPING ====');
console.log(JSON.stringify(dropdownState, null, 2));

console.log('==== MAPBOX NETWORK ====');
console.log(mapboxRequests.length ? mapboxRequests.join('\n') : '(no api.mapbox.com requests observed)');

console.log('==== FAILED REQUESTS ====');
console.log(failedRequests.length ? failedRequests.join('\n') : '(none)');

console.log('==== CONSOLE (last 25) ====');
console.log(consoleLogs.slice(-25).join('\n'));

await browser.close();
