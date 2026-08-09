import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const ROOM = 'demo_room_seed_0001';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const userQuery = 'devuser=2002&devname=%E7%95%8C%E9%9D%A2%E5%AE%A1%E8%AE%A1';

const routes = [
  { name: 'tab-lobby', path: '/', tab: 'lobby' },
  { name: 'tab-wallet', path: '/', tab: 'wallet' },
  { name: 'tab-chat', path: '/', tab: 'chat' },
  { name: 'tab-profile', path: '/', tab: 'profile' },
  { name: 'promotion', path: '/promotion' },
  { name: 'invite', path: '/invite' },
  { name: 'game-detail', path: `/game/${ROOM}` },
  { name: 'game-room', path: `/game/${ROOM}/play`, screenshot: true },
  { name: 'packet-detail', path: `/game/${ROOM}/packet` },
  { name: 'send-packet', path: `/game/${ROOM}/send-packet`, screenshot: true },
  { name: 'tip', path: `/game/${ROOM}/tip`, screenshot: true },
  { name: 'game-rules', path: '/game-rules' },
  { name: 'rewards', path: '/rewards' },
  { name: 'leaderboards', path: '/leaderboards' },
  { name: 'support', path: '/support' },
  { name: 'wallet-orders', path: '/wallet/orders' },
  { name: 'wallet-funds', path: '/wallet/funds' },
  { name: 'deposit', path: '/wallet/deposit' },
  { name: 'withdraw', path: '/wallet/withdraw' },
  { name: 'withdraw-accounts', path: '/wallet/withdraw/accounts' },
  { name: 'notices', path: '/notices' },
  { name: 'legal-terms', path: '/legal/terms' },
];

const viewports = [
  { width: 320, height: 760 },
  { width: 375, height: 812 },
  { width: 430, height: 932 },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ['--disable-background-networking'],
});

const results = [];

for (const viewport of viewports) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    localStorage.setItem('nn_dev_user', '2002');
    localStorage.setItem('nn_device_id', 'demo-device-uuid-2002');
  });
  const page = await context.newPage();

  for (const route of routes) {
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const onConsole = (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    };
    const onPageError = (error) => pageErrors.push(error.message);
    const onResponse = (response) => {
      if (response.status() >= 400) {
        const url = new URL(response.url());
        failedRequests.push(`${response.status()} ${url.pathname}${url.search}`);
      }
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('response', onResponse);

    if (route.tab) {
      await page.goto(`${BASE}/?${userQuery}#/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.evaluate((tab) => sessionStorage.setItem('miniapp-tab', tab), route.tab);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else {
      await page.goto(`${BASE}/?${userQuery}#${route.path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    }
    await page.waitForTimeout(route.name === 'game-room' ? 1_800 : 900);

    const before = await page.evaluate(() => {
      const viewportWidth = window.innerWidth;
      const overflowers = [...document.querySelectorAll('*')]
        .filter((node) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          return rect.left < -1 || rect.right > viewportWidth + 1;
        })
        .slice(0, 15)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            tag: node.tagName.toLowerCase(),
            className: node.className?.toString().slice(0, 100) ?? '',
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          };
        });

      const brokenImages = [...document.images]
        .filter((image) => image.complete && image.naturalWidth === 0)
        .map((image) => image.getAttribute('src'));

      const tinyTargets = [...document.querySelectorAll('button, a, input, [role="button"]')]
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0 &&
            (rect.width < 40 || rect.height < 40)
          );
        })
        .slice(0, 20)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            tag: node.tagName.toLowerCase(),
            className: node.className?.toString().slice(0, 80) ?? '',
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            text: node.textContent?.trim().slice(0, 30) ?? '',
          };
        });

      return {
        url: location.hash.slice(1) || '/',
        title: document.title,
        viewportWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        horizontalOverflow: document.documentElement.scrollWidth > viewportWidth + 1,
        overflowers,
        brokenImages,
        tinyTargets,
        loadingVisible: document.body.innerText.includes('加载中…'),
        bodyExcerpt: document.body.innerText.trim().slice(0, 180),
      };
    });

    if (route.screenshot && viewport.width === 375) {
      await page.screenshot({
        path: `/Users/karl/Desktop/MALAYSIA 牛牛/ui-audit-${route.name}.png`,
        fullPage: true,
      });
    }

    const pathBeforeRefresh = new URL(page.url()).hash;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(route.name === 'game-room' ? 1_400 : 700);
    const after = await page.evaluate(() => ({
      path: location.hash,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      loadingVisible: document.body.innerText.includes('加载中…'),
      errorVisible: /失败|异常|错误|未登录|请从 Telegram/.test(document.body.innerText),
      bodyExcerpt: document.body.innerText.trim().slice(0, 180),
    }));

    results.push({
      viewport: viewport.width,
      route: route.name,
      before,
      refresh: {
        pathPreserved: after.path === pathBeforeRefresh,
        ...after,
      },
      consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
      pageErrors: [...new Set(pageErrors)].slice(0, 10),
      failedRequests: [...new Set(failedRequests)].slice(0, 15),
    });

    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }
  await context.close();
}

await browser.close();

const summary = {
  audited: results.length,
  horizontalOverflow: results
    .filter((row) => row.before.horizontalOverflow || row.refresh.horizontalOverflow)
    .map((row) => ({
      viewport: row.viewport,
      route: row.route,
      overflowers: row.before.overflowers,
    })),
  brokenImages: results
    .filter((row) => row.before.brokenImages.length)
    .map((row) => ({ viewport: row.viewport, route: row.route, images: row.before.brokenImages })),
  refreshFailures: results
    .filter(
      (row) =>
        !row.refresh.pathPreserved ||
        row.refresh.loadingVisible ||
        row.refresh.errorVisible ||
        row.pageErrors.length,
    )
    .map((row) => ({
      viewport: row.viewport,
      route: row.route,
      refresh: row.refresh,
      pageErrors: row.pageErrors,
    })),
  requestFailures: results
    .filter((row) => row.failedRequests.length)
    .map((row) => ({
      viewport: row.viewport,
      route: row.route,
      failedRequests: row.failedRequests,
    })),
  tinyTargets: results
    .filter((row) => row.before.tinyTargets.length)
    .map((row) => ({
      viewport: row.viewport,
      route: row.route,
      targets: row.before.tinyTargets,
    })),
  all: results,
};

console.log(JSON.stringify(summary, null, 2));
