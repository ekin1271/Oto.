/**
 * pricer.js - GÜNCELLENMİŞ VERSİYON
 * * YAPILAN DEĞİŞİKLİKLER:
 * 1. fetchPpPrice: pBeg, pEnd doldurma ve bShow butonuna basma eklendi.
 * 2. applyDiscount: Fiyat çekmek için "Final price" satırındaki oda linkine tıklama eklendi.
 * 3. applyDiscount (Checkbox): Tüm oda/kişi tiplerini seçerken, Board kısmında SADECE Base Price'ı seçme eklendi.
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
const STATE_FILE         = 'pricer_state.json';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n)    { return String(n).padStart(2, '0'); }

let passCompleted = false;

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
  if (passCompleted) return;
  const page = await browser.newPage();
  await page.authenticate({ username: PARTNER_USER, password: PARTNER_PASS });
  try {
    await page.goto(PASS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(PASS_WAIT_MS);
    passCompleted = true;
  } catch (e) {
    console.warn('[Pass] Hata:', e.message);
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
    return rate;
  } finally {
    await page.close();
  }
}

async function partnerLogin(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 900 });
  await page.goto(`${PARTNER_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);
  const loginInput = await page.$('input[name="login"]');
  if (!loginInput) return page;
  await page.type('input[name="login"]', PARTNER_USER, { delay: 60 });
  await page.type('input[name="password"]', PARTNER_PASS, { delay: 60 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.click('input[type="submit"]'),
  ]);
  return page;
}

// ─── 1. Biblio'da Tarih Girme ve Fiyat Çekme (DÜZELTİLDİ) ───
async function fetchPpPrice(browser, hotelId, hotelName, checkIn, eurRate) {
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

    // Tarihleri gir ve Show butonuna bas
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

    await sleep(5000); // Tablonun yüklenmesi için bekle

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
  if (discountPct < 85) return null;
  return discountPct;
}

// ─── 2. Final Price'dan Girme ve Checkbox (DÜZELTİLDİ) ───
async function applyDiscount(partnerPage, hotelName, checkIn, discountPct) {
  const { from: validFrom, till: validTill } = getValidityRange(checkIn);
  
  const searchUrl = `${PARTNER_BASE}/accomodation?task=hotels&pCountryId=100411293179&prtn=${PARTNER_PRTN}`;
  await partnerPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  await partnerPage.waitForSelector('input[name="searchHotel"]');
  await partnerPage.type('input[name="searchHotel"]', hotelName);
  await partnerPage.click('input[name="bSearchHotel"]');
  await sleep(3000);

  // Otel linkine tıkla
  const hotelLink = await partnerPage.$('a[href*="task=hotels"][href*="hotelId"]');
  if (!hotelLink) throw new Error(`Otel bulunamadı`);
  await hotelLink.click();
  await sleep(3000);

  // KRİTİK: "Final price" satırındaki oda ismi linkini bul ve tıkla
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

  // SPO Tipi Seçimi
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
    if (fi && ti) {
      fi.value = from; ti.value = till;
    }
  }, validFrom, validTill);

  // KRİTİK: Checkbox Mantığı (Görseldeki mavi tikler gibi)
  await partnerPage.evaluate(() => {
    const cbs = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of cbs) {
      const container = cb.closest('td, tr');
      const txt = container ? container.textContent : '';

      // 1. ve 2. Sütunlar (Oda Tipleri ve Kişi Sayıları) -> HEPSİNİ SEÇ
      if (txt.includes('Cost price') || txt.includes('Base price') || txt.includes('Final price') || 
          txt.includes('DBL') || txt.includes('AD') || txt.includes('CHD') || txt.includes('INF')) {
        cb.checked = true;
      }

      // 3. Sütun (Board/Fiyat Kategorisi) -> SADECE Base Price'ı Seç, AI/HB/ULTRA'yı Boş Bırak
      const isBoardCol = /AI|HB|ULTRA|ALL/i.test(txt) || (txt.includes('Base price') && txt.length < 30); 
      if (isBoardCol) {
        if (txt.includes('Base price') && !/AI|HB|ULTRA|ALL/i.test(txt)) {
          cb.checked = true;
        } else {
          cb.checked = false;
        }
      }
    }
  });

  const saveBtn = await partnerPage.$('input[value="Save"]');
  if (saveBtn) await saveBtn.click();
  await partnerPage.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => sleep(5000));
}

// ─── Geri Kalan Akış (Değiştirilmedi) ───
async function processApproval(cbData, browser, partnerPage) {
  const parts = cbData.split('__');
  const [, hotelId, hotelName, checkIn, peninsulaEurStr, rivalEurStr] = parts;
  const peninsulaEur = parseInt(peninsulaEurStr, 10);
  const rivalEur     = parseInt(rivalEurStr, 10);

  const eurRate = await fetchEurRate(browser);
  const ppRub = await fetchPpPrice(browser, hotelId, hotelName, checkIn, eurRate);
  const discountPct = calcDiscount(ppRub, rivalEur, peninsulaEur, eurRate);
  
  await applyDiscount(partnerPage, hotelName, checkIn, discountPct);

  return { ok: true, hotelName, checkIn, peninsulaEur, rivalEur, discountPct: discountPct.toFixed(3), eurRate: eurRate.toFixed(2), ppRub: ppRub.toFixed(2) };
}

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  let partnerPage = null;
  let offset = 0;

  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates.result) {
        offset = update.update_id + 1;
        const cb = update.callback_query;
        if (!cb || !cb.data.startsWith('approve__')) continue;

        await answerCb(cb.id, '⏳ İşleniyor...');
        await sendMsg('⏳ Fiyat güncelleniyor...');

        if (!partnerPage || partnerPage.isClosed()) {
          await doPass(browser);
          partnerPage = await partnerLogin(browser);
        }

        const res = await processApproval(cb.data, browser, partnerPage);
        await sendMsg(`✅ <b>SPO Uygulandı</b>\n🏨 ${res.hotelName}\n📉 İndirim: %${res.discountPct}`);
      }
    } catch (err) {
      console.error(err);
      await sleep(5000);
    }
  }
}

main();
