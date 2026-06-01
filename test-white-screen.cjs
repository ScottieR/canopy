const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => {
    console.log(`PAGE LOG [${msg.type()}]:`, msg.text());
  });
  
  page.on('pageerror', err => {
    console.error('PAGE ERROR:', err.toString());
  });

  page.on('requestfailed', request => {
    console.error(`REQUEST FAILED: ${request.url()} - ${request.failure()?.errorText}`);
  });

  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });
  
  const rootHtml = await page.$eval('#root', el => el.innerHTML);
  console.log('Root HTML length:', rootHtml.length);
  if (rootHtml.length < 500) {
    console.log('Root HTML:', rootHtml);
  }
  
  await browser.close();
})();
