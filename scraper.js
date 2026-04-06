const puppeteer = require('puppeteer');
const fs = require('fs');
const https = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_GROUP_ID  = process.env.GROUP_CHAT_ID;
const STATE_FILE         = 'price_state.json';
const HOTELS_FILE        = 'hotels.json';
const RULES_FILE         = 'price_rules.json';

const AGENCY_RULES = [
  { pattern: '103810219', name: 'PENINSULA' },
  { pattern: '103816',    name: 'AKAY(FIT)' },
  { pattern: '103810175', name: 'SUMMER' },
  { pattern: '103810222', name: 'CARTHAGE' },
  { pattern: '103825',    name: 'KILIT GLOBAL' },
];

function loadHotels() {
  if (fs.existsSync(HOTELS_FILE)) return JSON.parse(fs.readFileSync(HOTELS_FILE, 'utf8'));
  return [];
}

function loadRules() {
  if (fs.existsSync(RULES_FILE)) return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  return { _default: { maxDiff: 3, dailyLimit: 3 } };
}

function getRule(hotelId) {
  const rules = loadRules();
  return rules[hotelId] || rules['_default'] || { maxDiff: 3, dailyLimit: 3 };
}

function generateDates() {
  const dates = [];
  const now = new Date();
  const firstDate = new Date(now);
  firstDate.setDate(firstDate.getDate() + 5);
  if (firstDate.getMonth() === 2) { firstDate.setMonth(3); firstDate.setDate(15); }
  for (let m = 0; m < 4; m++) {
    const d = m === 0 ? new Date(firstDate) : new Date(firstDate.getFullYear(), firstDate.getMonth() + m, 15);
    const fmt = n => String(n).padStart(2, '0');
    const checkIn  = `${fmt(d.getDate())}.${fmt(d.getMonth()+1)}.${d.getFullYear()}`;
    const out = new Date(d); out.setDate(out.getDate() + 7);
    const checkOut = `${fmt(out.getDate())}.${fmt(out.getMonth()+1)}.${out.getFullYear()}`;
    dates.push({ checkIn, checkOut });
  }
  return dates;
}

function generateUrls(hotels) {
  const dates = generateDates();
  const urls = [];
  for (const { checkIn, checkOut } of dates) {
    for (const hotel of hotels) {
      const hotelId = typeof hotel === 'string' ? hotel : hotel.id;
      const p = typeof hotel === 'object' && hotel.p ? hotel.p : '0100319900.0100319900';
      const idPrice = typeof hotel === 'object' && hotel.id_price ? hotel.id_price : '121110211811';
      const url = `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=${idPrice}&data=${checkIn}&d2=${checkOut}&f7=7&f3=&f8=&ho=0&F4=${hotelId}&ins=0-40000-EUR&flt=100411293179&p=${p}`;
      urls.push({ url, checkIn, hotelId });
    }
  }
  return urls;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Telegram ────────────────────────────────────────────────────────────────
async function telegramPost(chatId, body) {
  const msgBody = JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true, ...body });
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msgBody) },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.write(msgBody);
    req.end();
  });
}

