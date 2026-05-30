const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });
  const rootHtml = await page.$eval('#root', el => el.innerHTML);
  console.log(rootHtml.slice(0, 500));
  await browser.close();
})();
