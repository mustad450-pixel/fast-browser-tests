// Native-feature checks for Fast Browser (Tab Usage Timer, Dark Sites, product identity).
// Runs after newtab-smoke.js against the same browser session.
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

// Find an element inside nested shadow roots.
async function deepQuery(page, selector) {
  return page.evaluateHandle((sel) => {
    const walk = (root) => {
      const hit = root.querySelector(sel);
      if (hit) return hit;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const found = walk(el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(document);
  }, selector);
}

function findFile(dir, name) {
  let best = null;
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name === name) {
        const m = fs.statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    }
  };
  try { visit(dir); } catch (e) {}
  return best ? best.p : null;
}

function utf16Contains(buffer, text) {
  return buffer.includes(Buffer.from(text, 'utf16le'));
}

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  // 1. Tab Usage Timer on Settings > Appearance
  await page.goto('chrome://settings/appearance', { waitUntil: 'load' }).catch(() => {});
  await sleep(2000);
  const dropdownHandle = await deepQuery(page, '#fastBrowserTabUsageTimer');
  const dropdownFound = (await dropdownHandle.evaluate((e) => !!e).catch(() => false));
  check('Tab Usage Timer dropdown exists on Appearance page', dropdownFound);

  const profileDir = process.env.PROFILE_DIR || '';
  const readSavedMode = () => {
    const prefsFile = findFile(profileDir, 'Preferences');
    if (!prefsFile) return { file: null, value: 'no Preferences file' };
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
      const v = prefs?.fast_browser?.tab_usage_timer_mode;
      return { file: prefsFile, value: v === undefined ? 'not stored (default 0)' : v };
    } catch (e) { return { file: prefsFile, value: 'parse error: ' + e.message }; }
  };

  if (dropdownFound) {
    const selectHandle = await dropdownHandle.evaluateHandle((host) => {
      const find = (root) => {
        const s = root.querySelector && root.querySelector('select');
        if (s) return s;
        for (const el of (root.querySelectorAll ? root.querySelectorAll('*') : [])) {
          if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; }
        }
        return null;
      };
      return find(host.shadowRoot || host) || null;
    });
    const hasSelect = await selectHandle.evaluate((e) => !!e).catch(() => false);
    check('Tab Usage Timer has a selectable control', hasSelect);

    if (hasSelect) {
      // Wait up to 20 seconds for the dropdown to finish loading its options and saved value.
      let state = null;
      for (let i = 0; i < 20; i++) {
        state = await selectHandle.evaluate((s) => ({
          value: s.value,
          label: s.options[s.selectedIndex] ? s.options[s.selectedIndex].text.trim() : '',
          options: Array.from(s.options).map((o) => o.text.trim()),
        }));
        if (state.options.length === 3 && state.options.every((o) => o !== 'Custom')) break;
        await sleep(1000);
      }
      results.push(`INFO  initial dropdown label="${state.label}" options=${JSON.stringify(state.options)} saved=${JSON.stringify(readSavedMode())}`);

      check('Tab Usage Timer options are exactly Off, Active Tab, Browser Session',
        JSON.stringify(state.options) === JSON.stringify(['Off', 'Active Tab', 'Browser Session']),
        `options=${JSON.stringify(state.options)}`);
      check('Tab Usage Timer starts on "Off" for a fresh profile', state.label === 'Off', `label=${state.label}`);

      const waitForSaved = async (expected) => {
        let saved = readSavedMode();
        for (let i = 0; i < 10 && String(saved.value) !== expected; i++) {
          await sleep(1000);
          saved = readSavedMode();
        }
        return saved;
      };

      for (const [value, label] of [['1', 'Active Tab'], ['2', 'Browser Session'], ['0', 'Off']]) {
        await selectHandle.evaluate((s, v) => {
          s.value = v;
          s.dispatchEvent(new Event('input', { bubbles: true }));
          s.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        const saved = await waitForSaved(value);
        const ui = await selectHandle.evaluate((s) => ({
          value: s.value,
          label: s.options[s.selectedIndex] ? s.options[s.selectedIndex].text.trim() : '',
        }));
        results.push(`INFO  after selecting "${label}": ui=${JSON.stringify(ui)} saved=${JSON.stringify(saved.value)}`);
        check(`Selecting "${label}" is saved to Preferences`, String(saved.value) === value,
          `saved=${JSON.stringify(saved.value)} ui=${ui.label}`);
      }
    }
  }

  // 2. Dark Sites action label compiled into chrome.dll
  const appDir = path.dirname(process.env.CHROME_EXE || '');
  const dll = findFile(path.dirname(appDir), 'chrome.dll');
  if (dll) {
    const bytes = fs.readFileSync(dll);
    check('Dark Sites On label present in chrome.dll', utf16Contains(bytes, 'Dark Sites: On'));
    check('Dark Sites Off label present in chrome.dll', utf16Contains(bytes, 'Dark Sites: Off'));
  } else {
    check('chrome.dll found for Dark Sites label check', false, `searched under ${appDir}`);
  }

  // 3. Product identity from the installed executable
  const exe = process.env.CHROME_EXE || '';
  const info = exe && fs.existsSync(exe) ? fs.statSync(exe) : null;
  check('chrome.exe exists', !!info, exe);
  if (info) {
    const ps = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command',
      `$i=(Get-Item '${exe}').VersionInfo; "$($i.ProductName)|$($i.FileDescription)"`], { encoding: 'utf8' }).trim();
    const [product, desc] = ps.split('|');
    check('Executable product name contains "Fast Krozer"', /Fast Krozer/i.test(product || ''), `product="${product}"`);
    check('Executable description contains "Fast Krozer"', /Fast Krozer/i.test(desc || ''), `description="${desc}"`);
    const iconOk = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Drawing; if ([System.Drawing.Icon]::ExtractAssociatedIcon('${exe}')) {'yes'} else {'no'}`],
      { encoding: 'utf8' }).trim();
    check('Executable has an application icon', iconOk === 'yes');
  }

  await page.close().catch(() => {});
  fs.appendFileSync(path.join(outDir, 'results.txt'), '\n[native]\n' + results.join('\n') + '\n');
  console.log(results.join('\n'));
  await browser.disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.message); process.exit(2); });