async function sendTelegramSplit(aheadAlerts, equalAlerts) {
  const allAlerts = [
    ...aheadAlerts.map(a => ({ ...a, type: 'ahead' })),
    ...equalAlerts.map(a => ({ ...a, type: 'equal' })),
  ];
  if (allAlerts.length === 0) return;

  const time = `\n🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;

  for (const a of allAlerts) {
    const rule = getRule(a.hotelId);
    const diff = a.rivalAhead ? (a.peninsulaPrice - a.cheapestPrice) : 0;
    const canAutoPrice = a.rivalAhead && diff <= rule.maxDiff && diff > 0;

    let text = `🏨 <b>${a.hotel}</b>\n🛏 ${a.room}\n📅 ${a.checkIn}\n`;

    if (a.type === 'equal') {
      text += `🟡 Fiyatlar eşit\n📌 Peninsula = ${a.cheapestAgency}: ${a.peninsulaPrice} EUR`;
    } else if (a.newRival && !a.rivalAhead) {
      text += `🆕 Rakip girdi (biz öndeyiz)\n📌 Peninsula: ${a.peninsulaPrice} EUR\n🏆 ${a.cheapestAgency}: ${a.cheapestPrice} EUR`;
    } else if (a.rivalAhead) {
      text += `🚨 Rakip öndeyiz\n📌 Peninsula: ${a.peninsulaPrice} EUR\n⚠️ ${a.cheapestAgency}: ${a.cheapestPrice} EUR (Fark: ${diff} EUR)`;
    } else {
      text += `🆕 Rakip girdi (biz öndeyiz)\n📌 Peninsula: ${a.peninsulaPrice} EUR\n🏆 ${a.cheapestAgency}: ${a.cheapestPrice} EUR`;
    }
    text += time;

    // Ana chat'e inline buton ile gönder
    const mainBody = { text };
    if (canAutoPrice) {
      mainBody.reply_markup = {
        inline_keyboard: [[
          {
            text: `✅ Fiyatı Güncelle (→ ${a.cheapestPrice - 2} EUR)`,
            callback_data: `approve__${a.hotelId}__${a.hotel}__${a.checkIn}__${a.peninsulaPrice}__${a.cheapestPrice}`,
          },
          { text: '❌ Geç', callback_data: `skip__${a.hotelId}__${a.checkIn}` }
        ]]
      };
    }

    await telegramPost(TELEGRAM_CHAT_ID, mainBody);

    // Group'a butonsuz gönder
    if (TELEGRAM_GROUP_ID) {
      await telegramPost(TELEGRAM_GROUP_ID, { text });
    }
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

        const urr = chosenLi.getAttribute('urr') || '';
        const agency = identifyAgency(urr);
        if (!agency) continue;

        let price = null;
        const priceLink = tr.querySelector('td.c_pe a[href]');
        if (priceLink) {
          const href = priceLink.getAttribute('href') || '';
          const m = href.match(/[?&]x=(\d+)/);
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

  const [d, m, y] = checkIn.split('.');
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + 5);
  const fmt = n => String(n).padStart(2, '0');
  const newCheckIn  = `${fmt(date.getDate())}.${fmt(date.getMonth()+1)}.${date.getFullYear()}`;
  const out = new Date(date); out.setDate(out.getDate() + 7);
  const newCheckOut = `${fmt(out.getDate())}.${fmt(out.getMonth()+1)}.${out.getFullYear()}`;
  const newUrl = targetUrl
    .replace(/data=\d{2}\.\d{2}\.\d{4}/, `data=${newCheckIn}`)
    .replace(/d2=\d{2}\.\d{2}\.\d{4}/,   `d2=${newCheckOut}`);

  results = await scrapePageOnce(browser, newUrl, newCheckIn, hotelId);
  return { results, usedCheckIn: newCheckIn };
}

// ─── Analiz ──────────────────────────────────────────────────────────────────
function analyzeOffers(checkIn, offers, prevState, newState) {
  const aheadAlerts = [], equalAlerts = [];

  for (const o of offers) {
    const key = `${checkIn}__${o.hotelName}__${o.roomType}`;
    const prevStatus = prevState[key];

    if (o.rivals.length === 0) { newState[key] = 'alone'; continue; }

    const cheapest = o.rivals.reduce((a, b) => a.price < b.price ? a : b);
    const rivalAhead = cheapest.price < o.peninsulaPrice;
    const isEqual    = cheapest.price === o.peninsulaPrice;
    const isNew      = prevStatus === 'alone' || prevStatus === undefined;

    newState[key] = rivalAhead ? 'ahead' : isEqual ? 'equal' : 'behind';

    const alertBase = {
      checkIn,
      hotel: o.hotelName,
      hotelId: o.hotelId,
      room: o.roomType,
      peninsulaPrice: o.peninsulaPrice,
      cheapestAgency: cheapest.agency,
      cheapestPrice: cheapest.price,
      rivalAhead,
    };

    if (isNew && rivalAhead) {
      aheadAlerts.push({ ...alertBase, diff: o.peninsulaPrice - cheapest.price, newRival: true });
    } else if (isNew && isEqual) {
      equalAlerts.push({ ...alertBase });
    } else if (isNew && !rivalAhead && !isEqual) {
      aheadAlerts.push({ ...alertBase, diff: 0, newRival: true });
    } else if (!isNew && rivalAhead && prevStatus !== 'ahead') {
      aheadAlerts.push({ ...alertBase, diff: o.peninsulaPrice - cheapest.price, newRival: false });
    } else if (!isNew && isEqual && prevStatus !== 'equal') {
      equalAlerts.push({ ...alertBase });
    }
  }

  return { aheadAlerts, equalAlerts };
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
  console.log('Tarama basliyor...');
  const hotels = loadHotels();
  const dates = generateDates();
  console.log(`Otel: ${hotels.length} | Tarihler: ${dates.map(d => d.checkIn).join(', ')}`);

  const prevState = loadState();
  const newState  = { ...prevState };
  const allAheadAlerts = [], allEqualAlerts = [];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const urls = generateUrls(hotels);
    console.log(`Toplam URL: ${urls.length}`);

    const CONCURRENCY = 10;
    const offersByDate = {};
    let completed = 0;

    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY);
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
        console.log(`  ${completed}/${urls.length} tamamlandi`);
      }
    }

    for (const [checkIn, offers] of Object.entries(offersByDate)) {
      console.log(`  [${checkIn}] ${offers.length} otel bloğu`);
      const { aheadAlerts, equalAlerts } = analyzeOffers(checkIn, offers, prevState, newState);
      allAheadAlerts.push(...aheadAlerts);
      allEqualAlerts.push(...equalAlerts);
    }

  } finally {
    await browser.close();
  }

  saveState(newState);
  console.log('State kaydedildi.');

  if (allAheadAlerts.length > 0 || allEqualAlerts.length > 0) {
    console.log(`${allAheadAlerts.length} uyari, ${allEqualAlerts.length} esitlik. Gonderiliyor...`);
    await sendTelegramSplit(allAheadAlerts, allEqualAlerts);
  } else {
    console.log('Degisiklik yok.');
  }
}

main().catch(async err => {
  console.error('Kritik hata:', err.message);
  process.exit(1);
});
