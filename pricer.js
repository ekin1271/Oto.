/**
 * pricer.js
 * Telegram "approve__..." callback gelince çalışır.
 *
 * Akış:
 *   1. pass1.bibliki.ru → HTTP Basic Auth (sadece ilk kez veya IP değişince)
 *   2. 5 dk bekle
 *   3. partner.bgoperator.ru'ya login
 *   4. Oteli ara → otel sayfasına gir → "Mass insert" aç
 *   5. SPO type: "Early booking on period (on percentage basis)" seç
 *   6. Partner sitesindeki oda "Final price" fiyatlarından PP hesapla (dateshift ile)
 *   7. % indirim hesapla (100 RUB minimum kural gözetilerek)
 *   8. Tüm odalar seç, sütun 3: SADECE Base price
 *   9. % indirim + tarih gir → Save → yüklenmeyi bekle
 *  10. State'i güncelle (buton deaktif)
 *  11. 5 dk bekle → aynı oteli tekrar scrape → "ne kadar öne geçtik" bildirimi
 *  12. Group'a da gönder
 *  13. "Pricer'ı Kapat" butonu ile shutdown
 *
 * ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GROUP_CHAT_ID,
 *      PARTNER_USER, PARTNER_PASS
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const https     = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_GROUP_ID  = process.env.GROUP_CHAT_ID;
const PARTNER_USER       = process.env.PARTNER_USER;
const PARTNER_PASS       = process.env.PARTNER_PASS;

const PASS_URL       = 'https://pass1.bibliki.ru';
const BIBLIO_BASE    = 'https://www.bgoperator.ru';
const PARTNER_BASE   = 'https://partner.bgoperator.ru';
const PARTNER_PRTN   = '115810428452';
const PASS_WAIT_MS   = 5 * 60 * 1000;

const CLICKED_FILE = 'clicked_buttons.json'; // Basılmış butonlar
const AGENCY_RULES = [
  { pattern: '103810219', name: 'PENINSULA' },
  { pattern: '103816',    name: 'AKAY(FIT)' },
  { pattern: '103810175', name: 'SUMMER' },
  { pattern: '103810222', name: 'CARTHAGE' },
  { pattern: '103825',    name: 'KILIT GLOBAL' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n)    { return String(n).padStart(2, '0'); }

// ─── Clicked butonlar ─────────────────────────────────────────────────────────
function loadClicked() {
  if (fs.existsSync(CLICKED_FILE)) return JSON.parse(fs.readFileSync(CLICKED_FILE, 'utf8'));
  return {};
}
function saveClicked(data) {
  fs.writeFileSync(CLICKED_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function isClicked(cbData) {
  return !!loadClicked()[cbData];
}
function markClicked(cbData) {
  const data = loadClicked();
  data[cbData] = new Date().toISOString();
  saveClicked(data);
}

// ─── Tarih yardımcıları ───────────────────────────────────────────────────────
function getValidityRange(checkIn) {
  const [, m, y] = checkIn.split('.');
  const month    = parseInt(m, 10);
  const year     = parseInt(y, 10);
  const today    = new Date();
  const lastDay  = new Date(year, month, 0).getDate();
  let fromDay    = 1;
  if (year === today.getFullYear() && month === today.getMonth() + 1) {
    fromDay = today.getDate();
  }
  return {
    from: `${fmt(fromDay)}.${fmt(month)}.${year}`,
    till: `${fmt(lastDay)}.${fmt(month)}.${year}`,
  };
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function tgRequest(method, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req  = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => {
        let s = '';
        res.on('data', d => s += d);
        res.on('end', () => { try { resolve(JSON.parse(s)); } catch(e) { resolve({}); } });
      }
    );
    req.on('error', () => resolve({}));
    req.write(data);
    req.end();
  });
}

async function sendMsg(text, extra = {}) {
  // Bot'a gönder
  await tgRequest('sendMessage', {
    chat_id:    TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
  // Group'a da gönder (buton olmadan)
  if (TELEGRAM_GROUP_ID) {
    await tgRequest('sendMessage', {
      chat_id:    TELEGRAM_GROUP_ID,
      text,
      parse_mode: 'HTML',
    });
  }
}

async function answerCb(id, text) {
  return tgRequest('answerCallbackQuery', { callback_query_id: id, text });
}

async function editMsgReplyMarkup(chatId, messageId, replyMarkup) {
  return tgRequest('editMessageReplyMarkup', {
    chat_id:      chatId,
    message_id:   messageId,
    reply_markup: replyMarkup,
  });
}

async function getUpdates(offset) {
  return tgRequest('getUpdates', { offset, timeout: 30, allowed_updates: ['callback_query'] });
}

// ─── 1. Pass ─────────────────────────────────────────────────────────────────
let passCompleted = false;

async function doPass(browser) {
  if (passCompleted) {
    console.log('[Pass] Bu session için zaten tamamlandı.');
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
  } catch(e) {
    console.warn('[Pass] Hata (devam):', e.message);
  } finally {
    await page.close();
  }
}

// ─── 2. Partner login ─────────────────────────────────────────────────────────
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
  await page.type('input[name="login"]',    PARTNER_USER, { delay: 60 });
  await page.type('input[name="password"]', PARTNER_PASS, { delay: 60 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.click('input[type="submit"]'),
  ]);
  await sleep(1500);
  console.log('[Partner] Giriş tamam.');
  return page;
}

// ─── 3. Otel sayfasını aç + PP fiyatını çek ──────────────────────────────────
// Partner sitesinde otel sayfasına gidip "Viewing of the prices" → Final price çek
// dateShift: bugün ile kontrat başlangıcı arasındaki fark için +10 gün dene
async function fetchPpFromPartner(partnerPage, hotelName, checkIn) {
  console.log(`[PP] ${hotelName} - ${checkIn} için partner PP çekiliyor...`);

  const searchUrl = `${PARTNER_BASE}/accomodation?task=hotels&pCountryId=100411293179&prtn=${PARTNER_PRTN}`;
  await partnerPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Otel adının ilk iki kelimesini yaz (yeterli)
  const searchWords = hotelName.split(/\s+/).slice(0, 2).join(' ');
  console.log(`[PP] Arama: "${searchWords}"`);

  await partnerPage.waitForSelector('input[name="searchHotel"]', { timeout: 10000 });
  await partnerPage.click('input[name="searchHotel"]', { clickCount: 3 });
  await partnerPage.type('input[name="searchHotel"]', searchWords, { delay: 80 });
  await sleep(500);
  await partnerPage.click('input[name="bSearchHotel"]');
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(2000);

  // İlk otel linkine tıkla (task=hotels ve hotelId içeren)
  const hotelLink = await partnerPage.$('a[href*="task=hotels"][href*="hotelId="]');
  if (!hotelLink) {
    // Fallback: herhangi bir otel linki
    const anyLink = await partnerPage.$('a[href*="hotelId="]');
    if (!anyLink) throw new Error(`Otel bulunamadı: ${hotelName}`);
    await anyLink.click();
  } else {
    await hotelLink.click();
  }
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(2000);

  // Odaların listesinden ilk odayı aç (STANDARD ROOM veya benzeri)
  // Her oda için "Final price" linkine tıkla
  // İlk odanın Final price linkini bul
  const finalPriceLink = await partnerPage.$('a[href*="task=ns"]');
  if (!finalPriceLink) {
    console.warn('[PP] Final price linki bulunamadı, sayfada oda yok.');
    return null;
  }

  const finalPriceHref = await partnerPage.evaluate(el => el.href, finalPriceLink);
  await partnerPage.goto(finalPriceHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  // "Viewing of the prices" formunu doldur:
  // Validity period from: checkIn + 10 gün (dateshift)
  // till: checkIn + 24 gün
  // Show butonuna bas
  const [d, m, y] = checkIn.split('.').map(Number);
  const fromDate  = new Date(y, m - 1, d);
  fromDate.setDate(fromDate.getDate() + 10); // +10 gün dateshift
  const tillDate  = new Date(fromDate);
  tillDate.setDate(tillDate.getDate() + 14);

  const fromStr = `${fmt(fromDate.getDate())}.${fmt(fromDate.getMonth()+1)}.${fromDate.getFullYear()}`;
  const tillStr = `${fmt(tillDate.getDate())}.${fmt(tillDate.getMonth()+1)}.${tillDate.getFullYear()}`;

  console.log(`[PP] Validity: ${fromStr} - ${tillStr}`);

  // Tarihleri input'lara yaz
  await partnerPage.evaluate((from, till) => {
    const pBeg = document.querySelector('#pBeg') || document.querySelector('input[name="pBeg"]');
    const pEnd = document.querySelector('#pEnd') || document.querySelector('input[name="pEnd"]');
    if (pBeg) {
      pBeg.value = from;
      pBeg.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (pEnd) {
      pEnd.value = till;
      pEnd.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, fromStr, tillStr);
  await sleep(500);

  // Show butonuna bas
  const showBtn = await partnerPage.$('#bShow') ||
                  await partnerPage.$('input[name="bShow"]') ||
                  await partnerPage.$('input[value="Show"]');
  if (showBtn) {
    await showBtn.click();
    await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(2000);
  }

  // Final price'dan PP hesapla
  // font color="#339933" içinde "X.XX[12-99][12-99] EUR" formatı
  // Veya font color="#909090" içinde title="...dp: X, X, X..." formatı
  const ppResult = await partnerPage.evaluate(() => {
    // 1. Önce yeşil (Final price) fiyatı dene: font color="#339933"
    const greenFonts = document.querySelectorAll('font[color="#339933"]');
    for (const font of greenFonts) {
      const text  = font.textContent.trim();
      // "320.00[12-99][12-99] EUR" → 320.00 çek
      const match = text.match(/^(\d+(?:\.\d+)?)\[/);
      if (match) {
        const totalPrice = parseFloat(match[1]);
        // Bu "Price for 14 nights" DBL fiyatı
        // PP/gece = totalPrice / 2 / 7
        return { ppPerNight: totalPrice / 2 / 7, source: 'green', raw: text };
      }
    }

    // 2. Fallback: gri fiyat (font color="#909090") title içindeki dp değerleri
    const grayFonts = document.querySelectorAll('font[color="#909090"]');
    for (const font of grayFonts) {
      const title    = font.getAttribute('title') || '';
      const dpMatch  = title.match(/dp:\s*([\d.,\s]+)/);
      if (dpMatch) {
        const values = dpMatch[1]
          .split(',')
          .map(v => parseFloat(v.trim()))
          .filter(v => !isNaN(v) && v > 0)
          .slice(0, 7);
        if (values.length > 0) {
          const avgNightly = values.reduce((s, v) => s + v, 0) / values.length;
          return { ppPerNight: avgNightly / 2, source: 'gray', raw: title.slice(0, 80) };
        }
      }
    }

    return null;
  });

  if (ppResult) {
    console.log(`[PP] PP/gece: ${ppResult.ppPerNight.toFixed(4)} EUR (kaynak: ${ppResult.source})`);
  } else {
    console.warn('[PP] Fiyat çekilemedi — kontrat henüz açılmamış olabilir.');
  }

  return ppResult;
}

// ─── 4. % İndirim hesapla ────────────────────────────────────────────────────
// ppPerNightEur: partner sitesinden okunan per person per night EUR fiyatı
// peninsulaEUR: scraperın bulduğu paket EUR (bizim fiyatımız)
// rivalEUR: scraperın bulduğu rakip paket EUR
// Sistem 100 RUB minimum indirimi destekliyor.
// Yaklaşık EUR/RUB kuru scraper analizinde kullanılmıyor burada,
// PP fiyatı zaten EUR olarak geliyor partner sitesinden.
function calcDiscount(ppPerNightEur, peninsulaEUR, rivalEUR) {
  if (!ppPerNightEur || ppPerNightEur <= 0) return null;

  // 7 gecelik DBL toplam
  const ourTotal7Night   = ppPerNightEur * 2 * 7;
  // Rakip ile fark (paket bazında)
  const diffEur          = peninsulaEUR - rivalEUR;
  // PP/gece bazında fark
  const ppNightDiff      = diffEur / 7 / 2;
  // Hedef: rakibin 1 EUR/gece/PP altına geç
  const targetPpPerNight = ppPerNightEur - ppNightDiff - 1;

  if (targetPpPerNight <= 0) {
    console.warn('[Hesap] Hedef PP negatif — çok büyük fark.');
    return null;
  }

  // % discount (relative)
  const discountPct = (targetPpPerNight / ppPerNightEur) * 100;

  console.log(`[Hesap] PP/gece: ${ppPerNightEur.toFixed(4)} EUR | Fark: ${diffEur} EUR | Hedef: ${targetPpPerNight.toFixed(4)} EUR | İndirim: %${discountPct.toFixed(3)}`);

  // Güvenlik: %85'in altına düşme
  if (discountPct < 85) {
    console.warn(`[Hesap] İndirim çok yüksek (%${discountPct.toFixed(3)}) — iptal.`);
    return null;
  }
  // %100'ü geçemez
  if (discountPct >= 100) {
    console.warn('[Hesap] İndirim >= 100% — iptal.');
    return null;
  }

  return discountPct;
}

// ─── 5. Mass insert uygula ───────────────────────────────────────────────────
async function applyMassInsert(partnerPage, hotelName, checkIn, discountPct) {
  const { from: validFrom, till: validTill } = getValidityRange(checkIn);
  console.log(`[MassInsert] ${hotelName} | ${validFrom}→${validTill} | %${discountPct.toFixed(3)}`);

  const searchUrl = `${PARTNER_BASE}/accomodation?task=hotels&pCountryId=100411293179&prtn=${PARTNER_PRTN}`;
  await partnerPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  const searchWords = hotelName.split(/\s+/).slice(0, 2).join(' ');
  await partnerPage.waitForSelector('input[name="searchHotel"]', { timeout: 10000 });
  await partnerPage.click('input[name="searchHotel"]', { clickCount: 3 });
  await partnerPage.type('input[name="searchHotel"]', searchWords, { delay: 80 });
  await sleep(500);
  await partnerPage.click('input[name="bSearchHotel"]');
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(2000);

  const hotelLink = await partnerPage.$('a[href*="task=hotels"][href*="hotelId="]') ||
                    await partnerPage.$('a[href*="hotelId="]');
  if (!hotelLink) throw new Error(`Otel bulunamadı: ${hotelName}`);
  await hotelLink.click();
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(2000);

  // "Mass insert" linkine tıkla: href içinde "task=staypay" var
  const massLink = await partnerPage.$('a[href*="task=staypay"]');
  if (!massLink) throw new Error(`Mass insert linki bulunamadı: ${hotelName}`);
  await massLink.click();
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(2000);
  console.log('[MassInsert] Sayfa açıldı.');

  // SPO type seç: "Early booking on period (on percentage basis)"
  await partnerPage.waitForSelector('select[name="pIdSpec"]', { timeout: 15000 });
  const spoSelected = await partnerPage.evaluate(() => {
    const sel = document.querySelector('select[name="pIdSpec"]');
    if (!sel) return false;
    for (const opt of sel.options) {
      if (opt.text.includes('Early booking on period (on percentage basis)')) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        // form submit tetikle (onchange="javascript:submit()")
        if (sel.getAttribute('onchange') && sel.getAttribute('onchange').includes('submit')) {
          sel.form && sel.form.submit();
          return 'submit';
        }
        return true;
      }
    }
    return false;
  });

  if (spoSelected === 'submit') {
    await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(2000);
  } else {
    await sleep(1500);
  }
  console.log(`[MassInsert] SPO seçildi: ${spoSelected}`);

  // % indirim gir
  await partnerPage.waitForSelector('input[name="pPercPrice"]', { timeout: 15000 });
  await partnerPage.click('input[name="pPercPrice"]', { clickCount: 3 });
  await partnerPage.type('input[name="pPercPrice"]', discountPct.toFixed(3), { delay: 50 });
  await sleep(300);

  // Validity period: frmIPBeg / frmIPEnd
  await partnerPage.evaluate((from, till) => {
    const selectors = [
      ['#frmIPBeg', '#frmIPEnd'],
      ['input[name="frmIPBeg"]', 'input[name="frmIPEnd"]'],
      ['input[id*="IPBeg"]', 'input[id*="IPEnd"]'],
    ];
    for (const [fs, ts] of selectors) {
      const fi = document.querySelector(fs);
      const ti = document.querySelector(ts);
      if (fi && ti) {
        fi.value = from; fi.dispatchEvent(new Event('change', { bubbles: true }));
        ti.value = till; ti.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
  }, validFrom, validTill);
  await sleep(300);

  // Disappearance date: "current date and time" checkbox'ını KALDIR
  await partnerPage.evaluate(() => {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const rowText = (cb.closest('tr, td, div, label')?.textContent || '').toLowerCase();
      if ((rowText.includes('current date and time') || rowText.includes('disappearance')) && cb.checked) {
        cb.click();
      }
    }
  });
  await sleep(300);

  // Odaları seç:
  // Sütun 1 (oda tipi): tüm checkbox'lar → Select all
  // Sütun 2 (kişi tipi: DBL, SGL, 1AD, 2AD vs.): tüm checkbox'lar → Select all
  // Sütun 3 (board tipi: Base price, AI, vb.): SADECE Base price
  await partnerPage.evaluate(() => {
    // Her oda bloğu için 3 sütunlu yapı:
    // td.light[0] = oda listesi (STANDARD ROOM, Cost price, Base price, Final price)
    // td.light[1] = kişi tipleri (DBL, SGL, 1AD, 3AD vs.)
    // td.light[2] = board tipleri (Base price, AI)
    // (bazen 3 değil 2 td olabilir — ikinci yaklaşım)

    // Tüm "Select all" checkbox'larını bul
    const allCbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));

    // Her checkbox için: hangi sütunda olduğunu belirle
    for (const cb of allCbs) {
      // Üst td'yi bul
      const td = cb.closest('td');
      if (!td) continue;

      // td'nin sütun indeksini bul
      const row  = td.closest('tr');
      if (!row) continue;
      const cols = Array.from(row.querySelectorAll('td'));
      const idx  = cols.indexOf(td);

      // Sütun 0 ve 1: tüm checkbox → işaretle
      // Sütun 2 (board): sadece Base price
      const labelEl = cb.closest('label');
      const labelText = (labelEl ? labelEl.textContent : (cb.nextSibling?.textContent || '')).trim();

      // "Select all" ise
      if (labelText.toLowerCase().startsWith('select all')) {
        if (idx <= 1) {
          if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        // Sütun 2 Select all: DOKUNMA
        continue;
      }

      if (idx === 2 || td.getAttribute('valign') === 'top' && cols.length <= 3 && idx === cols.length - 1) {
        // Board sütunu — sadece Base price
        if (labelText.includes('Base price')) {
          if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        } else {
          if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        }
      } else if (idx === 0 || idx === 1) {
        // Oda ve kişi sütunları
        if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }
  });
  await sleep(500);

  // Alternatif/düzeltici: pNsId ile başlayan checkbox'ları işaretle (oda seçimi)
  // pProvider ile başlayanları işaretle (kişi seçimi)
  // selectAllNS*, selectAllConnectedRecs checkbox'larını işaretle
  await partnerPage.evaluate(() => {
    const allCbs = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of allCbs) {
      const name = cb.getAttribute('name') || '';
      const cls  = cb.getAttribute('class') || '';
      // Oda seçimi: pNsId ile başlar
      if (name.startsWith('pNsId') || cls.startsWith('selectAllNS')) {
        if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      // selectAllConnectedRecs: kişi tipleri
      if (name === 'selectAllConnectedRecs' || cls.includes('selectAllConnected')) {
        if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }

    // Sütun 3 (board): Board tiplerini yeniden kontrol et
    // "AI" checkbox'larını bul ve kaldır
    const allLabels = document.querySelectorAll('label, td');
    for (const el of allLabels) {
      const text = el.textContent.trim();
      const cb   = el.querySelector('input[type="checkbox"]') || (el.tagName === 'LABEL' ? el.control : null);
      if (!cb) continue;
      if (text === 'AI' || text === 'Final price' || text === 'Cost price') {
        if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      if (text === 'Base price') {
        if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }
  });
  await sleep(500);

  // Save butonuna bas
  const saveBtn = await partnerPage.$('input[value="Save"]') ||
                  await partnerPage.$('button[type="submit"]') ||
                  await partnerPage.$('input[type="submit"]');
  if (!saveBtn) throw new Error('Save butonu bulunamadı');

  console.log('[MassInsert] Save basılıyor...');
  await Promise.all([
    partnerPage.waitForNavigation({ waitUntil: 'networkidle0', timeout: 90000 }).catch(async () => {
      console.warn('[MassInsert] networkidle0 zaman aşımı, 8 sn bekleniyor...');
      await sleep(8000);
    }),
    saveBtn.click(),
  ]);
  await sleep(3000);
  console.log('[MassInsert] SPO kaydedildi.');
}

// ─── 6. Verify scrape: öne geçtik mi? ────────────────────────────────────────
async function verifyScrape(hotelId, hotelName, checkIn, rivalEUR) {
  console.log(`[Verify] ${hotelName} - ${checkIn} kontrol ediliyor...`);
  await sleep(5 * 60 * 1000); // 5 dk bekle

  const browser2 = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const [d, m, y] = checkIn.split('.').map(Number);
    const ci        = new Date(y, m - 1, d);
    const co        = new Date(ci);
    co.setDate(co.getDate() + 7);
    const fmtD = dt => `${fmt(dt.getDate())}.${fmt(dt.getMonth()+1)}.${dt.getFullYear()}`;

    const url = `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=121110211811&data=${fmtD(ci)}&d2=${fmtD(co)}&f7=7&f3=&f8=&ho=0&F4=${hotelId}&ins=0-40000-EUR&flt=100411293179&p=0100319900.0100319900`;

    const page = await browser2.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('div.b-pr', { timeout: 30000 }).catch(() => {});
    await sleep(2000);

    const agencyRulesStr = JSON.stringify(AGENCY_RULES);
    const result = await page.evaluate((agStr, targetDate) => {
      const rules = JSON.parse(agStr);
      function id(urr) {
        for (const r of rules) if (urr.includes(r.pattern)) return r.name;
        return null;
      }
      const blocks = document.querySelectorAll('div.b-pr');
      for (const block of blocks) {
        const rows = block.querySelectorAll('tr');
        let penPrice = null, rivalMin = null;
        for (const tr of rows) {
          const lis = tr.querySelectorAll('li.s8.i_t1');
          if (!lis.length) continue;
          let chosen = lis[0];
          for (const li of lis) { if ((li.getAttribute('urr') || '').includes(targetDate)) { chosen = li; break; } }
          const urr    = chosen.getAttribute('urr') || '';
          const agency = id(urr);
          if (!agency) continue;
          const priceLink = tr.querySelector('td.c_pe a[href]');
          if (!priceLink) continue;
          const m2 = (priceLink.getAttribute('href') || '').match(/[?&]x=(\d+)/);
          const p  = m2 ? parseInt(m2[1], 10) : null;
          if (!p) continue;
          if (agency === 'PENINSULA') { if (!penPrice || p < penPrice) penPrice = p; }
          else { if (!rivalMin || p < rivalMin) rivalMin = p; }
        }
        if (penPrice) return { penPrice, rivalMin };
      }
      return null;
    }, agencyRulesStr, checkIn);

    await page.close();
    return result;
  } finally {
    await browser2.close();
  }
}

// ─── Ana işlem ────────────────────────────────────────────────────────────────
async function processApproval(cbData, browser, partnerPage) {
  const parts = cbData.split('__');
  if (parts.length < 6) throw new Error(`Geçersiz format: ${cbData}`);

  const [, hotelId, hotelNameEnc, checkIn, peninsulaEurStr, rivalEurStr] = parts;
  const hotelName   = decodeURIComponent(hotelNameEnc);
  const peninsulaEUR = parseInt(peninsulaEurStr, 10);
  const rivalEUR     = parseInt(rivalEurStr, 10);

  console.log(`[Approval] ${hotelName} | ${checkIn} | Peninsula: ${peninsulaEUR} EUR | Rakip: ${rivalEUR} EUR`);

  // 1. PP fiyatını partner sitesinden çek
  const ppResult = await fetchPpFromPartner(partnerPage, hotelName, checkIn);
  if (!ppResult) throw new Error(`PP fiyatı bulunamadı: ${hotelName} (kontrat açılmamış olabilir)`);

  // 2. % indirim hesapla
  const discountPct = calcDiscount(ppResult.ppPerNight, peninsulaEUR, rivalEUR);
  if (!discountPct) throw new Error('İndirim hesaplanamadı (güvenlik sınırı veya negatif değer)');

  // 3. Mass insert uygula
  await applyMassInsert(partnerPage, hotelName, checkIn, discountPct);

  const { from: validFrom, till: validTill } = getValidityRange(checkIn);

  return {
    ok: true,
    hotelId,
    hotelName,
    checkIn,
    peninsulaEUR,
    rivalEUR,
    discountPct:   discountPct.toFixed(3),
    validFrom,
    validTill,
    ppPerNight:    ppResult.ppPerNight.toFixed(4),
    ppSource:      ppResult.source,
  };
}

// ─── Telegram bot loop ────────────────────────────────────────────────────────
async function main() {
  console.log('=== Pricer bot başlıyor ===');

  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN eksik');
  if (!PARTNER_USER || !PARTNER_PASS) throw new Error('PARTNER_USER veya PARTNER_PASS eksik');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  let partnerPage = null;

  // Pass + login başlangıçta yap
  await doPass(browser);
  partnerPage = await partnerLogin(browser);

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

        // Shutdown komutu
        if (cbData === 'shutdown_pricer') {
          await answerCb(cb.id, '🛑 Kapatılıyor...');
          await sendMsg('🛑 <b>Pricer kapatıldı.</b>');
          try { if (partnerPage && !partnerPage.isClosed()) await partnerPage.close(); } catch(e) {}
          await browser.close();
          process.exit(0);
        }

        // Yetki kontrolü
     //    if (chatId !== String(TELEGRAM_CHAT_ID)) {
     //      await answerCb(cb.id, '⛔ Yetkisiz');
     //      continue;
    //     }

        if (cbData.startsWith('skip__')) {
          await answerCb(cb.id, '⏭ Atlandı');
          // Butonu deaktif et
          await editMsgReplyMarkup(chatId, messageId, { inline_keyboard: [[{ text: '⏭ Atlandı', callback_data: 'noop' }]] });
          continue;
        }

        if (!cbData.startsWith('approve__')) continue;

        // Daha önce basıldı mı?
        if (isClicked(cbData)) {
          await answerCb(cb.id, '⚠️ Bu işlem zaten yapıldı.');
          continue;
        }

        // Butonu hemen deaktif et (tekrar basılmasın)
        markClicked(cbData);
        await editMsgReplyMarkup(chatId, messageId, {
          inline_keyboard: [[{ text: '⏳ İşleniyor...', callback_data: 'noop' }]],
        });
        await answerCb(cb.id, '⏳ İşleniyor...');
        await sendMsg('⏳ Fiyat güncelleniyor, lütfen bekleyin...');

        try {
          // Partner sayfası kapandıysa yeniden aç
          if (!partnerPage || partnerPage.isClosed()) {
            partnerPage = await partnerLogin(browser);
          }

          const result = await processApproval(cbData, browser, partnerPage);

          await sendMsg(
            `✅ <b>SPO Uygulandı</b>\n\n` +
            `🏨 ${result.hotelName}\n` +
            `📅 Geçerlilik: ${result.validFrom} – ${result.validTill}\n` +
            `📌 Peninsula: ${result.peninsulaEUR} EUR\n` +
            `⚡ Rakip: ${result.rivalEUR} EUR\n` +
            `📉 İndirim: %${result.discountPct}\n` +
            `🛏 PP/gece: ${result.ppPerNight} EUR (${result.ppSource})\n\n` +
            `⏳ 5 dakika sonra sonuç kontrol ediliyor...`
          );

          // Butonu "Tamamlandı" olarak güncelle
          await editMsgReplyMarkup(chatId, messageId, {
            inline_keyboard: [[{ text: '✅ Tamamlandı', callback_data: 'noop' }]],
          });

          // 5 dk bekle + verify scrape
          const verifyResult = await verifyScrape(
            result.hotelId,
            result.hotelName,
            result.checkIn,
            result.rivalEUR
          );

          if (verifyResult) {
            const { penPrice, rivalMin } = verifyResult;
            const ahead = rivalMin === null || penPrice < rivalMin;
            const equal = rivalMin !== null && penPrice === rivalMin;
            let verifyMsg = `📊 <b>Sonuç Kontrolü</b>\n🏨 ${result.hotelName}\n📅 ${result.checkIn}\n`;
            if (ahead) {
              verifyMsg += `✅ Öne geçildi!\n📌 Peninsula: ${penPrice} EUR`;
              if (rivalMin) verifyMsg += ` | Rakip: ${rivalMin} EUR`;
            } else if (equal) {
              verifyMsg += `🟡 Fiyatlar eşit: ${penPrice} EUR`;
            } else {
              verifyMsg += `⚠️ Hâlâ geride!\n📌 Peninsula: ${penPrice} EUR | Rakip: ${rivalMin} EUR`;
            }
            await sendMsg(verifyMsg);
          } else {
            await sendMsg(`⚠️ ${result.hotelName} - ${result.checkIn} için verify scrape sonuç döndürmedi.`);
          }

        } catch(err) {
          console.error('[processApproval] Hata:', err.message);
          await sendMsg(`❌ <b>Hata</b>\n\n${err.message}`);
          await editMsgReplyMarkup(chatId, messageId, {
            inline_keyboard: [[{ text: '❌ Hata — Tekrar Dene', callback_data: cbData }]],
          });
          // Clicked kaydını sil (tekrar denenebilsin)
          const clicked = loadClicked();
          delete clicked[cbData];
          saveClicked(clicked);

          try {
            if (partnerPage && !partnerPage.isClosed()) await partnerPage.close();
          } catch(e) {}
          partnerPage = null;
          try { partnerPage = await partnerLogin(browser); } catch(e2) {}
        }
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
