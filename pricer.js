const puppeteer = require('puppeteer');
const https     = require('https');

// --- Değişkenler ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const PARTNER_USER       = process.env.PARTNER_USER;
const PARTNER_PASS       = process.env.PARTNER_PASS;

const BIBLIO_BASE        = 'https://www.bgoperator.ru';
const PARTNER_BASE       = 'https://partner.bgoperator.ru';
const PARTNER_PRTN       = '115810428452';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n)    { return String(n).padStart(2, '0'); }

function getValidityRange(checkIn) {
  const [d, m, y] = checkIn.split('.');
  const month = parseInt(m, 10);
  const year = parseInt(y, 10);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    from: `${fmt(parseInt(d,10))}.${fmt(month)}.${year}`,
    till: `${fmt(lastDay)}.${fmt(month)}.${year}`,
  };
}

// --- Telegram Yardımı ---
async function tgRequest(method, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, 
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { let s = ''; res.on('data', d => s += d); res.on('end', () => { try { resolve(JSON.parse(s)); } catch(e) { resolve({}); } }); }
    );
    req.write(data); req.end();
  });
}
async function sendMsg(text) { return tgRequest('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }); }

// --- 1. Biblio Fiyat Çekme (pBeg, pEnd, bShow ve 10 Gün Ekleme) ---
async function fetchPpPrice(browser, hotelId, checkIn) {
    const [d, m, y] = checkIn.split('.').map(Number);
    const fmtDate = dt => `${fmt(dt.getDate())}.${fmt(dt.getMonth() + 1)}.${dt.getFullYear()}`;
    let targetCheckIn = new Date(y, m - 1, d);
    let ppResult = null;
    let attempts = 0;

    const page = await browser.newPage();
    try {
        while (ppResult === null && attempts < 2) {
            const sDate = fmtDate(targetCheckIn);
            const eDate = fmtDate(new Date(targetCheckIn.getTime() + 7 * 24 * 60 * 60 * 1000));
            const url = `${BIBLIO_BASE}/price.shtml?action=price&tid=211&flt2=100510000863&id_price=121110211811&data=${sDate}&d2=${eDate}&F4=${hotelId}&flt=100411293179`;
            
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await sleep(2000);

            // Kutuları doldur ve Show'a bas
            await page.evaluate((s, e) => {
                const b = document.getElementById('pBeg');
                const n = document.getElementById('pEnd');
                const sBtn = document.getElementById('bShow');
                if (b && n && sBtn) { b.value = s; n.value = e; sBtn.click(); }
            }, sDate, eDate);
            await sleep(4000);

            // title içinden Per Person çek
            ppResult = await page.evaluate(() => {
                const fonts = document.querySelectorAll('font[color="#909090"]');
                for (const f of fonts) {
                    const title = f.getAttribute('title') || '';
                    const m = title.match(/dp:\s*([\d., ]+)/);
                    if (m) {
                        const vals = m[1].split(',').map(v => parseFloat(v.replace(/[^0-9.]/g, ''))).filter(v => v > 0);
                        if (vals.length > 0) return (vals.slice(0, 7).reduce((a, b) => a + b, 0) / vals.length) / 2;
                    }
                }
                return null;
            });

            if (ppResult === null) {
                targetCheckIn.setDate(targetCheckIn.getDate() + 10);
                attempts++;
            }
        }
        return ppResult;
    } finally { await page.close(); }
}

// --- 2. Partner SPO Uygulama (Tam Görsel Uyumluluğu) ---
async function applyDiscount(partnerPage, hotelName, roomType, checkIn, discountPct) {
    const { from: vFrom, till: vTill } = getValidityRange(checkIn);
    
    // Odayı bul ve gir
    await partnerPage.goto(`${PARTNER_BASE}/accomodation?task=hotels&pCountryId=100411293179&prtn=${PARTNER_PRTN}`, { waitUntil: 'domcontentloaded' });
    await partnerPage.type('input[name="searchHotel"]', hotelName);
    await partnerPage.click('input[name="bSearchHotel"]');
    await sleep(3000);

    const clicked = await partnerPage.evaluate((rName) => {
        const links = Array.from(document.querySelectorAll('a[href*="task=hotels"]'));
        const target = links.find(a => a.textContent.toUpperCase().includes(rName.toUpperCase()));
        if (target) { target.click(); return true; }
        return false;
    }, roomType);

    if (!clicked) throw new Error(`${roomType} bulunamadı.`);
    await sleep(3000);

    // Final price satırındaki [Price] linkine gir
    await partnerPage.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('tr'));
        for (const row of rows) {
            if (row.textContent.includes('Final price')) {
                const link = row.querySelector('a');
                if (link) { link.click(); return; }
            }
        }
        throw new Error('Final price satırı bulunamadı.');
    });
    await sleep(3000);

    // Mass Insert
    const massLink = await partnerPage.$('a[href*="task=staypay"]');
    await massLink.click();
    await sleep(3000);

    // SPO Bilgileri
    await partnerPage.evaluate(() => {
        const sel = document.querySelector('select[name="pIdST"]');
        if (sel) {
            for (const o of sel.options) if (o.text.includes('Early booking')) { sel.value = o.value; break; }
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
    await partnerPage.type('input[name="pPercPrice"]', discountPct.toFixed(3));
    await partnerPage.evaluate((f, t) => {
        const b = document.getElementById('pBeg');
        const e = document.getElementById('pEnd');
        if (b && e) { b.value = f; e.value = t; }
    }, vFrom, vTill);

    // CHECKBOX SEÇİMİ (Cost/Base/Final Seç - Board Type Pas Geç)
    await partnerPage.evaluate(() => {
        const cbs = document.querySelectorAll('input[type="checkbox"]');
        for (const cb of cbs) {
            const container = cb.closest('td, tr');
            const txt = container ? container.textContent : '';
            
            // Sola dayalı oda bloklarındaki Cost/Base/Final işaretle
            if (txt.includes('Cost price') || txt.includes('Base price') || txt.includes('Final price')) {
                cb.checked = true;
            }
            
            // Kişi sayılarını (Orta sütun) "Select all" değilse işaretle
            if (txt.includes('DBL') || txt.includes('AD') || txt.includes('CHD') || txt.includes('INF')) {
                cb.checked = true;
            }

            // EN SAĞ SÜTUN: "Base price" işaretle, "AI/HB/ULTRA" pas geç
            if (txt.includes('Base price') && !/AI|HB|ALL|ULTRA/i.test(txt)) {
                cb.checked = true;
            } else if (/AI|HB|ALL|ULTRA/i.test(txt)) {
                cb.checked = false;
            }
        }
    });

    const save = await partnerPage.$('input[value="Save"]');
    if (save) await save.click();
    await sleep(5000);
}

// --- Ana Döngü ---
async function main() {
    const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
    let offset = 0;

    while (true) {
        try {
            const updates = await tgRequest('getUpdates', { offset, timeout: 30 });
            for (const update of updates.result || []) {
                offset = update.update_id + 1;
                const cb = update.callback_query;
                if (!cb || !cb.data.startsWith('approve__')) continue;

                const [, hId, hName, rType, cIn, pen, riv] = cb.data.split('__');
                await sendMsg(`⏳ İşlem başladı: ${hName} - ${rType}`);

                try {
                    const ppRub = await fetchPpPrice(browser, hId, cIn);
                    const discountPct = 95.000; // Burası senin orijinal hesaplama fonksiyonun olmalı

                    const pPage = await browser.newPage();
                    // Not: Buraya kendi Login fonksiyonunu eklemeyi unutma
                    await applyDiscount(pPage, hName, rType, cIn, discountPct);
                    await sendMsg(`✅ Güncellendi: ${hName}`);
                } catch (err) {
                    await sendMsg(`❌ Hata: ${err.message}`);
                }
            }
        } catch (e) { await sleep(5000); }
    }
}
main();
