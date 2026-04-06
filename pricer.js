/**
 * pricer.js
 * Telegram'dan "approve__..." callback gelince çalışır.
 * Partner sitesine girer, SPO ile % indirim uygular.
 *
 * ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PARTNER_USER, PARTNER_PASS
 * Kullanım: node pricer.js (sürekli açık long-polling bot)
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const https = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const PARTNER_USER       = process.env.PARTNER_USER;
const PARTNER_PASS       = process.env.PARTNER_PASS;
const PARTNER_BASE       = 'https://partner.bgoperator.ru';
const PARTNER_PRTN       = '115810428452';
const RULES_FILE         = 'price_rules.json';
const USAGE_FILE         = 'pricer_usage.json';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Tarih yardımcıları ───────────────────────────────────────────────────────
function fmt(n) { return String(n).padStart(2, '0'); }

// checkIn (DD.MM.YYYY) → { from: "01.MM.YYYY", till: "30/31.MM.YYYY" }
// Eğer ay içindeyse from = bugün
function getValidityRange(checkIn) {
  const [, m, y] = checkIn.split('.');
  const month = parseInt(m, 10);
  const year  = parseInt(y, 10);

  const today = new Date();
  const todayMonth = today.getMonth() + 1;
  const todayYear  = today.getFullYear();

  // Ayın son günü
  const lastDay = new Date(year, month, 0).getDate();

  let fromDay = 1;
  // Geçmiş tarih koruması: aynı ay ve yıl ise from = bugün
  if (year === todayYear && month === todayMonth) {
    fromDay = today.getDate();
  }

  const from = `${fmt(fromDay)}.${fmt(month)}.${year}`;
  const till = `${fmt(lastDay)}.${fmt(month)}.${year}`;
  return { from, till };
}

// ─── Günlük limit ─────────────────────────────────────────────────────────────
function loadUsage() {
  if (!fs.existsSync(USAGE_FILE)) return {};
  return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
}
function saveUsage(u) { fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2)); }
function todayKey() { return new Date().toISOString().slice(0, 10); }

function checkAndIncrement(hotelId, checkIn) {
  const rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  const rule  = rules[hotelId] || rules['_default'] || { maxDiff: 3, dailyLimit: 3 };
  const usage = loadUsage();
  const key   = `${todayKey()}__${hotelId}__${checkIn}`;
  const count = usage[key] || 0;
  if (count >= rule.dailyLimit) return { allowed: false, count, limit: rule.dailyLimit };
  usage[key] = count + 1;
  saveUsage(usage);
  return { allowed: true, count: count + 1, limit: rule.dailyLimit };
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { let s = ''; res.on('data', d => s += d); res.on('end', () => resolve(JSON.parse(s))); }
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

// ─── Partner login ─────────────────────────────────────────────────────────────
async function login(page) {
  await page.goto(`${PARTNER_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1000);
  const loginInput = await page.$('input[name="login"]');
  if (!loginInput) { console.log('Zaten giriş yapılmış'); return; }
  await page.type('input[name="login"]', PARTNER_USER, { delay: 50 });
  await page.type('input[name="password"]', PARTNER_PASS, { delay: 50 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.click('input[type="submit"]'),
  ]);
  await sleep(1000);
  console.log('Partner girişi tamam');
}

// ─── Otel ara ve tıkla ────────────────────────────────────────────────────────
async function findAndClickHotel(page, hotelName) {
  // Arama kutusuna otel adını yaz
  const searchUrl = `${PARTNER_BASE}/accomodation?task=hotels&pCountryId=100411293179&prtn=${PARTNER_PRTN}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  // input[name="searchHotel"] kutusuna yaz
  await page.waitForSelector('input[name="searchHotel"]', { timeout: 10000 });
  await page.click('input[name="searchHotel"]', { clickCount: 3 });
  await page.type('input[name="searchHotel"]', hotelName, { delay: 80 });
  await sleep(500);

  // Search butonuna bas
  await page.click('input[name="bSearchHotel"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(1500);

  // Sonuçlarda ilk otel linkine tıkla
  const hotelLink = await page.$('a[href*="task=hotels"][href*="hotelId"]');
  if (!hotelLink) throw new Error(`Otel bulunamadı: ${hotelName}`);
  await hotelLink.click();
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(1500);
  console.log(`Otel bulundu: ${hotelName}`);
}

// ─── Mass insert sayfasına git ────────────────────────────────────────────────
async function goToMassInsert(page) {
  const massLink = await page.$('a[href*="task=staypay"]');
  if (!massLink) throw new Error('Mass insert linki bulunamadı');
  await massLink.click();
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(1500);
  console.log('Mass insert sayfası açıldı');
}

// ─── SPO doldur ve kaydet ─────────────────────────────────────────────────────
async function fillAndSaveSpo(page, discountPct, validFrom, validTill) {
  // SPO type dropdown: "Early booking on period (on percentage basis)"
  await page.waitForSelector('select[name="pSpoType"], select', { timeout: 10000 });
  await page.evaluate(() => {
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
  await sleep(800);

  // % değerini gir — input name="pPercPrice"
  await page.waitForSelector('input[name="pPercPrice"]', { timeout: 10000 });
  await page.click('input[name="pPercPrice"]', { clickCount: 3 });
  await page.type('input[name="pPercPrice"]', discountPct.toFixed(3), { delay: 50 });
  await sleep(300);

  // Validity period from
  await page.evaluate((from, till) => {
    // frmIPBeg = from, frmIPEnd = till
    const fromInput = document.querySelector('input[name="frmIPBeg"], input[id*="frmIPBeg"]');
    const tillInput = document.querySelector('input[name="frmIPEnd"], input[id*="frmIPEnd"]');
    if (fromInput) { fromInput.value = from; fromInput.dispatchEvent(new Event('change', { bubbles: true })); }
    if (tillInput) { tillInput.value = till; tillInput.dispatchEvent(new Event('change', { bubbles: true })); }
  }, validFrom, validTill);
  await sleep(300);

  // "Disappearance date" — dokunma (current date and time tiki zaten var, bırak)

  // Her oda için: sol sütun tüm price type'ları seç (Select all),
  // sağ sütunda SADECE "Base price" tik olsun
  // Image'dan: sol "Select all" = cost+base+final hepsini seç
  //            sağ sütun: sadece "Base price" checkbox'ı işaretli olmalı
  await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      // Sol sütun: Select all linklerine tıkla (partner Peninsula price type)
      const selectAlls = table.querySelectorAll('a, input');
      for (const el of selectAlls) {
        const txt = (el.textContent || el.value || '').trim();
        if (txt === 'Select all') el.click();
      }
    }

    // Sağ sütun: tüm checkbox'lara bak
    // DBL, 1 AD (SGL), 3rd AD vb. = işaretli kalabilir
    // AI checkbox = işaretsiz olmalı
    // Base price = işaretli
    // Cost price checkbox'ları = işaretli (Select all zaten yapacak)
    // Ama AI checkbox varsa kaldır
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      const label = cb.closest('td, tr')?.textContent || '';
      if (label.includes('AI') && !label.includes('1 AD') && !label.includes('Base')) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });
  await sleep(500);

  // Save butonuna bas
  const saveBtn = await page.$('input[value="Save"]');
  if (!saveBtn) throw new Error('Save butonu bulunamadı');
  await saveBtn.click();

  // Sayfa yüklenene kadar bekle — sekme loading bitene kadar
  // waitForNavigation veya networkidle
  await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }).catch(async () => {
    // Fallback: 5 saniye bekle
    await sleep(5000);
  });
  await sleep(2000);
  console.log('SPO kaydedildi, sayfa yüklendi');
}

// ─── Ana işlem ────────────────────────────────────────────────────────────────
// callback_data: "approve__HOTELID__HOTELNAME__CHECKIN__PENINSULAEUR__RIVALEUR"
async function processApproval(data, browser) {
  const parts = data.split('__');
  // approve__hotelId__hotelName__checkIn__peninsulaEur__rivalEur
  if (parts.length < 6) throw new Error(`Geçersiz format: ${data}`);

  const [, hotelId, hotelName, checkIn, peninsulaEurStr, rivalEurStr] = parts;
  const peninsulaEur = parseInt(peninsulaEurStr, 10);
  const rivalEur     = parseInt(rivalEurStr, 10);

  // Limit kontrolü
  const limitCheck = checkAndIncrement(hotelId, checkIn);
  if (!limitCheck.allowed) {
    return { ok: false, reason: `Günlük limit doldu (${limitCheck.count - 1}/${limitCheck.limit})` };
  }

  // Hedef: rakip - 2 EUR
  const targetEur    = rivalEur - 2;
  const discountPct  = (targetEur / peninsulaEur) * 100;

  // Validity tarihleri
  const { from: validFrom, till: validTill } = getValidityRange(checkIn);

  console.log(`İşlem: ${hotelName} | ${checkIn} | Peninsula: ${peninsulaEur} EUR | Rakip: ${rivalEur} EUR | Hedef: ${targetEur} EUR | %${discountPct.toFixed(3)} | ${validFrom} - ${validTill}`);

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 900 });

  try {
    await login(page);
    await findAndClickHotel(page, hotelName);
    await goToMassInsert(page);
    await fillAndSaveSpo(page, discountPct, validFrom, validTill);

    return {
      ok: true,
      hotelName,
      checkIn,
      peninsulaEur,
      rivalEur,
      targetEur,
      discountPct: discountPct.toFixed(3),
      validFrom,
      validTill,
      usageCount: limitCheck.count,
      dailyLimit: limitCheck.limit,
    };
  } finally {
    await page.close();
  }
}

// ─── Telegram bot loop ────────────────────────────────────────────────────────
async function main() {
  console.log('Pricer bot başlıyor...');
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN eksik');
  if (!PARTNER_USER || !PARTNER_PASS) throw new Error('PARTNER_USER veya PARTNER_PASS eksik');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  let offset = 0;
  console.log('Telegram callback bekleniyor...');

  while (true) {
    try {
      const updates = await getUpdates(offset);
      if (!updates.ok) { await sleep(5000); continue; }

      for (const update of updates.result) {
        offset = update.update_id + 1;
        const cb = update.callback_query;
        if (!cb) continue;

        const chatId = String(cb.message?.chat?.id);
        if (chatId !== String(TELEGRAM_CHAT_ID)) {
          await answerCb(cb.id, 'Yetkisiz');
          continue;
        }

        const cbData = cb.data || '';

        if (cbData.startsWith('skip__')) {
          await answerCb(cb.id, 'Atlandı');
          continue;
        }

        if (!cbData.startsWith('approve__')) continue;

        await answerCb(cb.id, '⏳ İşleniyor...');
        await sendMsg('⏳ Fiyat güncelleniyor, lütfen bekleyin...');

        try {
          const result = await processApproval(cbData, browser);
          if (!result.ok) {
            await sendMsg(`❌ Güncelleme yapılamadı\n${result.reason}`);
          } else {
            await sendMsg(
              `✅ <b>Fiyat Güncellendi</b>\n\n` +
              `🏨 ${result.hotelName}\n` +
              `📅 Geçerlilik: ${result.validFrom} – ${result.validTill}\n` +
              `📌 Eski: ${result.peninsulaEur} EUR\n` +
              `⚡ Rakip: ${result.rivalEur} EUR\n` +
              `🎯 Yeni hedef: ${result.targetEur} EUR\n` +
              `📉 İndirim: %${result.discountPct}\n` +
              `🔁 Bugün: ${result.usageCount}/${result.dailyLimit}`
            );
          }
        } catch (err) {
          console.error('processApproval hata:', err.message);
          await sendMsg(`❌ Hata: ${err.message}`);
        }
      }
    } catch (err) {
      console.error('Loop hata:', err.message);
      await sleep(10000);
    }
  }
}

main().catch(err => {
  console.error('Kritik:', err.message);
  process.exit(1);
});
