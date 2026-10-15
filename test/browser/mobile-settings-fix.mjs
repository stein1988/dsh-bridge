// 移动端设置页「全面修复」运行时验收（真实 GUI）：几何 + 可达性 + 视图切换
// 用法：node test/browser/mobile-settings-fix.mjs
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { suiteResult, openSettings, clickSettingsCell, installLegacySelectorBridge, checkNavReachable, launchOptions, shotsDir, connect } from './helpers.mjs';

const SHOTS = shotsDir('mobile-settings-fix');
const CHROME = launchOptions().executablePath;
const { port: PORT, cookie: c, cookieName: cn } = connect();

const results = [];
const record = (viewport, name, ok, detail) => {
  results.push({ viewport, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${viewport}] ${name}${detail ? ' — ' + detail : ''}`);
};

const VIEWPORTS = [
  { name: '375x667', width: 375, height: 667, narrow: true },
  { name: '390x844', width: 390, height: 844, narrow: true },
  { name: '412x915', width: 412, height: 915, narrow: true },
  { name: '667x375-landscape', width: 667, height: 375, narrow: false },
  { name: '768x1024-desktop', width: 768, height: 1024, narrow: false },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const snap = () =>
  (() => {
    const ov = document.querySelector('[class*="VOzbGW_overlay"]');
    if (!ov) return { found: false };
    const panel = ov.querySelector('[class*="VOzbGW_panel"]');
    const nav = ov.querySelector('nav[class*="VOzbGW_nav"]');
    const content = [...panel.children].find((x) => x !== nav);
    const options = ov.querySelector('[class*="VOzbGW_options"]');
    const navList = ov.querySelector('[class*="VOzbGW_navList"]');
    const navTitle = ov.querySelector('[class*="VOzbGW_navTitle"]');
    const close = ov.querySelector('[class*="VOzbGW_close"]');
    const cs = (e) => (e ? getComputedStyle(e) : null);
    const rect = (e) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    };
    const optRect = options ? options.getBoundingClientRect() : null;
    // 「永久不可达」= 元素被最近的 overflow-x:hidden/clip 祖先裁掉。
    // 注意不能只比 options 右边界：Tab 条这类 overflow-x:auto 的子容器本身可横滑，
    // 它的分页越出容器边界但用户滑一下就能看到，属于「可达」。
    const isClippedByHiddenAncestor = (el) => {
      const r = el.getBoundingClientRect();
      let a = el.parentElement;
      while (a) {
        const cs = getComputedStyle(a);
        // 第一个 overflow-x 非 visible 的祖先才决定裁切语义：
        // auto/scroll → 用户能滑出来（可达）；hidden/clip → 超出即永久不可见
        if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return null;
        if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') {
          return r.right > a.getBoundingClientRect().right + 1 ? a : null;
        }
        if (a === options) break;
        a = a.parentElement;
      }
      return null;
    };
    const unreachable = options
      ? [...options.querySelectorAll('*')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0 && r.right > optRect.right + 1)) return false;
            return !!isClippedByHiddenAncestor(el);
          })
          .map((el) => ({
            tag: el.tagName,
            cls: String(el.className).slice(0, 40),
            text: (el.textContent || '').trim().slice(0, 16),
            right: Math.round(el.getBoundingClientRect().right),
          }))
      : [];
    const optionsUserScrollableX = options ? cs(options).overflowX === 'auto' || cs(options).overflowX === 'scroll' : false;
    const navCells = nav
      ? [...nav.querySelectorAll('button[class*="VOzbGW_navCell"]')].map((b) => {
          const r = b.getBoundingClientRect();
          const nr = nav.getBoundingClientRect();
          return {
            text: (b.textContent || '').trim(),
            rect: rect(b),
            fullyInsideNav: r.top >= nr.top - 0.5 && r.bottom <= nr.bottom + 0.5,
          };
        })
      : [];
    const updateBtn = options ? [...options.querySelectorAll('button')].find((b) => /检查更新|检查中/.test(b.textContent || '')) : null;
    const tabbar = ov.querySelector('.dsh-tabbar-container');
    return {
      found: true,
      viewAttr: panel.getAttribute('data-dshbr-settings-view'),
      panel: rect(panel),
      nav: rect(nav),
      content: rect(content),
      contentOrder: cs(content)?.order,
      options: rect(options),
      optionsDisplay: cs(options)?.display,
      optionsOverflowX: cs(options)?.overflowX,
      optionsUserScrollableX,
      optionsScrollW: options?.scrollWidth,
      optionsClientW: options?.clientWidth,
      navListDisplay: cs(navList)?.display,
      navTitleDisplay: cs(navTitle)?.display,
      navTitleText: (navTitle?.textContent || '').trim(),
      close: rect(close),
      closeVisible: !!close && close.offsetParent !== null && close.getBoundingClientRect().width > 0,
      closeInsideViewport: close ? close.getBoundingClientRect().right <= window.innerWidth + 0.5 && close.getBoundingClientRect().bottom <= window.innerHeight + 0.5 : false,
      unreachable,
      navCells,
      updateBtn: updateBtn ? { rect: rect(updateBtn), text: (updateBtn.textContent || '').trim() } : null,
      tabbar: tabbar
        ? {
            mask: getComputedStyle(tabbar).maskImage || getComputedStyle(tabbar).webkitMaskImage,
            scrollW: tabbar.scrollWidth,
            clientW: tabbar.clientWidth,
          }
        : null,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
    };
  })();

for (const vp of VIEWPORTS) {
  const label = vp.name;
  const page = await browser.newPage();
  // Issue #72：老套件写死 0.1.x 的 CSS-module 哈希，这里把查询字符串按宿主
  // 真实前缀改写（只改查询、不改 DOM），使其能打在任意代次宿主上。
  await installLegacySelectorBridge(page);
  await page.setCacheEnabled(false);
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: vp.narrow, hasTouch: vp.narrow });
 if (c) await page.setCookie({ name: cn, value: c.slice(cn.length + 1), domain: '127.0.0.1', path: '/' });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 4000));
  const didOpen = await openSettings(page);
  await new Promise((r) => setTimeout(r, 600));

  // ---- A. 打开后默认状态 ----
  const opened = await page.evaluate(snap);
  if (!opened.found) {
    record(label, '设置弹窗可打开', false, `入口点击=${didOpen}，但 overlay 未出现`);
    await page.close();
    continue;
  }
  record(label, '设置弹窗可打开', true);
  record(
    label,
    'options 不再是 overflow-x:hidden（恢复可达）',
    opened.optionsOverflowX === 'auto' || opened.optionsOverflowX === 'scroll',
    `overflow-x=${opened.optionsOverflowX}`,
  );
  record(
    label,
    '关闭按钮可见且在视口内',
    opened.closeVisible && opened.closeInsideViewport,
    `close=${JSON.stringify(opened.close)}`,
  );

  if (vp.narrow) {
    // 窄屏：默认应是分类列表页
    record(label, '默认落在分类列表页（options 隐藏、navList 可见）', opened.optionsDisplay === 'none' && opened.navListDisplay !== 'none', `options.display=${opened.optionsDisplay} navList.display=${opened.navListDisplay}`);
    await page.screenshot({ path: path.join(SHOTS, `${label}__menu.png`) });

    // 点第 3 个分类（远程访问）：宿主有间歇性自动关闭弹窗的抖动，带重试并如实记录
    const entered = await clickSettingsCell(page, 2);
    const detail = entered.ok ? await page.evaluate(snap) : { found: false };
    if (!detail.found) {
      record(label, '点分类行进入详情页（options 可见、navList 收起）', false, `进入详情页失败：${entered.reason ?? '弹窗消失'}（宿主自动关闭 ${entered.closedTimes} 次）`);
      await page.close();
      continue;
    }
    record(label, '点分类行进入详情页（options 可见、navList 收起）', detail.viewAttr === 'detail' && detail.optionsDisplay !== 'none' && detail.navListDisplay === 'none', `attr=${detail.viewAttr} options.display=${detail.optionsDisplay} navList.display=${detail.navListDisplay}`);
    record(label, '详情页关闭按钮仍可见', detail.closeVisible && detail.closeInsideViewport);
    record(
      label,
      '详情页无被 overflow:hidden 永久裁切的元素',
      detail.unreachable.length === 0,
      `unreachable=${detail.unreachable.length} optionsScrollW/clientW=${detail.optionsScrollW}/${detail.optionsClientW} ${JSON.stringify(detail.unreachable.slice(0, 3))}`,
    );
    record(
      label,
      '版本行「检查更新」未被裁切且单行',
      !!detail.updateBtn && detail.updateBtn.rect.h <= 26 && detail.updateBtn.rect.right <= (detail.options?.right ?? 0) + 1,
      detail.updateBtn ? `h=${detail.updateBtn.rect.h} right=${detail.updateBtn.rect.right} optionsRight=${detail.options?.right}` : 'not found',
    );
    record(label, '内容列宽度 ≥ 340px（钻取后内容占满整宽）', (detail.options?.w ?? 0) >= 340, `options.w=${detail.options?.w}`);
    await page.screenshot({ path: path.join(SHOTS, `${label}__detail.png`) });

    // 点折叠后的标题行返回
    await page.evaluate(() => {
      const ov = document.querySelector('[class*="VOzbGW_overlay"]');
      ov.querySelector('div[class*="VOzbGW_navTitle"]').click();
    });
    await new Promise((r) => setTimeout(r, 900));
    const back = await page.evaluate(snap);
    record(label, '点折叠标题行可返回分类列表', back.viewAttr === null && back.optionsDisplay === 'none', `attr=${back.viewAttr} options.display=${back.optionsDisplay}`);
  } else {
    // 非窄屏（481-767 轨道 / >=768 桌面）：分类行必须**可达**（能滚进容器并点中）。
    // 不再要求"一屏全部塞下"：宿主分类已从 6 项增到 8 项，矮视口必然放不下，
    // 而 navList 是 overflow-y:auto 的可滚动容器，滚动可达才是真正的不变量。
    const navReach = await checkNavReachable(page);
    const clipped = opened.navCells.filter((x) => !x.fullyInsideNav);
    record(
      label,
      '全部分类行可滚动到达并可点中（无永久竖切）',
      navReach.allReachable && navReach.count > 0,
      `count=${navReach.count} scrollable=${navReach.scrollable} 一屏外=${clipped.length} 不可达=${JSON.stringify(navReach.unreachable)}`,
    );
    record(label, '非窄屏不启用钻取（navList 可见）', opened.navListDisplay !== 'none', `navList.display=${opened.navListDisplay}`);
    await page.screenshot({ path: path.join(SHOTS, `${label}__rail.png`) });
  }

  // ---- Tab 条可达性（远程访问页） ----
  // 这一页靠宿主 navCell 顺序不定，故按文本找下标；宿主自动关闭抖动由 clickSettingsCell 兜住
  const remoteIdx = await page.evaluate(() => {
    const ov = document.querySelector('[class*="VOzbGW_overlay"]');
    if (!ov) return -1;
    return [...ov.querySelectorAll('button[class*="VOzbGW_navCell"]')].findIndex((x) => /远程访问/.test(x.textContent || ''));
  });
  const tabEntered = remoteIdx >= 0 ? await clickSettingsCell(page, remoteIdx) : { ok: false, reason: '未找到「远程访问」分类行', closedTimes: 0 };
  if (!tabEntered.ok) {
    record(label, 'Tab 条可横滑且 5 个分类都在（可滑到末尾）', false, `无法进入远程访问页：${tabEntered.reason}（宿主自动关闭 ${tabEntered.closedTimes} 次）`);
  }
  const tabs = tabEntered.ok ? await page.evaluate(() => {
    const ov = document.querySelector('[class*="VOzbGW_overlay"]');
    const tb = ov.querySelector('.dsh-tabbar-container');
    if (!tb) return null;
    const before = tb.scrollLeft;
    tb.scrollLeft = 9999;
    const maxScroll = tb.scrollLeft;
    tb.scrollLeft = before;
    const opts = ov.querySelector('[class*="VOzbGW_options"]');
    const right = opts.getBoundingClientRect().right;
    return {
      count: tb.querySelectorAll('button').length,
      scrollW: tb.scrollWidth,
      clientW: tb.clientWidth,
      maxScroll,
      userScrolled: maxScroll > before,
      mask: getComputedStyle(tb).maskImage || getComputedStyle(tb).webkitMaskImage,
      tabsBeyondRight: [...tb.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().right > right + 1).map((b) => (b.textContent || '').trim()),
      clippedTabs: [...tb.querySelectorAll('button')]
        .filter((b) => {
          const r = b.getBoundingClientRect();
          const cs = getComputedStyle(tb);
          const scrollable = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
          return r.right > tb.getBoundingClientRect().right + 1 && !scrollable;
        })
        .map((b) => (b.textContent || '').trim()),
      optionsOverflowX: getComputedStyle(opts).overflowX,
    };
  }) : null;
  if (tabs) {
    record(label, 'Tab 条可横滑且 5 个分类都在（可滑到末尾）', tabs.userScrolled && tabs.maxScroll > 0, `scrollW/clientW=${tabs.scrollW}/${tabs.clientW} maxScroll=${tabs.maxScroll}`);
    record(label, 'Tab 条有边缘渐隐提示（mask-image 非 none）', !!tabs.mask && tabs.mask !== 'none', String(tabs.mask).slice(0, 60));
    record(label, 'Tab 条分页全部落在各自可横滑容器内（无永久裁切）', tabs.clippedTabs.length === 0, `clippedTabs=${JSON.stringify(tabs.clippedTabs)}`);
  } else if (tabEntered.ok) {
    record(label, 'Tab 条可横滑且 5 个分类都在（可滑到末尾）', false, '远程访问页未渲染出 .dsh-tabbar-container');
    record(label, 'Tab 条有边缘渐隐提示（mask-image 非 none）', false, '无 Tab 条');
    record(label, 'Tab 条分页全部落在各自可横滑容器内（无永久裁切）', false, '无 Tab 条');
  }  await page.screenshot({ path: path.join(SHOTS, `${label}__tabs.png`) });
  await page.close();
}

await browser.close();
fs.writeFileSync(path.join(SHOTS, 'mobile-settings-fix.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
suiteResult({ label: '设置页几何 + 可达性 + 视图切换', pass: results.length - failed.length, fail: failed.length });
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - [${f.viewport}] ${f.name} :: ${f.detail}`);
  process.exitCode = 1;
}
