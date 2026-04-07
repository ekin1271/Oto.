/**
 * monitor.js  v3
 * BGOperator fiyat tarama + rakip karşılaştırma + Telegram bildirimi
 *
 * DEĞİŞİKLİKLER:
 * - Her otel × her tarih için ayrı mesaj + ayrı "Öne Geç" butonu
 * - State: ahead/behind/priced sürekli güncellenir
 * - 'priced' (biz öne geçirdik) sonrası rakip tekrar önüne geçerse bildirim gelir
 * - Halihazırda 'ahead' olan için tekrar bildirim yok
 * - En sonda özet mesaj + "Pricer'ı Kapat" butonu
 * - Pricer otomatik spawn edilir
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const https     = require('https');
const { spawn } = require('child_process');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_GROUP_ID  = process.env.GROUP_CHAT_ID;
const STATE_FILE         = 'price_state.json';
const HOTELS_FILE        = 'hotels.json';

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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtN(n)  { return String(n).padStart(2, '0'); }

function generateDates() {
  const dates = [];
  const now   = new Date();
  const first = new Date(now);
  first.setDate(first.getDate() + 5);
  if (first.getMonth() === 2) { first.setMonth(3); first.setDate(15); }
  for (let m = 0; m < 4; m++) {
    const d = m === 0 ? new Date(first)
      : new Date(first.getFullYear(), first.getMonth() + m, 15);
    const ci = `${fmtN(d.getDate())}.${fmtN(d.getMonth()+1)}.${d.getFullYear()}`;
    const out = new Date(d); out.setDate(out.getDate() + 7);
    const co = `${fmtN(out.getDate())}.${fmtN(out.getMonth()+1)}.${out.getFullYear()}`;
    dates.push({ checkIn: ci, checkOut: co });
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
  return new Promise(resolve => {
    const data = JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true, ...body });
    const req  = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', () => resolve());
    req.write(data); req.end();
  });
}

// ─── Scrape ──────────────────────────────────────────────────────────────────
async function scrapePageOnce(browser, targetUrl, checkIn, hotelId) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });
  try { await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch(e) {}
  try { await page.waitForSelector('div.b-pr', { timeout: 30000 }); } catch(e) {}
  await sleep(2000);

  const rulesStr = JSON.stringify(AGENCY_RULES);
  const results  = await page.evaluate((rulesStr, targetDate, hotelId) => {
    const rules = JSON.parse(rulesStr);
    function idAgency(urr) {
      for (const r of rules) if (urr.includes(r.pattern)) return r.name;
      return null;
    }
    const offers = [];
    for (const block of document.querySelectorAll('div.b-pr')) {
      let hotelName = '';
      const hl = block.querySelector('a[href*="code="]');
      if (hl) hotelName = hl.textContent.trim();
      else { const nd = block.querySelector('div.name a'); if (nd) hotelName = nd.textContent.trim(); }

      let penPrice = null, penRoom = '';
      const rivals = [];

      // display:none dahil tüm tr'ler
      for (const tr of block.querySelectorAll('tr')) {
        const lis = tr.querySelectorAll('li.s8.i_t1');
        if (!lis.length) continue;
        let chosen = lis[0];
        if (targetDate) for (const li of lis) if ((li.getAttribute('urr')||'').includes(targetDate)) { chosen = li; break; }
        const urr    = chosen.getAttribute('urr') || '';
        const agency = idAgency(urr);
        if (!agency) continue;
        const pl = tr.querySelector('td.c_pe a[href]');
        if (!pl) continue;
        const m = (pl.getAttribute('href')||'').match(/[?&]x=(\d+)/);
        const price = m ? parseInt(m[1], 10) : null;
        if (!price) continue;
        if (agency === 'PENINSULA') {
          const rt = tr.querySelector('td.c_ns');
          if (rt && !penRoom) penRoom = rt.textContent.trim().split('\n')[0].trim();
          if (!penPrice || price < penPrice) penPrice = price;
        } else {
          rivals.push({ agency, price });
        }
      }
      if (!penPrice || !penRoom) continue;
      offers.push({ hotelName, hotelId, roomType: penRoom, peninsulaPrice: penPrice, rivals });
    }
    return offers;
  }, rulesStr, checkIn, hotelId);

  await page.close();
  return results;
}

async function scrapeWithShift(browser, url, checkIn, hotelId) {
  let r = await scrapePageOnce(browser, url, checkIn, hotelId);
  if (r.length) return { results: r, usedCheckIn: checkIn };
  const [d, m, y] = checkIn.split('.');
  const dt = new Date(y, m-1, d); dt.setDate(dt.getDate() + 5);
  const nc = `${fmtN(dt.getDate())}.${fmtN(dt.getMonth()+1)}.${dt.getFullYear()}`;
  const ot = new Date(dt); ot.setDate(ot.getDate() + 7);
  const no = `${fmtN(ot.getDate())}.${fmtN(ot.getMonth()+1)}.${ot.getFullYear()}`;
  const nu = url.replace(/data=\d{2}\.\d{2}\.\d{4}/, `data=${nc}`).replace(/d2=\d{2}\.\d{2}\.\d{4}/, `d2=${no}`);
  r = await scrapePageOnce(browser, nu, nc, hotelId);
  return { results: r, usedCheckIn: nc };
}

// ─── Analiz ──────────────────────────────────────────────────────────────────
function analyzeOffers(checkIn, offers, prevState, newState) {
  const alerts = [];
  for (const o of offers) {
    const key    = `${checkIn}__${o.hotelName}__${o.roomType}`;
    const prevSt = prevState[key];
    if (!o.rivals.length) { newState[key] = 'alone'; continue; }

    const cheapest  = o.rivals.reduce((a, b) => a.price < b.price ? a : b);
    const rivalAhead = cheapest.price < o.peninsulaPrice;
    const isEqual    = cheapest.price === o.peninsulaPrice;
    const isNew      = prevSt === undefined || prevSt === 'alone';

    // Yeni state — 'priced' ise koruyoruz; rakip tekrar önüne geçtiyse 'ahead'a dön
    if (rivalAhead) {
      newState[key] = 'ahead';
    } else if (isEqual) {
      newState[key] = 'equal';
    } else {
      // Biz öndeyiz — eğer daha önce 'priced' yapıldıysa onu koru
      newState[key] = prevSt === 'priced' ? 'priced' : 'behind';
    }

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

    // Bildirim kuralları:
    // 1. Yeni rakip girdi (isNew) → her durumda bildir
    // 2. Daha önce behind/equal/alone/priced idiyse ve şimdi ahead → bildir
    //    (prevSt === 'ahead' ise tekrar BILDIRIM YOK)
    // 3. Daha önce ahead/behind idiyse ve eşit olduysa bildir
    if (isNew) {
      if (rivalAhead) alerts.push({ ...base, type: 'ahead', diff: o.peninsulaPrice - cheapest.price, newRival: true });
      else if (isEqual) alerts.push({ ...base, type: 'equal', diff: 0, newRival: true });
      else alerts.push({ ...base, type: 'we_lead', diff: 0, newRival: true });
    } else if (rivalAhead && prevSt !== 'ahead') {
      // Durum değişti: behind/equal/priced → ahead
      alerts.push({ ...base, type: 'ahead', diff: o.peninsulaPrice - cheapest.price, newRival: false });
    } else if (isEqual && prevSt !== 'equal') {
      alerts.push({ ...base, type: 'equal', diff: 0, newRival: false });
    }
    // Eğer hâlâ ahead ve prevSt === 'ahead' → bildirim yok
  }
  return alerts;
}

// ─── State ───────────────────────────────────────────────────────────────────
function loadState()   { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {}; }
function saveState(st) { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8'); }

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Monitor v3 başlıyor ===');
  const hotels = loadHotels();
  const dates  = generateDates();
  console.log(`Otel: ${hotels.length} | Tarihler: ${dates.map(d => d.checkIn).join(', ')}`);

  const prevState = loadState();
  const newState  = { ...prevState };
  const allAlerts = [];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const urls = generateUrls(hotels);
    console.log(`Toplam URL: ${urls.length}`);
    const CONCURRENCY = 10;
    const byDate      = {};
    let done          = 0;

    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY);
      const res   = await Promise.all(batch.map(({ url, checkIn, hotelId }) =>
        scrapeWithShift(browser, url, checkIn, hotelId)));
      for (const { results, usedCheckIn } of res) {
        if (results.length) {
          if (!byDate[usedCheckIn]) byDate[usedCheckIn] = [];
          byDate[usedCheckIn].push(...results);
        }
      }
      done += batch.length;
      if (done % 50 === 0 || done === urls.length) console.log(`  ${done}/${urls.length}`);
    }

    for (const [ci, offers] of Object.entries(byDate)) {
      console.log(`  [${ci}] ${offers.length} blok`);
      allAlerts.push(...analyzeOffers(ci, offers, prevState, newState));
    }
  } finally {
    await browser.close();
  }

  saveState(newState);
  console.log(`State kaydedildi. ${allAlerts.length} uyarı.`);

  // ─── Her uyarı → ayrı mesaj + ayrı buton ─────────────────────────────────
  for (const alert of allAlerts) {
    const diff = alert.rivalAhead ? (alert.peninsulaPrice - alert.cheapestPrice) : 0;
    let text   = `🏨 <b>${alert.hotel}</b>\n🛏 ${alert.room}\n📅 ${alert.checkIn}\n`;

    if (alert.type === 'equal') {
      text += `🟡 Fiyatlar eşit\n📌 Peninsula = ${alert.cheapestAgency}: ${alert.peninsulaPrice} EUR`;
    } else if (alert.type === 'we_lead') {
      text += `🆕 Rakip girdi — biz öndeyiz\n📌 Peninsula: ${alert.peninsulaPrice} EUR\n🏆 ${alert.cheapestAgency}: ${alert.cheapestPrice} EUR`;
    } else {
      // ahead
      const emoji = alert.newRival ? '🆕 Rakip girdi (gerideyiz)' : '🚨 Rakip öne geçti';
      text += `${emoji}\n📌 Peninsula: ${alert.peninsulaPrice} EUR\n⚠️ ${alert.cheapestAgency}: ${alert.cheapestPrice} EUR (Fark: ${diff} EUR)`;
    }
    text += `\n🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;

    const body = { text };
    if (alert.rivalAhead && diff > 0) {
      const cbKey = `approve__${alert.hotelId}__${encodeURIComponent(alert.hotel)}__${alert.checkIn}__${alert.peninsulaPrice}__${alert.cheapestPrice}`;
      body.reply_markup = {
        inline_keyboard: [[
          { text: `✅ Öne Geç (Fark: ${diff} EUR)`, callback_data: cbKey },
          { text: '❌ Geç', callback_data: `skip__${alert.hotelId}__${alert.checkIn}` },
        ]],
      };
    }

    if (TELEGRAM_CHAT_ID) await telegramPost(TELEGRAM_CHAT_ID, body);
    if (TELEGRAM_GROUP_ID) await telegramPost(TELEGRAM_GROUP_ID, { text });
    await sleep(400);
  }

  // ─── Özet + Pricer'ı Kapat ────────────────────────────────────────────────
  const ts = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  if (allAlerts.length === 0) {
    if (TELEGRAM_CHAT_ID) await telegramPost(TELEGRAM_CHAT_ID, {
      text: `✅ <b>Monitor tamamlandı</b>\nDeğişiklik yok.\n🕐 ${ts}`,
    });
    console.log('Değişiklik yok.');
  } else {
    if (TELEGRAM_CHAT_ID) await telegramPost(TELEGRAM_CHAT_ID, {
      text: `📊 <b>Monitor tamamlandı</b>\n${allAlerts.length} uyarı gönderildi.\nPricer başlatıldı.\n🕐 ${ts}`,
      reply_markup: {
        inline_keyboard: [[{ text: '🛑 Pricer\'ı Kapat', callback_data: 'shutdown_pricer' }]],
      },
    });
  }

  // ─── Pricer spawn ─────────────────────────────────────────────────────────
  console.log('=== Pricer başlatılıyor ===');
  const pricer = spawn('node', ['pricer.js'], { stdio: 'inherit', env: process.env, detached: false });
  pricer.on('error', err => console.error('Pricer spawn hatası:', err.message));
  pricer.on('exit',  code => console.log(`Pricer çıktı: ${code}`));
}

main().catch(async err => {
  console.error('Kritik hata:', err.message);
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
    await telegramPost(TELEGRAM_CHAT_ID, { text: `❌ <b>Monitor Hatası</b>\n\n${err.message}` }).catch(() => {});
  process.exit(1);
});
