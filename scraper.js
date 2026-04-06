/**
 * scraper.js
 * BGOperator fiyat tarama + rakip karşılaştırma + Telegram bildirimi
 * Bildirimde "Öne Geç" butonu → pricer.js handle eder
 *
 * ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GROUP_CHAT_ID (opsiyonel)
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const https = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_GROUP_ID  = process.env.GROUP_CHAT_ID;
const STATE_FILE         = 'price_state.json';
const HOTELS_FILE        = 'hotels.json';
const RULES_FILE         = 'price_rules.json';

// Ajans pattern → isim eşleştirmesi
const AGENCY_RULES = [
  { pattern: '103810219', name: 'PENINSULA' },
  { pattern: '103816',    name: 'AKAY(FIT)' },
  { pattern: '103810175', name: 'SUMMER' },
  { pattern: '103810222', name: 'CARTHAGE' },
  { pattern: '103825',    name: 'KILIT GLOBAL' },
];

// ─── Yardımcılar ─────────────────────────────────────────────────────────────
function loadHotels() {
  if (fs.existsSync(HOTELS_FILE)) return JSON.parse(fs.readFileSync(HOTELS_FILE, 'utf8'));
  return [];
}

function loadRules() {
  if (fs.existsSync(RULES_FILE)) return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  return { _default: { maxDiff: 5 } };
}

function getRule(hotelId) {
  const rules = loadRules();
  return rules[String(hotelId)] || rules['_default'] || { maxDiff: 5 };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Önümüzdeki 4 ay için check-in tarihleri üret
function generateDates() {
  const dates = [];
  const now = new Date();
  const firstDate = new Date(now);
  firstDate.setDate(firstDate.getDate() + 5);

  // Mart sonu → Nisan 15'e atla
  if (firstDate.getMonth() === 2) {
    firstDate.setMonth(3);
    firstDate.setDate(15);
  }

  for (let m = 0; m < 4; m++) {
    const d = m === 0
      ? new Date(firstDate)
      : new Date(firstDate.getFullYear(), firstDate.getMonth() + m, 15);

    const fmt = n => String(n).padStart(2, '0');
    const checkIn  = `${fmt(d.getDate())}.${fmt(d.getMonth()+1)}.${d.getFullYear()}`;
    const out = new Date(d);
    out.setDate(out.getDate() + 7);
    const checkOut = `${fmt(out.getDate())}.${fmt(out.getMonth()+1)}.${out.getFullYear()}`;
    dates.push({ checkIn, checkOut });
  }
  return dates;
}

function generateUrls(hotels) {
  const dates = generateDates();
  const urls  = [];
  for (const { checkIn, checkOut } of dates) {
    for (const hotel of hotels) {
      const hotelId = typeof hotel === 'string' ? hotel : hotel.id;
      const p       = (typeof hotel === 'object' && hotel.p)        ? hotel.p        : '0100319900.0100319900';
      const idPrice = (typeof hotel === 'object' && hotel.id_price) ? hotel.id_price : '121110211811';
      const url = `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=${idPrice}&data=${checkIn}&d2=${checkOut}&f7=7&f3=&f8=&ho=0&F4=${hotelId}&ins=0-40000-EUR&flt=100411293179&p=${p}`;
      urls.push({ url, checkIn, hotelId });
    }
  }
  return urls;
}

// ─── Telegram ────────────────────────────────────────────────────────────────
function telegramPost(chatId, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true, ...body });
    const req  = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendAlert(alert) {
  const rule = getRule(alert.hotelId);
  const diff = alert.rivalAhead ? (alert.peninsulaPrice - alert.cheapestPrice) : 0;
  // Butonu her zaman göster — limit/sınır yok, kullanıcı karar verir
  const canAutoPrice = alert.rivalAhead && diff > 0 && diff <= rule.maxDiff;

  let text = `🏨 <b>${alert.hotel}</b>\n🛏 ${alert.room}\n📅 ${alert.checkIn}\n`;

  if (alert.type === 'equal') {
    text += `🟡 Fiyatlar eşit\n📌 Peninsula = ${alert.cheapestAgency}: ${alert.peninsulaPrice} EUR`;
  } else if (alert.newRival && !alert.rivalAhead) {
    text += `🆕 Rakip girdi — biz öndeyiz\n📌 Peninsula: ${alert.peninsulaPrice} EUR\n🏆 ${alert.cheapestAgency}: ${alert.cheapestPrice} EUR`;
  } else if (alert.rivalAhead) {
    text += `🚨 Rakip öne geçti\n📌 Peninsula: ${alert.peninsulaPrice} EUR\n⚠️ ${alert.cheapestAgency}: ${alert.cheapestPrice} EUR (Fark: ${diff} EUR)`;
  } else {
    text += `🆕 Rakip girdi — biz öndeyiz\n📌 Peninsula: ${alert.peninsulaPrice} EUR\n🏆 ${alert.cheapestAgency}: ${alert.cheapestPrice} EUR`;
  }

  text += `\n🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;

  const mainBody = { text };

  // Öne geç butonu — sadece rakip önde ve fark kural içindeyse
  if (canAutoPrice) {
    // callback_data: approve__hotelId__hotelName__checkIn__peninsulaEUR__rivalEUR
    mainBody.reply_markup = {
      inline_keyboard: [[
        {
          text: `✅ Öne Geç (→ ${alert.cheapestPrice - 2} EUR)`,
          callback_data: `approve__${alert.hotelId}__${alert.hotel}__${alert.checkIn}__${alert.peninsulaPrice}__${alert.cheapestPrice}`,
        },
        { text: '❌ Geç', callback_data: `skip__${alert.hotelId}__${alert.checkIn}` },
      ]],
    };
  }

  await telegramPost(TELEGRAM_CHAT_ID, mainBody);

  // Group'a butonsuz gönder
  if (TELEGRAM_GROUP_ID) {
    await telegramPost(TELEGRAM_GROUP_ID, { text });
  }
}

// ─── Scrape ──────────────────────────────────────────────────────────────────
async function scrapePageOnce(browser, targetUrl, checkIn, hotelId) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  try { await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch(e) {}
  try { await page.waitForSelector('div.b-pr', { timeout: 30000 }); } catch(e) {}
  await sleep(2000);

  const agencyRulesStr = JSON.stringify(AGENCY_RULES);

  const results = await page.evaluate((agencyRulesStr, targetDate, hotelId) => {
    const agencyRules = JSON.parse(agencyRulesStr);

    function identifyAgency(urr) {
      for (const rule of agencyRules) {
        if (urr.includes(rule.pattern)) return rule.name;
      }
      return null;
    }

    const offers = [];
    const blocks = document.querySelectorAll('div.b-pr');

    for (const block of blocks) {
      let hotelName = '';
      const hotelLink = block.querySelector('a[href*="code="]');
      if (hotelLink) hotelName = hotelLink.textContent.trim();
      if (!hotelName) {
        const nameDiv = block.querySelector('div.name a');
        if (nameDiv) hotelName = nameDiv.textContent.trim();
      }

      const allRows = block.querySelectorAll('tr');
      let peninsulaPrice = null;
      let peninsulaRoomName = '';
      const rivals = [];

      for (const tr of allRows) {
        const allLis = tr.querySelectorAll('li.s8.i_t1');
        if (allLis.length === 0) continue;

        let chosenLi = allLis[0];
        if (targetDate) {
          for (const li of allLis) {
            if ((li.getAttribute('urr') || '').includes(targetDate)) { chosenLi = li; break; }
          }
        }

        const urr    = chosenLi.getAttribute('urr') || '';
        const agency = identifyAgency(urr);
        if (!agency) continue;

        let price = null;
        const priceLink = tr.querySelector('td.c_pe a[href]');
        if (priceLink) {
          const href = priceLink.getAttribute('href') || '';
          const m    = href.match(/[?&]x=(\d+)/);
          if (m) price = parseInt(m[1], 10) || null;
        }
        if (!price) continue;

        if (agency === 'PENINSULA') {
          const roomTd = tr.querySelector('td.c_ns');
          if (roomTd && !peninsulaRoomName) {
            peninsulaRoomName = roomTd.textContent.trim().split('\n')[0].trim();
          }
          if (!peninsulaPrice || price < peninsulaPrice) peninsulaPrice = price;
        } else {
          rivals.push({ agency, price });
        }
      }

      if (!peninsulaPrice || !peninsulaRoomName) continue;
      offers.push({ hotelName, hotelId, roomType: peninsulaRoomName, peninsulaPrice, rivals });
    }

    return offers;
  }, agencyRulesStr, checkIn, hotelId);

  await page.close();
  return results;
}

async function scrapePageWithDateShift(browser, targetUrl, checkIn, hotelId) {
  let results = await scrapePageOnce(browser, targetUrl, checkIn, hotelId);
  if (results.length > 0) return { results, usedCheckIn: checkIn };

  // Sonuç yoksa 5 gün ileri kaydır
  const [d, m, y] = checkIn.split('.');
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + 5);
  const fmt         = n => String(n).padStart(2, '0');
  const newCheckIn  = `${fmt(date.getDate())}.${fmt(date.getMonth()+1)}.${date.getFullYear()}`;
  const out         = new Date(date);
  out.setDate(out.getDate() + 7);
  const newCheckOut = `${fmt(out.getDate())}.${fmt(out.getMonth()+1)}.${out.getFullYear()}`;
  const newUrl = targetUrl
    .replace(/data=\d{2}\.\d{2}\.\d{4}/, `data=${newCheckIn}`)
    .replace(/d2=\d{2}\.\d{2}\.\d{4}/,   `d2=${newCheckOut}`);

  results = await scrapePageOnce(browser, newUrl, newCheckIn, hotelId);
  return { results, usedCheckIn: newCheckIn };
}

// ─── Analiz ──────────────────────────────────────────────────────────────────
function analyzeOffers(checkIn, offers, prevState, newState) {
  const alerts = [];

  for (const o of offers) {
    const key        = `${checkIn}__${o.hotelName}__${o.roomType}`;
    const prevStatus = prevState[key];

    if (o.rivals.length === 0) { newState[key] = 'alone'; continue; }

    const cheapest   = o.rivals.reduce((a, b) => a.price < b.price ? a : b);
    const rivalAhead = cheapest.price < o.peninsulaPrice;
    const isEqual    = cheapest.price === o.peninsulaPrice;
    const isNew      = prevStatus === 'alone' || prevStatus === undefined;

    newState[key] = rivalAhead ? 'ahead' : isEqual ? 'equal' : 'behind';

    const base = {
      checkIn,
      hotel:          o.hotelName,
      hotelId:        o.hotelId,
      room:           o.roomType,
      peninsulaPrice: o.peninsulaPrice,
      cheapestAgency: cheapest.agency,
      cheapestPrice:  cheapest.price,
      rivalAhead,
    };

    // Sadece durum değiştiğinde veya yeni bir rakip girdiğinde bildir
    if (isNew && rivalAhead) {
      alerts.push({ ...base, type: 'ahead', diff: o.peninsulaPrice - cheapest.price, newRival: true });
    } else if (isNew && isEqual) {
      alerts.push({ ...base, type: 'equal', diff: 0, newRival: true });
    } else if (isNew && !rivalAhead && !isEqual) {
      alerts.push({ ...base, type: 'ahead', diff: 0, newRival: true });
    } else if (!isNew && rivalAhead && prevStatus !== 'ahead') {
      alerts.push({ ...base, type: 'ahead', diff: o.peninsulaPrice - cheapest.price, newRival: false });
    } else if (!isNew && isEqual && prevStatus !== 'equal') {
      alerts.push({ ...base, type: 'equal', diff: 0, newRival: false });
    }
  }

  return alerts;
}

// ─── State ───────────────────────────────────────────────────────────────────
function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return {};
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Tarama başlıyor ===');
  const hotels = loadHotels();
  const dates  = generateDates();
  console.log(`Otel: ${hotels.length} | Tarihler: ${dates.map(d => d.checkIn).join(', ')}`);

  const prevState  = loadState();
  const newState   = { ...prevState };
  const allAlerts  = [];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const urls = generateUrls(hotels);
    console.log(`Toplam URL: ${urls.length}`);

    const CONCURRENCY  = 10;
    const offersByDate = {};
    let completed      = 0;

    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch        = urls.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(({ url, checkIn, hotelId }) => scrapePageWithDateShift(browser, url, checkIn, hotelId))
      );

      for (const { results, usedCheckIn } of batchResults) {
        if (results.length > 0) {
          if (!offersByDate[usedCheckIn]) offersByDate[usedCheckIn] = [];
          offersByDate[usedCheckIn].push(...results);
        }
      }

      completed += batch.length;
      if (completed % 50 === 0 || completed === urls.length) {
        console.log(`  ${completed}/${urls.length} tamamlandı`);
      }
    }

    for (const [checkIn, offers] of Object.entries(offersByDate)) {
      console.log(`  [${checkIn}] ${offers.length} otel bloğu`);
      const alerts = analyzeOffers(checkIn, offers, prevState, newState);
      allAlerts.push(...alerts);
    }

  } finally {
    await browser.close();
  }

  saveState(newState);
  console.log(`State kaydedildi. ${allAlerts.length} uyarı.`);

  for (const alert of allAlerts) {
    await sendAlert(alert);
    await sleep(300); // Telegram rate limit
  }

  if (allAlerts.length === 0) {
    console.log('Değişiklik yok.');
  }
}

main().catch(async err => {
  console.error('Kritik hata:', err.message);
  // Telegram'a hata bildirimi gönder
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    const data = JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text:       `❌ <b>Scraper Hatası</b>\n\n${err.message}`,
      parse_mode: 'HTML',
    });
    const req = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => res.resume()
    );
    req.write(data);
    req.end();
  }
  process.exit(1);
});
