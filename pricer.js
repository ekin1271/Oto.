/**
 * pricer.js  v4 + debug
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const https     = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_GROUP_ID  = process.env.GROUP_CHAT_ID;
const PARTNER_USER       = process.env.PARTNER_USER;
const PARTNER_PASS       = process.env.PARTNER_PASS;

const PASS_URL     = 'https://pass1.bibliki.ru';
const PARTNER_BASE = 'https://partner.bgoperator.ru';
const PARTNER_PRTN = '115810428452';
const PASS_WAIT_MS = 5 * 60 * 1000;
const EUR_API      = 'https://api.exchangerate-api.com/v4/latest/EUR';

const CLICKED_FILE = 'clicked_buttons.json';
const STATE_FILE   = 'price_state.json';

const AGENCY_RULES = [
  { pattern: '103810219', name: 'PENINSULA' },
  { pattern: '103816',    name: 'AKAY(FIT)' },
  { pattern: '103810175', name: 'SUMMER' },
  { pattern: '103810222', name: 'CARTHAGE' },
  { pattern: '103825',    name: 'KILIT GLOBAL' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtN(n)   { return String(n).padStart(2, '0'); }

// ─── Dosya helpers ────────────────────────────────────────────────────────────
function loadJson(f, def = {}) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }
function saveJson(f, d)        { fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8'); }

function isClicked(cb)    { return !!loadJson(CLICKED_FILE)[cb]; }
function markClicked(cb)  { const d = loadJson(CLICKED_FILE); d[cb] = new Date().toISOString(); saveJson(CLICKED_FILE, d); }
function unmarkClicked(cb){ const d = loadJson(CLICKED_FILE); delete d[cb]; saveJson(CLICKED_FILE, d); }

function loadState() { return loadJson(STATE_FILE); }
function markPriced(hotel, checkIn) {
  const st  = loadState();
  for (const key of Object.keys(st)) {
    if (key.startsWith(`${checkIn}__${hotel}`)) st[key] = 'priced';
  }
  saveJson(STATE_FILE, st);
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function tgReq(method, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const req  = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { let s = ''; res.on('data', d => s += d); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } }); }
    );
    req.on('error', () => resolve({}));
    req.write(data); req.end();
  });
}

async function sendMsg(text, extra = {}) {
  if (TELEGRAM_CHAT_ID)
    await tgReq('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', ...extra });
  if (TELEGRAM_GROUP_ID)
    await tgReq('sendMessage', { chat_id: TELEGRAM_GROUP_ID, text, parse_mode: 'HTML' });
}

async function answerCb(id, text)            { return tgReq('answerCallbackQuery', { callback_query_id: id, text }); }
async function editMarkup(chatId, msgId, mk) { return tgReq('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: mk }); }
async function getUpdates(offset)            { return tgReq('getUpdates', { offset, timeout: 30, allowed_updates: ['callback_query'] }); }

// ─── Screenshot → Telegram ────────────────────────────────────────────────────
async function sendScreenshot(page, caption) {
  try {
    const buf = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 });
    await new Promise(resolve => {
      const boundary = 'BOUNDARY123';
      const CRLF = '\r\n';
      const header =
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}` +
        `${TELEGRAM_CHAT_ID}${CRLF}` +
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="caption"${CRLF}${CRLF}` +
        `${caption}${CRLF}` +
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="photo"; filename="screen.jpg"${CRLF}` +
        `Content-Type: image/jpeg${CRLF}${CRLF}`;
      const footer = `${CRLF}--${boundary}--${CRLF}`;

      const headerBuf = Buffer.from(header, 'utf8');
      const footerBuf = Buffer.from(footer, 'utf8');
      const total     = headerBuf.length + buf.length + footerBuf.length;

      const req = https.request(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
        {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': total,
          },
        },
        res => { res.on('data', () => {}); res.on('end', resolve); }
      );
      req.on('error', resolve);
      req.write(headerBuf);
      req.write(buf);
      req.write(footerBuf);
      req.end();
    });
  } catch (e) {
    console.warn('[Screenshot] Gönderilemedi:', e.message);
  }
}

// HTML'in ilk N karakterini Telegram'a gönder (debug)
async function sendHtmlDebug(page, label) {
  try {
    const url  = page.url();
    const html = await page.content();
    const chunk = html.substring(0, 2500);
    await sendMsg(`🔍 <b>${label}</b>\nURL: <code>${url}</code>\n\n<pre>${chunk.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`);
  } catch (e) {
    console.warn('[HtmlDebug] Gönderilemedi:', e.message);
  }
}

// ─── EUR kuru ─────────────────────────────────────────────────────────────────
async function fetchEurRate() {
  return new Promise(resolve => {
    https.get(EUR_API, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => {
        try { const j = JSON.parse(s); resolve(j.rates?.RUB ?? null); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ─── 1. Pass ─────────────────────────────────────────────────────────────────
let passCompleted = false;

async function doPass(browser) {
  if (passCompleted) { console.log('[Pass] Zaten tamamlandı.'); return; }
  console.log('[Pass] pass1.bibliki.ru açılıyor...');
  await sendMsg('🔑 [1/3] Pass başlatıldı\npass1.bibliki.ru açılıyor...');

  const page = await browser.newPage();
  await page.authenticate({ username: PARTNER_USER, password: PARTNER_PASS });

  try {
    await page.goto(PASS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[Pass] Açıldı. 5 dakika bekleniyor...');
    await sendMsg('🔑 [1/3] Pass açıldı\n5 dakika IP whitelist bekleniyor...');
    await sleep(PASS_WAIT_MS);
    passCompleted = true;
    console.log('[Pass] Tamamlandı.');
    await sendMsg('✅ [1/3] Pass tamamlandı');
  } catch(e) {
    console.warn('[Pass] Hata:', e.message);
    await sendMsg(`⚠️ [1/3] Pass hatası: ${e.message}`);
  } finally {
    await page.close();
  }
}

// ─── 2. Partner login ─────────────────────────────────────────────────────────
async function partnerLogin(browser) {
  console.log('[Partner] Giriş yapılıyor...');
  await sendMsg('🔐 [2/3] Partner login başlatıldı\npartner.bgoperator.ru açılıyor...');

  const page = await browser.newPage();
  await page.authenticate({ username: PARTNER_USER, password: PARTNER_PASS });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 900 });

  await page.goto(`${PARTNER_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  const loginInput = await page.$('input[name="login"]');
  if (!loginInput) {
    console.log('[Partner] Zaten giriş yapılmış.');
    await sendMsg('✅ [2/3] Partner: Zaten giriş yapılmış\nTelegram callback bekleniyor...');
    return page;
  }

  await page.type('input[name="login"]',    PARTNER_USER, { delay: 60 });
  await page.type('input[name="password"]', PARTNER_PASS, { delay: 60 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.click('input[type="submit"]'),
  ]);
  await sleep(1500);

  console.log('[Partner] Giriş tamam.');
  await sendMsg('✅ [2/3] Partner: Giriş yapıldı\nTelegram callback bekleniyor...');
  return page;
}

// ─── Quick re-scrape ──────────────────────────────────────────────────────────
async function quickScrape(hotelId, checkIn) {
  const browser2 = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  try {
    const [d, m, y] = checkIn.split('.').map(Number);
    const ci = new Date(y, m-1, d);
    const co = new Date(ci); co.setDate(co.getDate() + 7);
    const fd = dt => `${fmtN(dt.getDate())}.${fmtN(dt.getMonth()+1)}.${dt.getFullYear()}`;
    const url = `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=121110211811&data=${fd(ci)}&d2=${fd(co)}&f7=7&f3=&f8=&ho=0&F4=${hotelId}&ins=0-40000-EUR&flt=100411293179&p=0100319900.0100319900`;

    const page = await browser2.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('div.b-pr', { timeout: 30000 }).catch(() => {});
    await sleep(2000);

    const rulesStr = JSON.stringify(AGENCY_RULES);
    const result = await page.evaluate((rs, td) => {
      const rules = JSON.parse(rs);
      function ida(u) { for (const r of rules) if (u.includes(r.pattern)) return r.name; return null; }
      for (const block of document.querySelectorAll('div.b-pr')) {
        let pen = null, rivalMin = null, rivalName = null;
        for (const tr of block.querySelectorAll('tr')) {
          const lis = tr.querySelectorAll('li.s8.i_t1');
          if (!lis.length) continue;
          let chosen = lis[0];
          for (const li of lis) if ((li.getAttribute('urr')||'').includes(td)) { chosen = li; break; }
          const ag = ida(chosen.getAttribute('urr')||'');
          if (!ag) continue;
          const pl = tr.querySelector('td.c_pe a[href]');
          if (!pl) continue;
          const mm = (pl.getAttribute('href')||'').match(/[?&]x=(\d+)/);
          const p  = mm ? parseInt(mm[1], 10) : null;
          if (!p) continue;
          if (ag === 'PENINSULA') { if (!pen || p < pen) pen = p; }
          else { if (!rivalMin || p < rivalMin) { rivalMin = p; rivalName = ag; } }
        }
        if (pen) return { penPrice: pen, rivalMin, rivalName };
      }
      return null;
    }, rulesStr, checkIn);

    await page.close();
    return result;
  } finally {
    await browser2.close();
  }
}

// ─── 3. PP fiyatı çek ─────────────────────────────────────────────────────────
async function fetchPpPrice(partnerPage, hotelName, checkIn) {
  const searchStr = hotelName.replace(/\s*[\d]+\*?\s*$/, '').trim();
  console.log(`[PP] ${hotelName} → arama: "${searchStr}" | ${checkIn}`);
  await sendMsg(`⏳ [3a] PP fiyatı çekiliyor\n${hotelName}\nArama: "${searchStr}" | ${checkIn}`);

  // ── Otel arama ──
  const searchUrl = `${PARTNER_BASE}/accomodation?task=hotels&pCountryId=100411293179&prtn=${PARTNER_PRTN}`;
  await partnerPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  await partnerPage.waitForSelector('input[name="searchHotel"]', { timeout: 10000 });
  await partnerPage.click('input[name="searchHotel"]', { clickCount: 3 });
  await partnerPage.type('input[name="searchHotel"]', searchStr, { delay: 80 });
  await sleep(500);
  await partnerPage.click('input[name="bSearchHotel"]');
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(2000);

  // DEBUG: Arama sonucu screenshot
  await sendScreenshot(partnerPage, `🔍 Arama sonucu: "${searchStr}"`);

  const hotelLink = await partnerPage.$('a[href*="task=hotels"][href*="hotelId="]')
                 || await partnerPage.$('a[href*="hotelId="]');
  if (!hotelLink) throw new Error(`Otel linki bulunamadı: ${hotelName}`);
  await hotelLink.click();
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(2000);

  // DEBUG: Otel sayfası screenshot
  await sendScreenshot(partnerPage, `🏨 Otel sayfası: ${hotelName}`);

  const nsLink = await partnerPage.$('a[href*="task=ns"]');
  if (!nsLink) {
    await sendHtmlDebug(partnerPage, 'NS linki YOK — sayfa HTML');
    throw new Error(`Final price linki yok: ${hotelName}`);
  }
  const nsHref = await partnerPage.evaluate(el => el.href, nsLink);
  await partnerPage.goto(nsHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // DEBUG: NS sayfası açıldı — hem screenshot hem HTML
  await sendScreenshot(partnerPage, `📄 NS sayfası açıldı: ${hotelName}`);
  await sendHtmlDebug(partnerPage, `NS sayfası HTML — ${hotelName}`);

  // ── Tarih ayarla ──
  const [d, m, y] = checkIn.split('.').map(Number);
  const from = new Date(y, m-1, d); from.setDate(from.getDate() + 10);
  const till = new Date(from);      till.setDate(till.getDate() + 14);
  const fromStr = `${fmtN(from.getDate())}.${fmtN(from.getMonth()+1)}.${from.getFullYear()}`;
  const tillStr = `${fmtN(till.getDate())}.${fmtN(till.getMonth()+1)}.${till.getFullYear()}`;
  console.log(`[PP] Validity aralığı: ${fromStr} - ${tillStr}`);

  await partnerPage.evaluate((f, t) => {
    const inputs = document.querySelectorAll('input.classDate');
    if (inputs.length >= 2) {
      inputs[0].value = f; inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      inputs[1].value = t; inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const pb = document.querySelector('#pBeg') || document.querySelector('input[name="pBeg"]');
    const pe = document.querySelector('#pEnd') || document.querySelector('input[name="pEnd"]');
    if (pb && pe) {
      pb.value = f; pb.dispatchEvent(new Event('change', { bubbles: true }));
      pe.value = t; pe.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, fromStr, tillStr);
  await sleep(500);

  // DEBUG: Sayfadaki tüm input ve butonları logla
  const allInputs = await partnerPage.evaluate(() =>
    [...document.querySelectorAll('input, button')].map(el => ({
      tag: el.tagName, type: el.type, name: el.name, id: el.id,
      value: el.value, class: el.className
    }))
  );
  console.log('[PP] Tüm input/butonlar:', JSON.stringify(allInputs));
  await sendMsg(`🔧 Input listesi:\n<pre>${JSON.stringify(allInputs, null, 2).substring(0, 2000)}</pre>`);

  // ── Show butonu — genişletilmiş arama ──
  const showBtn =
    await partnerPage.$('input[value="Show"]')            ||
    await partnerPage.$('input[value="Показать"]')        ||
    await partnerPage.$('input[value="show"]')            ||
    await partnerPage.$('#bShow')                         ||
    await partnerPage.$('input[name="bShow"]')            ||
    await partnerPage.$('button[type="submit"]')          ||
    await partnerPage.$('input[type="submit"]');

  if (showBtn) {
    const btnVal = await partnerPage.evaluate(el => el.value || el.textContent, showBtn);
    console.log(`[PP] Show butonu bulundu: "${btnVal}"`);
    await showBtn.click();
    await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(2000);
    // DEBUG: Show sonrası
    await sendScreenshot(partnerPage, `📊 Show sonrası: ${hotelName} | ${fromStr}-${tillStr}`);
  } else {
    console.warn('[PP] Show butonu bulunamadı!');
    await sendScreenshot(partnerPage, `⚠️ Show butonu YOK: ${hotelName}`);
  }

  // ── Fiyat çek ──
  const ppResult = await partnerPage.evaluate(() => {
    const greens = document.querySelectorAll("font[color='#339933']");
    for (const g of greens) {
      const txt   = g.textContent.trim();
      const match = txt.match(/^(\d+(?:[.,]\d+)?)\[/);
      if (match) {
        const total = parseFloat(match[1].replace(',', '.'));
        if (total > 0) return { ppPerNight: total / 2 / 7, source: 'Final(green)', totalFor14: total };
      }
    }
    const grays = document.querySelectorAll("font[color='#909090']");
    for (const g of grays) {
      const title   = g.getAttribute('title') || '';
      const dpMatch = title.match(/dp:\s*([\d.,\s]+)/);
      if (dpMatch) {
        const vals = dpMatch[1].split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v) && v > 0).slice(0, 7);
        if (vals.length > 0) {
          const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
          return { ppPerNight: avg / 2, source: 'Base(gray)', totalFor14: null };
        }
      }
    }
    return null;
  });

  if (!ppResult) {
    // DEBUG: fiyat bulunamadı — son durumu gönder
    await sendScreenshot(partnerPage, `❌ Fiyat bulunamadı: ${hotelName}`);
    await sendHtmlDebug(partnerPage, `Fiyat YOK sonrası HTML — ${hotelName}`);
    await sendMsg(`⚠️ [3a] PP fiyatı çekilemedi\nKontrat henüz açılmamış olabilir.`);
    throw new Error(`PP fiyatı bulunamadı: ${hotelName} (kontrat açılmamış olabilir)`);
  }

  console.log(`[PP] PP/gece: ${ppResult.ppPerNight.toFixed(4)} EUR (${ppResult.source})`);
  return ppResult;
}

// ─── 4. İndirim hesapla ───────────────────────────────────────────────────────
function calcDiscount(ppPerNightEur, peninsulaEUR, rivalEUR, eurRubRate) {
  const diffEur          = peninsulaEUR - rivalEUR;
  const ppNightDiff      = diffEur / 7 / 2;
  const targetPpPerNight = ppPerNightEur - ppNightDiff - 1;

  if (targetPpPerNight <= 0) {
    console.warn('[Hesap] Hedef PP negatif — fark çok büyük.');
    return null;
  }

  if (eurRubRate) {
    const rubDiff = (ppPerNightEur - targetPpPerNight) * eurRubRate;
    if (rubDiff < 100) {
      const minEurDiff     = 100 / eurRubRate;
      const adjustedTarget = ppPerNightEur - minEurDiff;
      if (adjustedTarget <= 0) { console.warn('[Hesap] 100 RUB hedef bile negatif.'); return null; }
      const disc = (adjustedTarget / ppPerNightEur) * 100;
      if (disc < 85 || disc >= 100) return null;
      console.log(`[Hesap] 100 RUB min uygulandı: %${disc.toFixed(3)}`);
      return disc;
    }
  }

  const discountPct = (targetPpPerNight / ppPerNightEur) * 100;
  console.log(`[Hesap] PP/gece: ${ppPerNightEur.toFixed(4)} | Hedef: ${targetPpPerNight.toFixed(4)} | İndirim: %${discountPct.toFixed(3)}`);
  if (discountPct < 85 || discountPct >= 100) {
    console.warn(`[Hesap] Güvenlik sınırı aşıldı (%${discountPct.toFixed(3)})`);
    return null;
  }
  return discountPct;
}

// ─── 5. Mass insert ───────────────────────────────────────────────────────────
async function applyMassInsert(partnerPage, hotelName, checkIn, discountPct) {
  const today  = new Date();
  const month  = parseInt(checkIn.split('.')[1], 10);
  const year   = parseInt(checkIn.split('.')[2], 10);
  const lastD  = new Date(year, month, 0).getDate();
  const fromD  = (year === today.getFullYear() && month === today.getMonth()+1) ? today.getDate() : 1;
  const validFrom = `${fmtN(fromD)}.${fmtN(month)}.${year}`;
  const validTill = `${fmtN(lastD)}.${fmtN(month)}.${year}`;

  console.log(`[MassInsert] ${hotelName} | ${validFrom}→${validTill} | %${discountPct.toFixed(3)}`);

  const searchStr = hotelName.replace(/\s*[\d]+\*?\s*$/, '').trim();
  const searchUrl = `${PARTNER_BASE}/accomodation?task=hotels&pCountryId=100411293179&prtn=${PARTNER_PRTN}`;
  await partnerPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  await partnerPage.waitForSelector('input[name="searchHotel"]', { timeout: 10000 });
  await partnerPage.click('input[name="searchHotel"]', { clickCount: 3 });
  await partnerPage.type('input[name="searchHotel"]', searchStr, { delay: 80 });
  await sleep(500);
  await partnerPage.click('input[name="bSearchHotel"]');
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(2000);

  const hotelLink = await partnerPage.$('a[href*="task=hotels"][href*="hotelId="]')
                 || await partnerPage.$('a[href*="hotelId="]');
  if (!hotelLink) throw new Error(`Otel bulunamadı: ${hotelName}`);
  await hotelLink.click();
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(2000);

  const massLink = await partnerPage.$('a[href*="task=staypay"]');
  if (!massLink) throw new Error(`Mass insert linki yok: ${hotelName}`);
  await massLink.click();
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(2000);

  await partnerPage.waitForSelector('select[name="pIdSpec"]', { timeout: 15000 });
  const submitted = await partnerPage.evaluate(() => {
    const sel = document.querySelector('select[name="pIdSpec"]');
    if (!sel) return false;
    for (const opt of sel.options) {
      if (opt.text.includes('Early booking on period (on percentage basis)')) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        if ((sel.getAttribute('onchange')||'').includes('submit') && sel.form) {
          sel.form.submit(); return 'submit';
        }
        return true;
      }
    }
    return false;
  });
  if (submitted === 'submit') {
    await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  }
  await sleep(2000);

  await partnerPage.waitForSelector('input[name="pPercPrice"]', { timeout: 15000 });
  await partnerPage.click('input[name="pPercPrice"]', { clickCount: 3 });
  await partnerPage.type('input[name="pPercPrice"]', discountPct.toFixed(3), { delay: 50 });
  await sleep(300);

  await partnerPage.evaluate((f, t) => {
    const tries = [['#frmIPBeg','#frmIPEnd'],['input[name="frmIPBeg"]','input[name="frmIPEnd"]'],['input[id*="IPBeg"]','input[id*="IPEnd"]']];
    for (const [fs, ts] of tries) {
      const fi = document.querySelector(fs), ti = document.querySelector(ts);
      if (fi && ti) {
        fi.value = f; fi.dispatchEvent(new Event('change',{bubbles:true}));
        ti.value = t; ti.dispatchEvent(new Event('change',{bubbles:true}));
        return;
      }
    }
  }, validFrom, validTill);
  await sleep(300);

  await partnerPage.evaluate(() => {
    for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
      const txt = (cb.closest('tr,td,div,label')?.textContent||'').toLowerCase();
      if ((txt.includes('current date and time') || txt.includes('disappearance')) && cb.checked) cb.click();
    }
  });
  await sleep(300);

  await partnerPage.evaluate(() => {
    for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
      const name = cb.getAttribute('name') || '';
      const cls  = cb.getAttribute('class') || '';
      if (name.startsWith('pNsId') || cls.includes('selectAllNS')) {
        if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true})); }
      }
    }
    for (const row of document.querySelectorAll('table.light tr, fieldset table tr')) {
      const tds = row.querySelectorAll('td');
      if (tds.length < 2) continue;
      for (const cb of tds[1].querySelectorAll('input[type="checkbox"]')) {
        if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true})); }
      }
      if (tds.length > 2) {
        for (const cb of tds[2].querySelectorAll('input[type="checkbox"]')) {
          const lbl = (cb.closest('label')?.textContent || cb.nextSibling?.textContent || '').trim();
          if (lbl.includes('Base price')) {
            if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true})); }
          } else {
            if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change',{bubbles:true})); }
          }
        }
      }
    }
    for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
      const lbl = (cb.closest('label')?.textContent || '').trim();
      if (lbl === 'AI') { if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change',{bubbles:true})); } }
    }
  });
  await sleep(500);

  const saveBtn = await partnerPage.$('input[value="Save"]')
               || await partnerPage.$('button[type="submit"]')
               || await partnerPage.$('input[type="submit"]');
  if (!saveBtn) throw new Error('Save butonu bulunamadı');

  console.log('[MassInsert] Save basılıyor...');
  await Promise.all([
    partnerPage.waitForNavigation({ waitUntil: 'networkidle0', timeout: 90000 }).catch(async () => {
      console.warn('[MassInsert] networkidle0 timeout, 8 sn bekleniyor...');
      await sleep(8000);
    }),
    saveBtn.click(),
  ]);
  await sleep(3000);
  console.log('[MassInsert] Kaydedildi.');
}

// ─── 6. Verify scrape ─────────────────────────────────────────────────────────
async function verifyScrape(hotelId, hotelName, checkIn) {
  console.log(`[Verify] ${hotelName} kontrol ediliyor... (5 dk bekleniyor)`);
  await sleep(5 * 60 * 1000);
  return quickScrape(hotelId, checkIn);
}

// ─── Ana işlem ────────────────────────────────────────────────────────────────
async function processOne(job, browser, partnerPage, eurRate) {
  const { hotelId, hotelName, checkIn, peninsulaEUR, rivalEUR, chatId, messageId, cbData } = job;

  await sendMsg(`⏳ Fiyat güncelleniyor...\n🏨 ${hotelName} | ${checkIn}`);

  const ppResult = await fetchPpPrice(partnerPage, hotelName, checkIn);

  const discountPct = calcDiscount(ppResult.ppPerNight, peninsulaEUR, rivalEUR, eurRate);
  if (!discountPct) throw new Error('İndirim hesaplanamadı (güvenlik sınırı veya negatif)');

  await sendMsg(
    `📐 [3b] Hesaplama tamamlandı\n` +
    `🏨 ${hotelName} | ${checkIn}\n` +
    `PP/gece: ${ppResult.ppPerNight.toFixed(4)} EUR (${ppResult.source})\n` +
    `Fark: ${peninsulaEUR - rivalEUR} EUR\n` +
    `Girilecek indirim: %${discountPct.toFixed(3)}`
  );

  await applyMassInsert(partnerPage, hotelName, checkIn, discountPct);

  const today     = new Date();
  const month     = parseInt(checkIn.split('.')[1], 10);
  const year      = parseInt(checkIn.split('.')[2], 10);
  const lastD     = new Date(year, month, 0).getDate();
  const fromD     = (year === today.getFullYear() && month === today.getMonth()+1) ? today.getDate() : 1;
  const validFrom = `${fmtN(fromD)}.${fmtN(month)}.${year}`;
  const validTill = `${fmtN(lastD)}.${fmtN(month)}.${year}`;

  await sendMsg(
    `✅ <b>SPO Uygulandı</b>\n\n` +
    `🏨 ${hotelName}\n📅 Geçerlilik: ${validFrom} – ${validTill}\n` +
    `📌 Peninsula: ${peninsulaEUR} EUR\n⚡ Rakip: ${rivalEUR} EUR\n` +
    `📉 İndirim: %${discountPct.toFixed(3)}\n🛏 PP/gece: ${ppResult.ppPerNight.toFixed(4)} EUR\n\n` +
    `⏳ 5 dakika sonra sonuç kontrol ediliyor...`
  );

  markPriced(hotelName, checkIn);
  await editMarkup(chatId, messageId, { inline_keyboard: [[{ text: '✅ Tamamlandı', callback_data: 'noop' }]] });

  const vr = await verifyScrape(hotelId, hotelName, checkIn);
  if (vr) {
    const { penPrice, rivalMin, rivalName } = vr;
    const ahead = !rivalMin || penPrice < rivalMin;
    let msg2 = `📊 <b>Sonuç</b>\n🏨 ${hotelName} | ${checkIn}\n`;
    if (ahead) {
      msg2 += `✅ Öne geçildi!\nPeninsula: ${penPrice} EUR`;
      if (rivalMin) msg2 += ` | ${rivalName}: ${rivalMin} EUR (Fark: ${Math.abs(penPrice - rivalMin)} EUR)`;
    } else if (penPrice === rivalMin) {
      msg2 += `🟡 Eşit: ${penPrice} EUR`;
    } else {
      msg2 += `⚠️ Hâlâ geride!\nPeninsula: ${penPrice} EUR | ${rivalName}: ${rivalMin} EUR (Fark: ${Math.abs(penPrice - rivalMin)} EUR)`;
    }
    await sendMsg(msg2);
  } else {
    await sendMsg(`⚠️ ${hotelName} ${checkIn} verify sonuç döndürmedi.`);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Pricer v4+debug başlıyor ===');
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN eksik');
  if (!PARTNER_USER || !PARTNER_PASS) throw new Error('PARTNER_USER veya PARTNER_PASS eksik');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  await doPass(browser);
  let partnerPage = await partnerLogin(browser);

  let eurRate = await fetchEurRate();
  console.log(`[Kur] EUR/RUB = ${eurRate}`);

  const queue    = [];
  let processing = false;

  async function processQueue() {
    if (processing || queue.length === 0) return;
    processing = true;
    const job = queue.shift();
    try {
      if (!partnerPage || partnerPage.isClosed()) partnerPage = await partnerLogin(browser);
      await processOne(job, browser, partnerPage, eurRate);
    } catch(err) {
      console.error('[Queue] Hata:', err.message);
      await sendMsg(`❌ <b>Hata</b>\n🏨 ${job.hotelName} | ${job.checkIn}\n${err.message}`);
      await editMarkup(job.chatId, job.messageId, {
        inline_keyboard: [[{ text: '❌ Hata — Tekrar Dene', callback_data: job.cbData }]],
      });
      unmarkClicked(job.cbData);
      try { if (partnerPage && !partnerPage.isClosed()) await partnerPage.close(); } catch {}
      partnerPage = null;
      try { partnerPage = await partnerLogin(browser); } catch {}
    }
    processing = false;
    processQueue();
  }

  setInterval(async () => {
    const r = await fetchEurRate();
    if (r) { eurRate = r; console.log(`[Kur] Güncellendi: ${eurRate}`); }
  }, 60 * 60 * 1000);

  let offset = 0;
  console.log('Telegram callback bekleniyor...');

  while (true) {
    try {
      const updates = await getUpdates(offset);
      if (!updates.ok || !updates.result) { await sleep(5000); continue; }

      for (const update of updates.result) {
        offset = update.update_id + 1;
        const cb = update.callback_query;
        if (!cb) continue;

        const chatId    = String(cb.message?.chat?.id);
        const messageId = cb.message?.message_id;
        const cbData    = cb.data || '';

        if (cbData === 'shutdown_pricer') {
          await answerCb(cb.id, '🛑 Kapatılıyor...');
          await sendMsg('🛑 <b>Pricer kapatıldı.</b>');
          try { if (partnerPage && !partnerPage.isClosed()) await partnerPage.close(); } catch {}
          await browser.close();
          process.exit(0);
        }

        if (cbData === 'noop')           { await answerCb(cb.id, ''); continue; }

        if (cbData.startsWith('skip__')) {
          await answerCb(cb.id, '⏭ Atlandı');
          await editMarkup(chatId, messageId, { inline_keyboard: [[{ text: '⏭ Atlandı', callback_data: 'noop' }]] });
          continue;
        }

        if (!cbData.startsWith('approve__')) continue;

        if (isClicked(cbData)) {
          await answerCb(cb.id, '⚠️ Bu işlem zaten yapıldı veya kuyruğa alındı.');
          continue;
        }

        const parts = cbData.split('__');
        if (parts.length < 6) { await answerCb(cb.id, '❌ Geçersiz'); continue; }
        const [, hotelId, hotelNameEnc, checkIn, penEurStr, rivalEurStr] = parts;
        const hotelName    = decodeURIComponent(hotelNameEnc);
        const peninsulaEUR = parseInt(penEurStr, 10);
        let   rivalEUR     = parseInt(rivalEurStr, 10);

        try {
          const fresh = await quickScrape(hotelId, checkIn);
          if (fresh && fresh.rivalMin) {
            rivalEUR = fresh.rivalMin;
            if (fresh.rivalMin >= fresh.penPrice) {
              await answerCb(cb.id, '✅ Artık önde değil, işlem gerekmiyor!');
              await editMarkup(chatId, messageId, { inline_keyboard: [[{ text: '✅ Artık önde değil', callback_data: 'noop' }]] });
              continue;
            }
          }
        } catch { /* scrape başarısız — orijinal değeri kullan */ }

        markClicked(cbData);
        await editMarkup(chatId, messageId, {
          inline_keyboard: [[{ text: `⏳ Kuyruğa alındı (${queue.length + (processing ? 1 : 0) + 1}. sıra)`, callback_data: 'noop' }]],
        });
        await answerCb(cb.id, '⏳ Kuyruğa alındı!');

        queue.push({ hotelId, hotelName, checkIn, peninsulaEUR, rivalEUR, chatId, messageId, cbData });
        processQueue();
      }
    } catch(err) {
      console.error('[Loop] Hata:', err.message);
      await sleep(10000);
    }
  }
}

main().catch(err => {
  console.error('Kritik:', err.message);
  process.exit(1);
});
