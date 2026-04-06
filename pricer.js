/**
 * pricer.js - Güncellenmiş & Geliştirilmiş Versiyon
 * Per Person (PP) hatası giderildi ve fiyat çekme mantığı güçlendirildi.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const https = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PARTNER_USER = process.env.PARTNER_USER;
const PARTNER_PASS = process.env.PARTNER_PASS;

const PASS_URL = 'https://pass1.bibliki.ru';
const BIBLIO_BASE = 'https://www.bgoperator.ru';
const PARTNER_BASE = 'https://partner.bgoperator.ru';
const PARTNER_PRTN = '115810428452';

const PASS_WAIT_MS = 5 * 60 * 1000;
let passCompleted = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n) { return String(n).padStart(2, '0'); }

// --- Tarih Yardımcıları ---
function getValidityRange(checkIn) {
    const [, m, y] = checkIn.split('.');
    const month = parseInt(m, 10);
    const year = parseInt(y, 10);
    const today = new Date();
    const todayMonth = today.getMonth() + 1;
    const todayYear = today.getFullYear();
    const lastDay = new Date(year, month, 0).getDate();
    let fromDay = 1;
    if (year === todayYear && month === todayMonth) fromDay = today.getDate();
    return {
        from: `${fmt(fromDay)}.${fmt(month)}.${year}`,
        till: `${fmt(lastDay)}.${fmt(month)}.${year}`,
    };
}

// --- Telegram ---
async function tgRequest(method, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = https.request(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
            res => { let s = ''; res.on('data', d => s += d); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve({}); } }); }
        );
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function sendMsg(text) { return tgRequest('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }); }
async function answerCb(id, text) { return tgRequest('answerCallbackQuery', { callback_query_id: id, text }); }
async function getUpdates(offset) { return tgRequest('getUpdates', { offset, timeout: 30, allowed_updates: ['callback_query'] }); }

// --- 1. Pass: IP Whitelist ---
async function doPass(browser) {
    if (passCompleted) return;
    const page = await browser.newPage();
    await page.authenticate({ username: PARTNER_USER, password: PARTNER_PASS });
    try {
        await page.goto(PASS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('[Pass] 5 dakika bekleniyor...');
        await sleep(PASS_WAIT_MS);
        passCompleted = true;
    } catch (e) {
        console.warn('[Pass] Hata:', e.message);
    } finally {
        await page.close();
    }
}

// --- 2. EUR Kuru Çek ---
async function fetchEurRate(browser) {
    const page = await browser.newPage();
    try {
        await page.goto(`${BIBLIO_BASE}/price.shtml?action=price&tid=211`, { waitUntil: 'networkidle2', timeout: 30000 });
        const rate = await page.evaluate(() => {
            const lis = document.querySelectorAll('ul.rates li');
            for (const li of lis) {
                const b = li.querySelector('b.c_l');
                if (b && b.textContent.trim() === 'EUR') {
                    const i = li.querySelector('i');
                    if (i) return parseFloat(i.textContent.trim().replace(',', '.'));
                }
            }
            const m = document.body.innerText.match(/EUR\s+(\d+[.,]\d+)/);
            return m ? parseFloat(m[1].replace(',', '.')) : null;
        });
        return rate;
    } finally { await page.close(); }
}

// --- 3. Partner Login ---
async function partnerLogin(browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(`${PARTNER_BASE}/`, { waitUntil: 'networkidle2' });
    const loginInput = await page.$('input[name="login"]');
    if (!loginInput) return page;
    await page.type('input[name="login"]', PARTNER_USER);
    await page.type('input[name="password"]', PARTNER_PASS);
    await Promise.all([page.waitForNavigation(), page.click('input[type="submit"]')]);
    return page;
}

// --- 4. Biblio'dan PP Fiyatı Çek (DÜZELTİLDİ) ---
async function fetchPpPrice(browser, hotelId, hotelName, checkIn) {
    console.log(`[PP] ${hotelName} - ${checkIn} için fiyat çekiliyor...`);
    const [d, m, y] = checkIn.split('.').map(Number);
    const checkInDate = new Date(y, m - 1, d);
    const checkOutDate = new Date(checkInDate);
    checkOutDate.setDate(checkOutDate.getDate() + 7);
    const fmtDate = dt => `${fmt(dt.getDate())}.${fmt(dt.getMonth()+1)}.${dt.getFullYear()}`;

    // Arama linki
    const searchUrl = `${BIBLIO_BASE}/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=121110211811&data=${fmtDate(checkInDate)}&d2=${fmtDate(checkOutDate)}&f7=7&ho=0&F4=${hotelId}&ins=0-40000-EUR&flt=100411293179&p=0100319900.0100319900`;

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    try {
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(4000); // Fiyatların render olması için ekstra süre

        const ppResult = await page.evaluate(() => {
            const grayFonts = document.querySelectorAll('font[color="#909090"]');
            let bestPp = null;

            for (const font of grayFonts) {
                const title = font.getAttribute('title') || '';
                // dp: sonrası veriyi temizce alıyoruz
                if (title.includes('dp:')) {
                    const dpContent = title.split('dp:')[1];
                    const prices = dpContent.split(',')
                        .map(p => parseFloat(p.replace(/[^0-9.]/g, '')))
                        .filter(p => !isNaN(p) && p > 0);

                    if (prices.length > 0) {
                        // İlk 7 günün (paket süresi) ortalama DBL oda fiyatı
                        const relevant = prices.slice(0, 7);
                        const avgDbl = relevant.reduce((a, b) => a + b, 0) / relevant.length;
                        const pp = avgDbl / 2; // Çift kişilikten kişi başına düşür

                        if (bestPp === null || pp < bestPp) bestPp = pp;
                    }
                }
            }
            return bestPp;
        });

        console.log(`[PP] Sonuç: ${ppResult ? ppResult.toFixed(2) + ' RUB' : 'BULUNAMADI'}`);
        return ppResult;
    } finally {
        await page.close();
    }
}

// --- 5. İndirim Hesapla ---
function calcDiscount(ppRub, rivalEUR, peninsulaEUR, eurRate) {
    const diffEur = peninsulaEUR - rivalEUR; // Rakip bizden ne kadar ucuz (paket bazında)
    const rivalPpRub = ppRub - (diffEur * eurRate) / 2; // 2 kişi payı
    const targetPpRub = rivalPpRub - eurRate; // Rakibin 1 EUR altına in

    if (targetPpRub <= 0) return null;
    const discountPct = (targetPpRub / ppRub) * 100;
    return (discountPct < 85) ? null : discountPct; // %85 altı (çok aşırı indirim) güvenlik sınırı
}

// --- 6. Partner SPO Uygula ---
async function applyDiscount(partnerPage, hotelName, checkIn, discountPct) {
    const { from: vFrom, till: vTill } = getValidityRange(checkIn);
    const searchUrl = `${PARTNER_BASE}/accomodation?task=hotels&pCountryId=100411293179&prtn=${PARTNER_PRTN}`;
    
    await partnerPage.goto(searchUrl, { waitUntil: 'networkidle2' });
    await partnerPage.waitForSelector('input[name="searchHotel"]');
    await partnerPage.type('input[name="searchHotel"]', hotelName);
    await partnerPage.click('input[name="bSearchHotel"]');
    
    await sleep(3000);
    const hotelLink = await partnerPage.$('a[href*="task=hotels"][href*="hotelId"]');
    if (!hotelLink) throw new Error('Otel linki bulunamadı.');
    await hotelLink.click();

    await sleep(3000);
    const massLink = await partnerPage.$('a[href*="task=staypay"]');
    await massLink.click();

    await sleep(3000);
    // SPO Seçimi, Tarih ve Oran girişi
    await partnerPage.evaluate((pct, f, t) => {
        // SPO Tipi seç
        const selects = document.querySelectorAll('select');
        for (const s of selects) {
            for (const o of s.options) {
                if (o.text.includes('Early booking on period (on percentage basis)')) {
                    s.value = o.value;
                    s.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }
        // Oran yaz
        const pctInput = document.querySelector('input[name="pPercPrice"]');
        if (pctInput) pctInput.value = pct;

        // Tarihler
        const dateInputs = Array.from(document.querySelectorAll('input[type="text"]'))
             .filter(i => /\d{2}\.\d{2}\.\d{4}/.test(i.value) || i.name.includes('IPBeg') || i.name.includes('IPEnd'));
        if (dateInputs.length >= 2) {
            dateInputs[0].value = f;
            dateInputs[1].value = t;
        }
    }, discountPct.toFixed(3), vFrom, vTill);

    // Checkbox Seçimleri (Base Price)
    await partnerPage.evaluate(() => {
        const cbs = document.querySelectorAll('input[type="checkbox"]');
        cbs.forEach(cb => {
            const text = cb.closest('td')?.textContent || '';
            if (text.includes('Select all')) {
                // İlk iki sütunu seç (Oda ve Kişi tipi)
                const colIdx = Array.from(cb.closest('tr').cells).indexOf(cb.closest('td'));
                if (colIdx < 2) cb.click();
            }
            if (text.includes('Base price')) cb.checked = true;
            else if (['ULTRA', 'AI', 'HB'].some(k => text.includes(k))) cb.checked = false;
        });
    });

    const saveBtn = await partnerPage.$('input[value="Save"]');
    await saveBtn.click();
    await sleep(5000);
}

// --- Ana İşlem Döngüsü ---
async function processApproval(cbData, browser, partnerPage) {
    const [, hId, hName, cIn, penEur, rivEur] = cbData.split('__');
    const eurRate = await fetchEurRate(browser);
    if (!eurRate) throw new Error('Kur çekilemedi');

    const ppRub = await fetchPpPrice(browser, hId, hName, cIn);
    if (!ppRub) throw new Error(`PP fiyatı bulunamadı: ${hName}`);

    const discountPct = calcDiscount(ppRub, parseInt(rivEur), parseInt(penEur), eurRate);
    if (!discountPct) throw new Error('İndirim hesaplanamadı.');

    await applyDiscount(partnerPage, hName, cIn, discountPct);

    return { ok: true, hName, cIn, discountPct: discountPct.toFixed(3), eurRate: eurRate.toFixed(2), ppRub: ppRub.toFixed(2) };
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    let partnerPage = null;
    let offset = 0;

    while (true) {
        try {
            const updates = await getUpdates(offset);
            if (!updates.ok) { await sleep(5000); continue; }

            for (const update of updates.result) {
                offset = update.update_id + 1;
                const cb = update.callback_query;
                if (!cb || !cb.data.startsWith('approve__')) continue;

                await answerCb(cb.id, '⏳ İşleniyor...');
                if (!partnerPage || partnerPage.isClosed()) {
                    await doPass(browser);
                    partnerPage = await partnerLogin(browser);
                }

                const res = await processApproval(cb.data, browser, partnerPage);
                await sendMsg(`✅ <b>SPO Uygulandı</b>\n\n🏨 ${res.hName}\n📉 Oran: %${res.discountPct}\n💱 Kur: ${res.eurRate}\n🛏 PP: ${res.ppRub} RUB`);
            }
        } catch (e) {
            console.error('Hata:', e.message);
            await sleep(5000);
        }
    }
}

main();
