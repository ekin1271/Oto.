/**
 * pricer.js
 * Telegram "approve__..." callback gelince çalışır.
 * Akış:
 *   1. pass1.bibliki.ru → HTTP Basic Auth ile IP whitelist
 *   2. 5 dk bekle
 *   3. partner.bgoperator.ru'ya giriş
 *   4. Biblionun (bgoperator.ru) arama sayfasından EUR kurunu çek
 *   5. Oteli bul → en ucuz odayı aç → gri fiyattan PP hesapla
 *   6. Rakip EUR fiyatından hedef hesapla → % indirim bul
 *   7. Mass insert → SPO → kaydet → sayfa yenilenene kadar bekle
 *
 * ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PARTNER_USER, PARTNER_PASS
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

const PASS_WAIT_MS       = 5 * 60 * 1000; // 5 dakika IP whitelist için
const STATE_FILE         = 'pricer_state.json'; // pass yapıldı mı bu session'da

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n)    { return String(n).padStart(2, '0'); }

// ─── Session state: aynı process içinde bir kez pass yeterli ─────────────────
let passCompleted = false;

// ─── Tarih yardımcıları ───────────────────────────────────────────────────────
// checkIn (DD.MM.YYYY) → { from: "01.MM.YYYY", till: "30.MM.YYYY" }
// Aynı aydaysak from = bugün
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

// ─── Telegram ─────────────────────────────────────────────────────────────────
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

// ─── 1. Pass: IP whitelist ────────────────────────────────────────────────────
async function doPass(browser) {
  if (passCompleted) {
    console.log('[Pass] Bu session için zaten tamamlandı, atlanıyor.');
    return;
  }

  console.log('[Pass] pass1.bibliki.ru açılıyor...');
  const page = await browser.newPage();

  // HTTP Basic Auth → URL'e embed et
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

// ─── 2. EUR kuru: Biblionun ana sayfasından çek ───────────────────────────────
async function fetchEurRate(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto(`${BIBLIO_BASE}/price.shtml?action=price&tid=211`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    const rate = await page.evaluate(() => {
      // "EUR 88.64" gibi — b.c_l içinde ya da rates ul içinde
      // Önce ul.rates > li > b.c_l dene
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

      // Fallback: sayfada "EUR" yazan yerde yanındaki sayı
      const allText = document.body.innerText;
      const m       = allText.match(/EUR\s+(\d+[.,]\d+)/);
      if (m) return parseFloat(m[1].replace(',', '.'));

      return null;
    });

    console.log(`[Kur] EUR/RUB = ${rate}`);
    return rate;
  } finally {
    await page.close();
  }
}

// ─── 3. Partner login ─────────────────────────────────────────────────────────
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

// ─── 4. Biblionun sitesinde oteli bul ve PP fiyatını çek ─────────────────────
// checkIn: DD.MM.YYYY — o tarih etrafındaki 7 günlük tur fiyatına bakacağız
async function fetchPpPrice(browser, hotelId, hotelName, checkIn, eurRate) {
  console.log(`[PP] ${hotelName} - ${checkIn} için PP fiyatı çekiliyor...`);

  // Check-out = checkIn + 7
  const [d, m, y] = checkIn.split('.').map(Number);
  const checkInDate  = new Date(y, m - 1, d);
  const checkOutDate = new Date(checkInDate);
  checkOutDate.setDate(checkOutDate.getDate() + 7);
  const fmtDate = dt => `${fmt(dt.getDate())}.${fmt(dt.getMonth()+1)}.${dt.getFullYear()}`;

  // Biblionun tur arama URL'si — tek otel, 7 gece, 2 yetişkin, HB
  // id_price ve p parametreleri hotels.json'dan gelebilir ama varsayılan kullanıyoruz
  const searchUrl = `${BIBLIO_BASE}/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=121110211811&data=${fmtDate(checkInDate)}&d2=${fmtDate(checkOutDate)}&f7=7&f3=&f8=&ho=0&F4=${hotelId}&ins=0-40000-EUR&flt=100411293179&p=0100319900.0100319900`;

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try { await page.waitForSelector('div.b-pr', { timeout: 30000 }); } catch(e) {}
    await sleep(2000);

    // Gri fiyatı (font color="#909090") olan en ucuz odayı bul
    // title attribute'unda "dp: X, X, X..." formatında gecelik fiyatlar var
    const ppResult = await page.evaluate((targetHotelId) => {
      const blocks = document.querySelectorAll('div.b-pr');
      let bestPp   = null;

      for (const block of blocks) {
        // Bu blok doğru otel mi? hotelId ile eşleştir (link içinde F4= var)
        const links = block.querySelectorAll('a[href*="F4="]');
        let hotelMatch = false;
        for (const link of links) {
          if ((link.getAttribute('href') || '').includes(`F4=${targetHotelId}`)) {
            hotelMatch = true;
            break;
          }
        }
        // F4 bulunamazsa otel adı eşleşmesine güven (scraper zaten doğru oteli döndürdü)
        // Tüm blokları tarayacak olursak F4 olmayabilir — bu yüzden her bloğu dene

        // Gri fiyat: font color="#909090"
        const grayFonts = block.querySelectorAll('font[color="#909090"]');
        for (const font of grayFonts) {
          const title = font.getAttribute('title') || '';
          // "GRP:0 ... dp: 67.62, 67.62, 67.62, ..." formatı
          const dpMatch = title.match(/dp:\s*([\d., ]+)/);
          if (!dpMatch) continue;

          const values = dpMatch[1]
            .split(',')
            .map(v => parseFloat(v.trim()))
            .filter(v => !isNaN(v) && v > 0);

          if (values.length === 0) continue;

          // Ortalama gecelik DBL fiyatı (7 günlük senaryo — ilk 7 değer)
          const relevant = values.slice(0, 7);
          const avg      = relevant.reduce((s, v) => s + v, 0) / relevant.length;
          const pp       = avg / 2; // Per person

          if (bestPp === null || pp < bestPp) bestPp = pp;
        }
      }

      return bestPp;
    }, hotelId);

    console.log(`[PP] ${hotelName}: PP = ${ppResult ? ppResult.toFixed(2) : 'bulunamadı'} RUB`);
    return ppResult; // RUB cinsinden per person gecelik fiyat

  } finally {
    await page.close();
  }
}

// ─── 5. % İndirim hesapla ────────────────────────────────────────────────────
// peninsulaEUR: scraperın bulduğu paket EUR (uçak dahil) — sadece fark tespiti için
// ppRub: partner sitesinden okunan per person RUB fiyatı
// rivalEUR: scraperın bulduğu rakip paket EUR
// eurRate: güncel EUR/RUB kuru
// Hedef: rakibin önüne geçmek için gereken minimum % indirim
//
// Mantık:
//   Bizim PP (EUR) = ppRub / eurRate
//   Rakip paket EUR'dan PP tahmini: rivalEUR / peninsulaEUR oranıyla bizim PP'yi ölçek
//   Hedef PP = bizim PP - (peninsula PP - rival PP) - 1 EUR
//   discountPct = (hedefPP / bizimPP) * 100
//
// Daha sağlam yaklaşım — sadece RUB üzerinden:
//   Rakip EUR fark → RUB fark = diff_EUR * eurRate
//   100 RUB minimum ↓ — hesapla kaç % gerekiyor
//   Hedef RUB PP = bizim RUB PP - (diff_EUR * eurRate / 2) - 100
//   discountPct = (hedefRubPP * 2 * 7 / (bizimRubPP * 2 * 7)) * 100
function calcDiscount(ppRub, rivalEUR, peninsulaEUR, eurRate) {
  // Rakip bizden kaç EUR önde (paket bazında)
  const diffEur    = peninsulaEUR - rivalEUR; // negatif ise rakip önde
  // Paket farkını oda farkına yansıt: yaklaşık oran
  // PP RUB cinsinden rakip tahmini:
  const rivalPpRub = ppRub - (diffEur * eurRate) / 2; // 2 kişi, 7 gece dahil değil — per person per night fark

  // Hedef: rakibin 1 EUR PP/gece altına geç
  // 1 EUR = eurRate RUB
  // Ama minimum 100 RUB adım var — 1 EUR'dan büyük olduğundan genellikle sorun çıkmaz
  const targetPpRub = rivalPpRub - eurRate; // 1 EUR daha ucuz PP/gece

  if (targetPpRub <= 0) {
    console.warn('[Hesap] Hedef PP negatif — çok büyük fark, işlem yapılmıyor.');
    return null;
  }

  // 7 gecelik DBL indirim oranı
  // discountPct = (target / current) * 100
  const discountPct = (targetPpRub / ppRub) * 100;

  // Güvenlik sınırı: %85'in altına düşme
  if (discountPct < 85) {
    console.warn(`[Hesap] Hesaplanan indirim çok yüksek (%${discountPct.toFixed(3)}) — işlem yapılmıyor.`);
    return null;
  }

  return discountPct;
}

// ─── 6. Partner: otel bul ve mass insert yap ─────────────────────────────────
async function applyDiscount(partnerPage, hotelName, checkIn, discountPct) {
  const { from: validFrom, till: validTill } = getValidityRange(checkIn);
  console.log(`[Partner] ${hotelName} | ${validFrom}→${validTill} | %${discountPct.toFixed(3)}`);

  // Otel arama sayfasına git
  const searchUrl = `${PARTNER_BASE}/accomodation?task=hotels&pCountryId=100411293179&prtn=${PARTNER_PRTN}`;
  await partnerPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Otel adını yaz ve ara
  await partnerPage.waitForSelector('input[name="searchHotel"]', { timeout: 10000 });
  await partnerPage.click('input[name="searchHotel"]', { clickCount: 3 });
  await partnerPage.type('input[name="searchHotel"]', hotelName, { delay: 80 });
  await sleep(500);
  await partnerPage.click('input[name="bSearchHotel"]');
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(2000);

  // İlk otel linkine tıkla
  const hotelLink = await partnerPage.$('a[href*="task=hotels"][href*="hotelId"]');
  if (!hotelLink) throw new Error(`Otel bulunamadı: ${hotelName}`);
  await hotelLink.click();
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(2000);

  // "Mass insert" linkine tıkla — "staypay" içeren link
  const massLink = await partnerPage.$('a[href*="task=staypay"]');
  if (!massLink) throw new Error(`Mass insert linki bulunamadı: ${hotelName}`);
  await massLink.click();
  await partnerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(2000);
  console.log('[Partner] Mass insert sayfası açıldı.');

  // SPO type: "Early booking on period (on percentage basis)"
  await partnerPage.waitForSelector('select', { timeout: 10000 });
  await partnerPage.evaluate(() => {
    const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      for (const opt of sel.options) {
        if (opt.text.includes('Early booking on period (on percentage basis)')) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  });
  await sleep(1500); // Sayfa yeniden render bekle

  // pPercPrice inputunu doldur
  await partnerPage.waitForSelector('input[name="pPercPrice"]', { timeout: 15000 });
  await partnerPage.click('input[name="pPercPrice"]', { clickCount: 3 });
  await partnerPage.type('input[name="pPercPrice"]', discountPct.toFixed(3), { delay: 50 });
  await sleep(300);

  // Validity period from / till
  await partnerPage.evaluate((from, till) => {
    // Farklı input isimlerini dene
    const selectors = [
      ['input[name="frmIPBeg"]', 'input[name="frmIPEnd"]'],
      ['input[id*="frmIPBeg"]', 'input[id*="frmIPEnd"]'],
      ['input[id*="IPBeg"]',    'input[id*="IPEnd"]'],
    ];
    for (const [fromSel, tillSel] of selectors) {
      const fi = document.querySelector(fromSel);
      const ti = document.querySelector(tillSel);
      if (fi && ti) {
        fi.value = from; fi.dispatchEvent(new Event('change', { bubbles: true }));
        ti.value = till; ti.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
    // Fallback: tarih inputlarını sırayla bul
    const dateInputs = Array.from(document.querySelectorAll('input[type="text"]'))
      .filter(i => /\d{2}\.\d{2}\.\d{4}/.test(i.value) || i.name.toLowerCase().includes('date') || i.id.toLowerCase().includes('date'));
    if (dateInputs.length >= 2) {
      dateInputs[0].value = from; dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      dateInputs[1].value = till; dateInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, validFrom, validTill);
  await sleep(500);

  // Disappearance date: "current date and time" tikini KALDIR
  await partnerPage.evaluate(() => {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const label = (cb.closest('tr, td, div')?.textContent || '').toLowerCase();
      if (label.includes('current date and time') || label.includes('disappearance')) {
        if (cb.checked) {
          cb.click();
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
  });
  await sleep(300);

  // Tüm oda satırları için:
  // Sütun 1 (oda isimleri) → Select all
  // Sütun 2 (kişi sayısı / oda tipi) → Select all
  // Sütun 3 (fiyat tipi) → SADECE Base price
  await partnerPage.evaluate(() => {
    // Her oda bloğu için 3 sütunluk tablo var
    // Tüm "Select all" linklerini bul
    const selectAlls = document.querySelectorAll('input[type="checkbox"]');

    // Önce tüm sütun 1 ve 2'deki checkbox'ları işaretle
    // Mantık: Her tabloda 3 "Select all" var
    // 1. ve 2. → hepsini işaretle
    // 3. → sadece Base price

    // Her oda bloğu için (her tr.b-pr veya section)
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) continue;

        // Sütun 1: oda isimleri — Select all
        const cell1SelectAll = cells[0].querySelector('input[type="checkbox"]');
        if (cell1SelectAll && !cell1SelectAll.checked) {
          // "Select all" checkbox'ı mı kontrol et
          const cell1Text = cells[0].textContent.toLowerCase();
          if (cell1Text.includes('select all')) {
            cell1SelectAll.checked = true;
            cell1SelectAll.dispatchEvent(new Event('change', { bubbles: true }));
            cell1SelectAll.click();
          }
        }

        // Sütun 2: kişi tipleri — Select all
        const cell2Cbs = cells[1].querySelectorAll('input[type="checkbox"]');
        for (const cb of cell2Cbs) {
          if (!cb.checked) {
            cb.checked = true;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        // Sütun 3: fiyat tipleri — SADECE Base price
        const cell3Cbs = cells[2].querySelectorAll('input[type="checkbox"]');
        for (const cb of cell3Cbs) {
          const label = (cb.closest('label, td, tr')?.textContent || '').trim();
          if (label.includes('Base price')) {
            if (!cb.checked) {
              cb.checked = true;
              cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else {
            // Diğer tipler — işaretleme (AI, ULTRA ALL vb.)
            if (cb.checked) {
              cb.checked = false;
              cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        }
      }
    }

    // Alternatif: "Select all" linkleri varsa onları tıkla (ilk 2 sütun için)
    const allSelectAllLinks = Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .filter(cb => {
        const label = cb.parentElement?.textContent?.trim() || '';
        return label === 'Select all' || label.startsWith('Select all');
      });

    // Toplam "Select all" sayısı 3'ün katı olmalı (her oda için 3 tane)
    // 3'erli gruplar halinde: [col1, col2, col3, col1, col2, col3, ...]
    for (let i = 0; i < allSelectAllLinks.length; i++) {
      const isCol3 = (i % 3 === 2);
      if (!isCol3) {
        // Sütun 1 ve 2: tıkla
        if (!allSelectAllLinks[i].checked) {
          allSelectAllLinks[i].checked = true;
          allSelectAllLinks[i].dispatchEvent(new Event('change', { bubbles: true }));
          allSelectAllLinks[i].click();
        }
      }
      // Sütun 3: dokunma (sadece Base price manuel seçilecek)
    }
  });
  await sleep(500);

  // Sütun 3'te sadece Base price'ı seç — daha güvenilir yaklaşım
  await partnerPage.evaluate(() => {
    const allCbs = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of allCbs) {
      // Label text'ini bul
      let labelText = '';
      const label = cb.closest('label');
      if (label) {
        labelText = label.textContent.trim();
      } else {
        // Sonraki text node
        const next = cb.nextSibling;
        if (next && next.nodeType === 3) labelText = next.textContent.trim();
        // Ya da parent td'nin text'i
        const td = cb.closest('td');
        if (td) labelText = td.textContent.trim();
      }

      const isBasePrice = labelText.includes('Base price');
      const isSelectAll = labelText.startsWith('Select all');

      // Fiyat tipi sütunundaki (3. sütun) checkbox'lar
      // "Base price", "ULTRA ALL", "HB", "AI" vb. içeriyor
      const priceTypeKeywords = ['Base price', 'ULTRA ALL', 'HB', 'AI', 'Final price', 'Cost price'];
      const isPriceTypeCol = priceTypeKeywords.some(k => labelText.includes(k)) || isSelectAll;

      // Eğer bu bir fiyat tipi sütunundaysa
      if (isPriceTypeCol && !isSelectAll) {
        if (isBasePrice) {
          if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        } else {
          // ULTRA ALL, HB, AI vb. → işaretleme
          if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        }
      }
    }
  });
  await sleep(500);

  // Save butonuna bas
  const saveBtn = await partnerPage.$('input[value="Save"], button[type="submit"]');
  if (!saveBtn) throw new Error('Save butonu bulunamadı');
  await saveBtn.click();

  // Sayfa yenilenene kadar bekle — sekme loading bitmeli
  await partnerPage.waitForNavigation({ waitUntil: 'networkidle0', timeout: 90000 }).catch(async () => {
    console.warn('[Partner] networkidle0 zaman aşımı, 8 sn bekleniyor...');
    await sleep(8000);
  });
  await sleep(3000);
  console.log('[Partner] SPO kaydedildi.');
}

// ─── Ana işlem ────────────────────────────────────────────────────────────────
// callback_data: "approve__hotelId__hotelName__checkIn__peninsulaEUR__rivalEUR"
async function processApproval(cbData, browser, partnerPage) {
  const parts = cbData.split('__');
  if (parts.length < 6) throw new Error(`Geçersiz format: ${cbData}`);

  const [, hotelId, hotelName, checkIn, peninsulaEurStr, rivalEurStr] = parts;
  const peninsulaEur = parseInt(peninsulaEurStr, 10);
  const rivalEur     = parseInt(rivalEurStr, 10);

  console.log(`[Approval] ${hotelName} | ${checkIn} | Peninsula: ${peninsulaEur} EUR | Rakip: ${rivalEur} EUR`);

  // 1. EUR kurunu çek
  const eurRate = await fetchEurRate(browser);
  if (!eurRate) throw new Error('EUR kuru çekilemedi');

  // 2. PP fiyatını Biblionun sitesinden çek
  const ppRub = await fetchPpPrice(browser, hotelId, hotelName, checkIn, eurRate);
  if (!ppRub) throw new Error(`PP fiyatı bulunamadı: ${hotelName}`);

  // 3. % indirim hesapla
  const discountPct = calcDiscount(ppRub, rivalEur, peninsulaEur, eurRate);
  if (!discountPct) throw new Error('İndirim hesaplanamadı (güvenlik sınırı veya negatif değer)');

  // 4. Partner'da SPO uygula
  await applyDiscount(partnerPage, hotelName, checkIn, discountPct);

  const { from: validFrom, till: validTill } = getValidityRange(checkIn);
  const targetEur = rivalEur - 2; // Yaklaşık hedef EUR (bilgilendirme amaçlı)

  return {
    ok: true,
    hotelName,
    checkIn,
    peninsulaEur,
    rivalEur,
    targetEur,
    discountPct:   discountPct.toFixed(3),
    validFrom,
    validTill,
    ppRub:         ppRub.toFixed(2),
    eurRate:       eurRate.toFixed(2),
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

  // Partner sayfasını başlangıçta aç ve login yap
  // (aynı sayfa oturumu boyunca kullanılacak)
  let partnerPage = null;

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
          await answerCb(cb.id, '⛔ Yetkisiz');
          continue;
        }

        const cbData = cb.data || '';

        if (cbData.startsWith('skip__')) {
          await answerCb(cb.id, '⏭ Atlandı');
          continue;
        }

        if (!cbData.startsWith('approve__')) continue;

        await answerCb(cb.id, '⏳ İşleniyor...');
        await sendMsg('⏳ Fiyat güncelleniyor, lütfen bekleyin...');

        try {
          // İlk kez veya partner sayfası kapandıysa: pass + login
          if (!partnerPage || partnerPage.isClosed()) {
            // Pass: IP whitelist
            await doPass(browser);
            // Partner login
            partnerPage = await partnerLogin(browser);
          }

          const result = await processApproval(cbData, browser, partnerPage);

          await sendMsg(
            `✅ <b>SPO Uygulandı</b>\n\n` +
            `🏨 ${result.hotelName}\n` +
            `📅 Geçerlilik: ${result.validFrom} – ${result.validTill}\n` +
            `📌 Peninsula: ${result.peninsulaEur} EUR\n` +
            `⚡ Rakip: ${result.rivalEur} EUR\n` +
            `🎯 Hedef: ~${result.targetEur} EUR\n` +
            `📉 İndirim: %${result.discountPct}\n` +
            `💱 EUR/RUB: ${result.eurRate}\n` +
            `🛏 PP/gece: ${result.ppRub} RUB`
          );

        } catch (err) {
          console.error('[processApproval] Hata:', err.message);
          await sendMsg(`❌ <b>Hata</b>\n\n${err.message}`);
          // Hata durumunda partner sayfasını sıfırla
          try { if (partnerPage && !partnerPage.isClosed()) await partnerPage.close(); } catch(e) {}
          partnerPage = null;
        }
      }

    } catch (err) {
      console.error('[Loop] Hata:', err.message);
      await sleep(10000);
    }
  }
}

main().catch(err => {
  console.error('Kritik:', err.message);
  process.exit(1);
});
