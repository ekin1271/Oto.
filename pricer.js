/**
 * pricer.js - LOGLAR VE AKIŞ TAMAMEN GERİ GETİRİLDİ
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const https     = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const PARTNER_USER       = process.env.PARTNER_USER;
const PARTNER_PASS       = process.env.PARTNER_PASS;

const PASS_URL           = 'https://pass1.bibliki.ru';
const BIBLIO_BASE        = 'https://www.bgoperator.ru';
const PARTNER_BASE       = 'https://partner.bgoperator.ru';
const PARTNER_PRTN       = '115810428452';

const PASS_WAIT_MS       = 5 * 60 * 1000; 
let passCompleted = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n)    { return String(n).padStart(2, '0'); }

function getValidityRange(checkIn) {
  const [, m, y]   = checkIn.split('.');
  const month      = parseInt(m, 10);
  const year       = parseInt(y, 10);
  const today      = new Date();
  const todayMonth = today.getMonth() + 1;
  const todayYear  = today.getFullYear();
  const lastDay    = new Date(year, month, 0).getDate();
  let fromDay      = 1;
  if (year === todayYear && month === todayMonth) fromDay = today.getDate();
  return {
    from: `${fmt(fromDay)}.${fmt(month)}.${year}`,
    till: `${fmt(lastDay)}.${fmt(month)}.${year}`,
  };
}

async function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { let s = ''; res.on('data', d => s += d); res.on('end', () => { try { resolve(JSON.parse(s)); } catch(e) { resolve({}); } }); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendMsg(text) {
  return tgRequest('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
}

async function answerCb(id, text) {
  return tgRequest('answerCallbackQuery', { callback_query_id: id, text });
}

async function getUpdates(offset) {
  return tgRequest('getUpdates', { offset, timeout: 30, allowed_updates: ['callback_query'] });
}

async function doPass(browser) {
  if (passCompleted) {
    console.log('[Pass] Bu session için zaten tamamlandı, atlanıyor.');
    return;
  }
  console.log('[Pass] pass1.bibliki.ru açılıyor...');
  const page = await browser.newPage();
  await page.authenticate({ username: PARTNER_USER, password: PARTNER_PASS });
  try {
    await page.goto(PASS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[Pass] Açıldı. 5 dakika bekleniyor (IP whitelist)...');
    await sleep(PASS_WAIT_MS);
    console.log('[Pass] Bekleme tamamlandı.');
    passCompleted = true;
  } catch (e) {
    console.warn('[Pass] Hata (devam ediliyor):', e.message);
  } finally {
    await page.close();
  }
}

async function fetchEurRate(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto(`${BIBLIO_BASE}/price.shtml?action=price&tid=211`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    const rate = await page.evaluate(() => {
      const lis = document.querySelectorAll('ul.rates li');
      for (const li of lis) {
        const b = li.querySelector('b.c_l');
        if (b && b.textContent.trim() === 'EUR') {
          const i = li.querySelector('i');
          if (i) {
            const txt = i.textContent.trim().replace(',', '.');
            const n   = parseFloat(txt);
            if (!isNaN(n) && n > 10) return n;
          }
        }
      }
      return null;
    });
    console.log(`[Kur] EUR/RUB = ${rate}`);
    return rate;
  } finally {
    await page.close();
  }
}

async function partnerLogin(browser) {
  console.log('[Partner] Giriş yapılıyor...');
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 900 });
  await page.goto(`${PARTNER_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);
  const loginInput = await page.$('input[name="login"]');
  if (!loginInput) {
    console.log('[Partner] Zaten giriş yapılmış.');
    return page;
  }
  await page.type('input[name="login"]', PARTNER_USER, { delay: 60 });
  await page.type('input[name="password"]', PARTNER_PASS, { delay: 60 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.click('input[type="submit"]'),
  ]);
  console.log('[Partner] Giriş tamam.');
  return page;
}

async function fetchPpPrice(browser, hotelId, hotelName, checkIn, eurRate) {
  console.log(`[PP] ${hotelName} - ${checkIn} için PP fiyatı çekiliyor...`);
  const [d, m, y] = checkIn.split('.').map(Number);
  const checkInDate = new Date(y, m - 1, d);
  const checkOutDate = new Date(checkInDate);
  checkOutDate.setDate(checkOutDate.getDate() + 7);
  const fmtDate = dt => `${fmt(dt.getDate())}.${fmt(dt.getMonth() + 1)}.${dt.getFullYear()}`;

  const searchUrl = `${BIBLIO_BASE}/price.shtml?action=price&tid=211&id_price=121110211811&F4=${hotelId}&flt=100411293179`;

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);

    // Tarihleri gir ve Show butonuna tıkla (Senin istediğin kısım)
    await page.evaluate((s, e) => {
      const pBeg = document.getElementById('pBeg');
      const pEnd = document.getElementById('pEnd');
      const bShow = document.getElementById('bShow');
      if (pBeg && pEnd && bShow) {
        pBeg.value = s;
        pEnd.value = e;
        bShow.click();
      }
    }, fmtDate(checkInDate), fmtDate(checkOutDate));

    await sleep(5000);

    const ppResult = await page.evaluate(() => {
      const grayFonts = document.querySelectorAll('font[color="#909090"]');
      let bestPp = null;
      for (const font of grayFonts) {
        const title = font.getAttribute('title') || '';
        const dpMatch = title.match(/dp:\s*([\d., ]+)/);
        if (dpMatch) {
          const values = dpMatch[1].split(',').map(v => parseFloat(v.trim())).filter(v => v > 0);
          if (values.length > 0) {
            const avg = values.slice(0, 7).reduce((s, v) => s + v, 0) / values.length;
            const pp = avg / 2;
            if (bestPp === null || pp < bestPp) bestPp = pp;
          }
        }
      }
      return bestPp;
    });

    console.log(`[PP] ${hotelName}: PP = ${ppResult ? ppResult.toFixed(2) : 'bulunamadı'} RUB`);
    return ppResult;
  } finally {
    await page.close();
  }
}

function calcDiscount(ppRub, rivalEUR, peninsulaEUR, eurRate) {
  const diffEur = peninsulaEUR - rivalEUR;
  const rivalPpRub = ppRub - (diffEur * eurRate) / 2;
  const targetPpRub = rivalPpRub - eurRate;
  if (targetPpRub <= 0) return null;
  const discountPct = (targetPpRub / ppRub) * 100;
  if (discountPct < 85) {
    console.warn(`[Hesap] İndirim çok yüksek (%${discountPct.toFixed(3)}) - atlanıyor.`);
    return null;
  }
  return discountPct;
}

async function applyDiscount(partnerPage, hotelName, checkIn, discountPct) {
  const { from: validFrom, till: validTill } = getValidityRange(checkIn);
  console.log(`[Partner] ${hotelName} | %${discountPct.toFixed(3)} uygulanıyor...`);
  
  const searchUrl = `${PARTNER_BASE}/accomodation?task=hotels&pCountryId=100411293179&prtn=${PARTNER_PRTN}`;
  await partnerPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  await partnerPage.waitForSelector('input[name="searchHotel"]');
  await partnerPage.type('input[name="searchHotel"]', hotelName);
  await partnerPage.click('input[name="bSearchHotel"]');
  await sleep(3000);

  const hotelLink = await partnerPage.$('a[href*="task=hotels"][href*="hotelId"]');
  if (!hotelLink) throw new Error(`Otel bulunamadı`);
  await hotelLink.click();
  await sleep(3000);

  // Final Price satırındaki linke tıkla (Senin istediğin kısım)
  await partnerPage.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    for (const row of rows) {
      if (row.textContent.includes('Final price')) {
        const link = row.querySelector('a');
        if (link) { link.click(); return; }
      }
    }
  });
  await sleep(3000);

  const massLink = await partnerPage.waitForSelector('a[href*="task=staypay"]');
  await massLink.click();
  await sleep(3000);

  await partnerPage.evaluate(() => {
    const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      for (const opt of sel.options) {
        if (opt.text.includes('Early booking on period (on percentage basis)')) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }
  });
  await sleep(1500);

  await partnerPage.type('input[name="pPercPrice"]', discountPct.toFixed(3));
  
  await partnerPage.evaluate((from, till) => {
    const fi = document.querySelector('input[name="frmIPBeg"]') || document.querySelector('input[id*="Beg"]');
    const ti = document.querySelector('input[name="frmIPEnd"]') || document.querySelector('input[id*="End"]');
    if (fi && ti) { fi.value = from; ti.value = till; }
  }, validFrom, validTill);

  // Checkbox: Board'da SADECE Base Price (Senin istediğin kısım)
  await partnerPage.evaluate(() => {
    const cbs = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of cbs) {
      const container = cb.closest('td, tr');
      const txt = container ? container.textContent : '';
      if (txt.includes('Cost price') || txt.includes('Base price') || txt.includes('Final price') || 
          txt.includes('DBL') || txt.includes('AD') || txt.includes('CHD') || txt.includes('INF')) {
        cb.checked = true;
      }
      const isBoardCol = /AI|HB|ULTRA|ALL/i.test(txt) || (txt.includes('Base price') && txt.length < 30); 
      if (isBoardCol) {
        if (txt.includes('Base price') && !/AI|HB|ULTRA|ALL/i.test(txt)) cb.checked = true;
        else cb.checked = false;
      }
    }
  });

  const saveBtn = await partnerPage.$('input[value="Save"]');
  if (saveBtn) await saveBtn.click();
  await sleep(5000);
  console.log('[Partner] SPO kaydedildi.');
}

async function processApproval(cbData, browser, partnerPage) {
  const parts = cbData.split('__');
  const [, hotelId, hotelName, checkIn, peninsulaEurStr, rivalEurStr] = parts;
  const peninsulaEur = parseInt(peninsulaEurStr, 10);
  const rivalEur     = parseInt(rivalEurStr, 10);

  console.log(`[Approval] ${hotelName} | ${checkIn} | Peninsula: ${peninsulaEur} | Rakip: ${rivalEur}`);

  const eurRate = await fetchEurRate(browser);
  const ppRub = await fetchPpPrice(browser, hotelId, hotelName, checkIn, eurRate);
  if (!ppRub) throw new Error('PP fiyatı bulunamadı');

  const discountPct = calcDiscount(ppRub, rivalEur, peninsulaEur, eurRate);
  if (!discountPct) throw new Error('İndirim hesaplanamadı');
  
  await applyDiscount(partnerPage, hotelName, checkIn, discountPct);

  return { ok: true, hotelName, checkIn, peninsulaEur, rivalEur, discountPct: discountPct.toFixed(3), eurRate: eurRate.toFixed(2), ppRub: ppRub.toFixed(2) };
}

async function main() {
  console.log('=== Pricer bot başlıyor ===');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  let partnerPage = null;
  let offset = 0;
  console.log('Telegram callback bekleniyor...');

  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates.result) {
        offset = update.update_id + 1;
        const cb = update.callback_query;
        if (!cb || !cb.data.startsWith('approve__')) continue;

        const chatId = String(cb.message?.chat?.id);
        if (chatId !== String(TELEGRAM_CHAT_ID)) { await answerCb(cb.id, '⛔ Yetkisiz'); continue; }

        await answerCb(cb.id, '⏳ İşleniyor...');
        await sendMsg('⏳ Fiyat güncelleniyor, lütfen bekleyin...');

        if (!partnerPage || partnerPage.isClosed()) {
          await doPass(browser);
          partnerPage = await partnerLogin(browser);
        }

        const res = await processApproval(cb.data, browser, partnerPage);
        await sendMsg(`✅ <b>SPO Uygulandı</b>\n🏨 ${res.hotelName}\n📉 İndirim: %${res.discountPct}`);
      }
    } catch (err) {
      console.error('[Hata]:', err.message);
      await sendMsg(`❌ <b>Hata</b>\n\n${err.message}`);
      await sleep(5000);
    }
  }
}

main();
