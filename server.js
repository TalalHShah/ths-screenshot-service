// Tiny self-hosted screenshot service for thsplay.com's "Capture Graphic" feature.
//
// Why this exists: thsplay's hosting (shared cPanel) can't run a headless browser itself, and
// paid screenshot APIs charge per-shot with a monthly cap. This is a free alternative — one
// small Node service, run on a free hosting tier, that does exactly one thing: given a URL
// (and optionally a CSS selector), return a real screenshot of that element as a JPEG. The
// shared SECRET prevents random internet traffic from using this as a free screenshot proxy.

const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SCREENSHOT_SECRET;

// One shared browser instance, reused across requests — launching Chromium fresh per request
// is slow and memory-heavy, which matters a lot on a free tier's limited RAM.
let browserPromise = null;
function getBrowser() {
    if (!browserPromise) {
        browserPromise = puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // free-tier containers often have a tiny /dev/shm
                '--disable-gpu',
                '--single-process', // trades some stability for a meaningfully smaller memory footprint
            ],
        });
    }
    return browserPromise;
}

app.get('/screenshot', async (req, res) => {
    if (!SECRET || req.query.secret !== SECRET) {
        return res.status(403).send('Forbidden');
    }
    const { url, selector } = req.query;
    if (!url) return res.status(400).send('Missing url parameter');

    let page;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        await page.setViewport({ width: 1300, height: 1000, deviceScaleFactor: 2 });
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });

        let clip;
        if (selector) {
            await page.waitForSelector(selector, { timeout: 5000 }).catch(() => {});
            const el = await page.$(selector);
            if (el) {
                const box = await el.boundingBox();
                if (box) clip = box;
            }
        }

        const buffer = await page.screenshot({
            type: 'jpeg',
            quality: 90,
            clip,
            fullPage: !clip,
        });

        res.set('Content-Type', 'image/jpeg');
        res.send(buffer);
    } catch (err) {
        console.error('Screenshot error:', err);
        res.status(502).send('Screenshot failed: ' + err.message);
    } finally {
        if (page) await page.close().catch(() => {});
    }
});

app.get('/', (req, res) => res.send('THS screenshot service is running.'));

app.listen(PORT, () => console.log('Listening on port ' + PORT));
