// Smoke tests for the Fast Start Hub New Tab page in a running Fast Browser.
// Connects to the browser over the remote debugging port and checks behavior.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const results = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('chrome://newtab/', { waitUntil: 'load' }).catch((e) => errors.push('goto: ' + e.message));
  await sleep(1500);

  const isHub = await page.$('#searchInput') !== null && await page.$('#worldClocks') !== null;
  check('Fast Start Hub is the New Tab page', isHub);
  if (!isHub) {
    await page.screenshot({ path: path.join(outDir, 'newtab-not-hub.png'), fullPage: true });
    results.push('NOTE  Hub elements not found; see newtab-not-hub.png');
  } else {
    // Open settings and check World Clock search inputs
    await page.click('#settingsButton');
    await sleep(300);
    const tzCount = await page.$$eval('input.tz-search', (els) => els.length);
    check('3 searchable World Clock inputs exist', tzCount === 3, `count=${tzCount}`);

    await page.evaluate(() => { const i = document.querySelector('input.tz-search'); i.focus(); i.select(); });
    await page.keyboard.type('Dubai');
    await page.keyboard.press('Enter');
    await sleep(400);
    const v1 = await page.$eval('input.tz-search', (e) => e.value);
    check('valid city "Dubai" accepted', v1.toLowerCase() === 'dubai', `value=${v1}`);

    await page.evaluate(() => { const i = document.querySelector('input.tz-search'); i.focus(); i.select(); });
    await page.keyboard.type('Nowheresville');
    await page.keyboard.press('Enter');
    await sleep(300);
    const v2 = await page.$eval('input.tz-search', (e) => e.value);
    check('invalid city reverts to previous', v2.toLowerCase() === 'dubai', `value=${v2}`);

    await page.reload({ waitUntil: 'load' });
    await sleep(1200);
    await page.click('#settingsButton');
    await sleep(300);
    const v3 = await page.$eval('input.tz-search', (e) => e.value);
    check('city persists after reload', v3.toLowerCase() === 'dubai', `value=${v3}`);

    const credit = await page.$('.weather-credit');
    check('Open-Meteo credit element removed', !credit);

    const underlined = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.textDecorationLine.includes('underline') && el.offsetParent !== null && el.innerText && el.innerText.trim()) {
          out.push(el.tagName + ' :: ' + el.innerText.trim().slice(0, 60));
        }
      }
      return out;
    });
    check('no visible underlined text (attribution underline gone)', underlined.length === 0, underlined.slice(0, 3).join(' || '));
  }

  await page.screenshot({ path: path.join(outDir, 'newtab.png'), fullPage: true });
  check('no page errors', errors.length === 0, errors.slice(0, 5).join(' || '));

  fs.writeFileSync(path.join(outDir, 'results.txt'), results.join('\n') + '\n');
  console.log(results.join('\n'));
  await browser.disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  const msg = 'HARNESS ERROR: ' + (e && e.stack ? e.stack : e);
  console.error(msg);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'results.txt'), msg + '\n');
  } catch (_) {}
  process.exit(2);
});
