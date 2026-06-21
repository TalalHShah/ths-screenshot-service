// Tiny self-hosted screenshot service for thsplay.com's "Capture Graphic" feature.
//
// Why this exists: thsplay's hosting (shared cPanel) can't run a headless browser itself, and
// paid screenshot APIs charge per-shot with a monthly cap. This is a free alternative — one
// small Node service, run on a free hosting tier, that does exactly one thing: given a URL
// (and optionally a CSS selector), return a real screenshot of that element as a JPEG. The
// shared SECRET prevents random internet traffic from using this as a free screenshot proxy.

const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// Using puppeteer-core + @sparticuz/chromium instead of plain puppeteer: plain puppeteer
// downloads its Chrome binary to a separate cache directory at install time, which Render's
// Node buildpack doesn't reliably carry over from the build step into the actual running
// container ("Could not find Chrome" at runtime despite a successful build). Sparticuz's
// Chromium ships as a real file inside node_modules, so it's guaranteed to be present
// wherever node_modules itself ends up.

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SCREENSHOT_SECRET;

// One shared browser instance, reused across requests — launching Chromium fresh per request
// is slow and memory-heavy, which matters a lot on a free tier's limited RAM. But a heavier
// real page (video backgrounds, fonts, animations) can run the browser out of memory and
// crash it — without recovery, every request after that hangs forever waiting on a dead
// browser. The 'disconnected' listener resets the cached promise so the next call relaunches
// a fresh browser instead of reusing a corpse.
let browserPromise = null;
function getBrowser() {
    if (!browserPromise) {
        browserPromise = (async () => {
            const executablePath = await chromium.executablePath();
            const browser = await puppeteer.launch({
                executablePath,
                headless: chromium.headless,
                // --single-process was dropped: it trades memory for stability, and a single
                // page crash was taking down the entire shared browser instance with it.
                args: [...chromium.args, '--disable-dev-shm-usage'],
            });
            browser.on('disconnected', () => { browserPromise = null; });
            return browser;
        })();
        browserPromise.catch((err) => {
            console.error('Browser launch failed:', err);
            browserPromise = null;
        });
    }
    return browserPromise;
}

// A hard ceiling on the whole request, independent of any individual Puppeteer call's own
// timeout — guarantees the HTTP request always gets SOME response within a bounded time
// instead of hanging indefinitely if something unexpected stalls.
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)),
    ]);
}

app.get('/screenshot', async (req, res) => {
    if (!SECRET || req.query.secret !== SECRET) {
        return res.status(403).send('Forbidden');
    }
    const { url, selector } = req.query;
    if (!url) return res.status(400).send('Missing url parameter');

    let page;
    try {
        // Repeated launch timeouts at 15s suggest the free-tier CPU genuinely needs more time
        // for Chromium to start, not that it's stuck — widening this before assuming it's broken.
        const browser = await withTimeout(getBrowser(), 40000, 'Browser launch');
        page = await browser.newPage();
        await page.setViewport({ width: 1300, height: 1000, deviceScaleFactor: 1 });
        // networkidle0 waits for ZERO active network connections for 500ms — a page with an
        // autoplaying/looping background video or audio track never satisfies that condition,
        // since the browser keeps streaming it indefinitely. Waiting for DOM-ready plus the
        // specific element we actually need is what matters for a screenshot, not total
        // network silence.
        await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }), 17000, 'Page navigation');

        let clip;
        if (selector) {
            await page.waitForSelector(selector, { timeout: 8000 }).catch(() => {});
            // A short settle delay lets fonts/images inside the target element finish
            // rendering after it first appears in the DOM, without waiting on the page's
            // unrelated background media.
            await new Promise(r => setTimeout(r, 800));
            const el = await page.$(selector);
            if (el) {
                const box = await el.boundingBox();
                if (box) clip = box;
            }
        }

        // Free-tier CPU is slow at compositing/encoding a tall table — this isn't a hang risk
        // like network waits, just bounded work that needs more time than a typical request.
        const buffer = await withTimeout(page.screenshot({
            type: 'jpeg',
            quality: 90,
            clip,
            fullPage: !clip,
        }), 25000, 'Screenshot capture');

        res.set('Content-Type', 'image/jpeg');
        res.send(buffer);
    } catch (err) {
        console.error('Screenshot error:', err);
        if (!res.headersSent) res.status(502).send('Screenshot failed: ' + err.message);
    } finally {
        if (page) await page.close().catch(() => {});
    }
});

app.get('/', (req, res) => res.send('THS screenshot service is running.'));

app.listen(PORT, () => console.log('Listening on port ' + PORT));
