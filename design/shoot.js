const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });

  const shots = [
    { file: 'mockup-dashboard.html', out: 'mockup-dashboard.png' },
    { file: 'mockup-kanban.html', out: 'mockup-kanban.png' },
  ];

  for (const s of shots) {
    const filePath = 'file:///' + path.resolve(__dirname, s.file).replace(/\\/g, '/');
    await page.goto(filePath);
    await page.screenshot({ path: path.resolve(__dirname, s.out), fullPage: true });
    console.log('saved', s.out);
  }

  await browser.close();
})();
