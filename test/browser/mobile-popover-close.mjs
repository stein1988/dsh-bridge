// 移动端宿主浮层统一收起按钮验收（回归：浮层铺满可视区时没有退出入口）
//
// 背景（issue 现场）：会话页在手机上打开「智能体团队」浮层后，用户看不到任何返回/关闭
// 入口。宿主这两处浮层都是桌面语义的 popover —— 靠鼠标移出、点浮层外空白或 Esc 收起，
// 自身不含关闭控件；而它们的高度上限已接近整屏（团队浮层 680px；子智能体下拉在矮屏 +
// 多子智能体时同样紧张），浏览器地址栏与底部导航条又把上下空白吃掉，于是"点外面"这条
// 唯一退路在手机上不可达。
//
// 本套件断言的是**行为**（真实 Chrome + 运行中的 dsh web + 本插件）：
//   A. 任意会话：团队浮层出现后插件注入的收起按钮存在、完整落在浮层可见区内、命中测试
//      可达，真实点击后浮层关闭；
//   B. 若能找到"大团队"会话（浮层高度 ≥ 400px，即本 issue 的现场形态），在**铺满屏**
//      的浮层上重复同一组断言（找不到则跳过，单独计数）；
//   C. 子智能体下拉（[aria-haspopup="tree"] 触发）：同一组断言，外加"矮屏下高度上限生效"；
//   D. 393x852 / 矮视口 360x560 复核；桌面宽度（>767px）两处浮层都不注入按钮。
// 需要 GUI 在跑：默认 127.0.0.1:3080（可用 DSH_WEB_PORT 覆盖）。
import puppeteer from 'puppeteer-core';
import { launchOptions, shotsDir, connect, openGui, dismissHostNotices, createReporter, suiteResult } from './helpers.mjs';

const OUT = shotsDir('mobile-popover-close');
const AUTH = connect();
const r = createReporter('移动端宿主浮层收起按钮');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const TEAM_PANEL = '[data-team-panel]';
const TEAM_TRIGGER = '[data-team-action] button';
const SUBAGENT_MENU = 'body > div[class*="_menu"]:has(> div[role="tree"])';
const SUBAGENT_TRIGGER = '[aria-haspopup="tree"]';
const CLOSE_BTN = '.dsh-mobile-popover-close-btn';
/** 「大团队」判据：浮层高度超过 400px 说明成员/任务已经把它撑到接近整屏 */
const TALL_PANEL_MIN = 400;
/** 扫描会话的上限（每条要开一次会话，控制在分钟级） */
const SCAN_LIMIT = 10;

const browser = await puppeteer.launch({ ...launchOptions(), protocolTimeout: 25000 });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

/**
 * 渲染进程存活探测。
 * 回归背景：注入逻辑跑在监听 class 的 MutationObserver 回调里，若在里面无条件写 class
 * （即使值没变，Chromium 也会写属性）就会变成微任务死循环，页面完全无响应、CDP 调用
 * 全部超时。这里用带超时的 evaluate 把它变成一条可读的 FAIL，而不是让整个套件挂在
 * protocolTimeout 上。
 */
async function rendererResponsive(budgetMs = 3000) {
  return Promise.race([
    page.evaluate(() => 1).then(() => true).catch(() => false),
    sleep(budgetMs).then(() => false),
  ]);
}

const listSessionTitles = () => page.evaluate(() => [...document.querySelectorAll('div[class*="sessionRow"]')]
  .map((el) => (el.textContent || '').trim().slice(0, 30)));

/** 打开抽屉并等到会话行出现：项目分组是懒展开的，必须轮询 + 必要时显式展开。
 *  桌面宽度下没有移动端抽屉，会话行直接就在侧栏里 —— 所以"已有行"时直接返回，
 *  不要求抽屉处于打开态（行在 DOM 里就能点，React 处理器照常触发）。 */
async function openDrawerWithRows() {
  for (let i = 0; i < 14; i++) {
    const titles = await listSessionTitles();
    if (titles.length) return titles;
    await page.evaluate(() => {
      if (!document.body.classList.contains('dsh-drawer-open')) {
        document.querySelector('.dsh-header-menu-btn')?.click();
        return;
      }
      const row = [...document.querySelectorAll('div[class*="projectRow"]')]
        .find((el) => el.getAttribute('aria-expanded') !== 'true');
      if (row) row.click();
    });
    await sleep(700);
  }
  return listSessionTitles();
}

/** 展开前 maxProjects 个未展开的工作区分组（目标会话可能在别的仓库里） */
async function expandProjects(maxProjects) {
  for (let i = 0; i < maxProjects; i++) {
    const expanded = await page.evaluate(() => {
      const row = [...document.querySelectorAll('div[class*="projectRow"]')]
        .find((el) => el.getAttribute('aria-expanded') !== 'true');
      if (!row) return false;
      row.click();
      return true;
    });
    if (!expanded) return;
    await sleep(900);
  }
}

/** 点开标题匹配的会话；返回标题或 null */
async function openSessionByTitle(title) {
  await openDrawerWithRows();
  const clicked = await page.evaluate((needle) => {
    const row = [...document.querySelectorAll('div[class*="sessionRow"]')]
      .find((el) => (el.textContent || '').includes(needle));
    if (!row) return null;
    row.click();
    return (row.textContent || '').trim().slice(0, 30);
  }, title);
  if (clicked === null) return null;
  for (let i = 0; i < 12; i++) {
    if (await page.evaluate((sel) => !!document.querySelector(sel), TEAM_TRIGGER)) return clicked;
    await sleep(400);
  }
  return null;
}

/** 按宿主的"点外面"语义收起当前浮层 */
async function dismissPopover(popoverSel) {
  if (!(await page.evaluate((sel) => !!document.querySelector(sel), popoverSel))) return;
  await page.evaluate(() => document.body.dispatchEvent(new (window.PointerEvent ?? window.MouseEvent)('pointerdown', { bubbles: true })));
  await sleep(400);
}

/** 打开某个宿主浮层；返回浮层/按钮几何（没开出来时返回 null） */
async function openPopover(popoverSel, triggerSel) {
  for (let i = 0; i < 3; i++) {
    await dismissPopover(popoverSel);
    await page.evaluate((sel) => document.querySelector(sel)?.click(), triggerSel);
    await sleep(900);
    const geo = await page.evaluate((popSel, btnSel) => {
      const popover = document.querySelector(popSel);
      if (!popover) return null;
      const pr = popover.getBoundingClientRect();
      const btn = popover.querySelector(btnSel);
      const br = btn ? btn.getBoundingClientRect() : null;
      const hit = br ? document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2) : null;
      return {
        popover: pr.toJSON(),
        button: br ? br.toJSON() : null,
        buttonText: btn ? (btn.textContent || '').trim() : null,
        buttonAria: btn ? btn.getAttribute('aria-label') : null,
        buttonKey: btn ? btn.getAttribute('data-dshbr-popover') : null,
        hitIsButton: btn && hit ? btn === hit || btn.contains(hit) : false,
        hitTag: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null,
        viewport: { w: innerWidth, h: innerHeight },
        maxHeight: getComputedStyle(popover).maxHeight,
        paddingTop: getComputedStyle(popover).paddingTop,
        rows: popover.querySelectorAll('article, [role="treeitem"]').length,
      };
    }, popoverSel, CLOSE_BTN);
    if (geo) return geo;
  }
  return null;
}

/** 真实点击收起按钮并等待浮层消失 */
async function clickCloseButton(popoverSel, geo) {
  if (!geo?.button) return false;
  await page.mouse.click(geo.button.left + geo.button.width / 2, geo.button.top + geo.button.height / 2);
  for (let i = 0; i < 12; i++) {
    await sleep(200);
    if (!(await page.evaluate((sel) => !!document.querySelector(sel), popoverSel))) return true;
  }
  return false;
}

/** 按钮是否完整落在浮层可见区内（容差 1px） */
function inside(outer, inner) {
  return inner.left >= outer.left - 1 && inner.right <= outer.right + 1
    && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
}

/** 一组通用断言：按钮存在/可见区内/可达 + 点击后浮层关闭 */
async function assertCloseAffordance(label, popoverSel, geo, shotName) {
  if (!geo) {
    r.say(`${label}：浮层可打开`, false, `未找到 ${popoverSel}`);
    return;
  }
  // 先证明页面还活着：观察器死循环会让后面每条断言都以超时告终，看不出真因
  const alive = await rendererResponsive();
  r.say(`${label}：打开浮层后页面仍可响应（无观察器死循环）`, alive, alive ? '' : '3s 内无响应');
  if (!alive) return;
  r.say(`${label}：浮层内存在收起按钮`, geo.button !== null,
    geo.button ? `key=${geo.buttonKey} text=${geo.buttonText} aria=${geo.buttonAria}` : '未注入');
  if (!geo.button) return;
  r.say(`${label}：按钮完整落在浮层可见区内`, inside(geo.popover, geo.button),
    `popover=${Math.round(geo.popover.left)},${Math.round(geo.popover.top)} ${Math.round(geo.popover.width)}x${Math.round(geo.popover.height)} button=${Math.round(geo.button.left)},${Math.round(geo.button.top)} ${Math.round(geo.button.width)}x${Math.round(geo.button.height)} max-height=${geo.maxHeight} padding-top=${geo.paddingTop}`);
  r.say(`${label}：按钮命中测试可达（未被遮挡）`, geo.hitIsButton,
    `viewport=${geo.viewport.w}x${geo.viewport.h} hit=${geo.hitTag}`);
  await page.screenshot({ path: `${OUT}/${shotName}.png` });
  const closed = await clickCloseButton(popoverSel, geo);
  r.say(`${label}：真实点击按钮后浮层关闭`, closed, closed ? '' : '浮层仍存在');
  if (closed) {
    r.say(`${label}：关闭后按钮随浮层一起移除`,
      !(await page.evaluate((sel) => !!document.querySelector(sel), CLOSE_BTN)), '');
  }
}

// ---------------- A. 任意会话：团队浮层 ----------------
await openGui(page, AUTH, { width: 360, height: 803 });
await sleep(2500);
await dismissHostNotices(page);
await sleep(600);

const titles = await openDrawerWithRows();
const firstReal = titles.find((t) => !/^New Session/i.test(t)) ?? titles[0];
const sessionTitle = firstReal ? await openSessionByTitle(firstReal) : null;
if (!sessionTitle) {
  r.say('A 会话可打开（宿主有可点的会话行）', false, `抽屉会话行：${titles.length ? titles.join(' / ') : '（空）'}`);
} else {
  console.log(`[suite] A 使用会话：${sessionTitle}`);
  await assertCloseAffordance('A 团队浮层 360x803', TEAM_PANEL, await openPopover(TEAM_PANEL, TEAM_TRIGGER), '01-team-360x803');

  // A2. 语言切换后已注入按钮的文案要跟上。宿主把 active 语言同步到 <html lang>
  //     （LocaleFace.syncDocumentLanguage），而按钮是本插件注入的、宿主重渲染不会更新它。
  //     这里**只改 lang、不制造任何其它 DOM 变更**：刷新必须是事件驱动的（观察器单独盯
  //     documentElement 的 lang），不能靠"恰好还有别的 class 变更"顺带触发。
  await openPopover(TEAM_PANEL, TEAM_TRIGGER);
  const zhProbe = await page.evaluate(async (panelSel, btnSel) => {
    const panel = document.querySelector(panelSel);
    if (!panel) return { opened: false };
    const read = () => {
      const btn = document.querySelector(panelSel)?.querySelector(btnSel);
      return btn ? { text: (btn.textContent || '').trim(), aria: btn.getAttribute('aria-label') } : null;
    };
    const before = read();
    const prevLang = document.documentElement.getAttribute('lang');
    document.documentElement.setAttribute('lang', 'zh-CN');
    await new Promise((res) => setTimeout(res, 500));
    const after = read();
    if (prevLang !== null) document.documentElement.setAttribute('lang', prevLang);
    return { opened: true, before, after };
  }, TEAM_PANEL, CLOSE_BTN);
  r.say('A2 语言切换后已注入按钮的文案跟随更新（收起）',
    zhProbe.opened === true && zhProbe.after?.text === '收起' && zhProbe.after?.aria === '收起',
    JSON.stringify(zhProbe));
  await dismissPopover(TEAM_PANEL);
}

// ---------------- B/C. 扫描会话：找"大团队浮层"与"有子智能体的会话" ----------------
await openDrawerWithRows();
await expandProjects(3);
const allTitles = await listSessionTitles();
let tall = null;
let subagentSession = null;
let tried = 0;
for (const title of allTitles) {
  if (tried >= SCAN_LIMIT || (tall && subagentSession)) break;
  const opened = await openSessionByTitle(title);
  tried += 1;
  if (!opened) continue;
  if (!subagentSession && await page.evaluate((sel) => !!document.querySelector(sel), SUBAGENT_TRIGGER)) {
    subagentSession = opened;
  }
  if (!tall) {
    const geo = await openPopover(TEAM_PANEL, TEAM_TRIGGER);
    if (geo && geo.popover.height >= TALL_PANEL_MIN) tall = { geo, title: opened };
  }
}
if (tall) {
  console.log(`[suite] B 使用大团队会话：${tall.title}（共享任务 ${tall.geo.rows} 条 / 浮层高 ${Math.round(tall.geo.popover.height)}px）`);
  await assertCloseAffordance('B 大团队浮层 360x803', TEAM_PANEL, tall.geo, '02-tall-team-360x803');
} else {
  console.log(`[suite] B 跳过：扫描 ${tried} 条会话，没有高度 ≥ ${TALL_PANEL_MIN}px 的团队浮层`);
  r.say('B 大团队浮层上的收起能力', true, `SKIP：扫描 ${tried} 条会话未找到高度 ≥ ${TALL_PANEL_MIN}px 的团队浮层（本机无大团队会话，属预期跳过）`);
}

if (subagentSession) {
  console.log(`[suite] C 使用子智能体会话：${subagentSession}`);
  const geo = await openPopover(SUBAGENT_MENU, SUBAGENT_TRIGGER);
  await assertCloseAffordance('C 子智能体下拉 360x803', SUBAGENT_MENU, geo, '03-subagent-360x803');
} else {
  console.log(`[suite] C 跳过：扫描 ${tried} 条会话都没有子智能体触发器`);
  r.say('C 子智能体下拉上的收起能力', true, `SKIP：扫描 ${tried} 条会话未找到 [aria-haspopup="tree"] 触发器（本机无子智能体会话，属预期跳过）`);
}

// ---------------- D. 393x852 复核 + 矮视口上限 + 桌面不注入 ----------------
await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
await sleep(800);
await assertCloseAffordance('D 团队浮层 393x852', TEAM_PANEL, await openPopover(TEAM_PANEL, TEAM_TRIGGER), '04-team-393x852');

// 矮视口（横屏手机 / 小屏）：新增的 max-height 上限必须生效，按钮仍要在可见区内
await page.setViewport({ width: 360, height: 560, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
await sleep(800);
const shortTeam = await openPopover(TEAM_PANEL, TEAM_TRIGGER);
if (shortTeam) {
  r.say('E 矮视口 360x560：团队浮层高度不超过视口减 96px 安全边',
    shortTeam.popover.height <= shortTeam.viewport.h - 96 + 1,
    `浮层高 ${Math.round(shortTeam.popover.height)}px / 视口 ${shortTeam.viewport.h}px（上限 ${shortTeam.viewport.h - 96}px）`);
}
await assertCloseAffordance('E 团队浮层 矮视口 360x560', TEAM_PANEL, shortTeam, '05-team-360x560');

if (subagentSession) {
  const shortMenu = await openPopover(SUBAGENT_MENU, SUBAGENT_TRIGGER);
  if (shortMenu) {
    r.say('E 矮视口 360x560：子智能体下拉高度不超过视口减 140px 安全边',
      shortMenu.popover.height <= shortMenu.viewport.h - 140 + 1,
      `下拉高 ${Math.round(shortMenu.popover.height)}px / 视口 ${shortMenu.viewport.h}px（上限 ${shortMenu.viewport.h - 140}px）`);
  }
  await assertCloseAffordance('E 子智能体下拉 矮视口 360x560', SUBAGENT_MENU, shortMenu, '06-subagent-360x560');
}

await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
await sleep(1200);
// ⚠️ 这里同时改了宽度与 isMobile：**触发整页重载的是 isMobile 的切换（CDP 仿真）**，不是
// 767px 断点本身（独立验收实测：只改宽度不动 isMobile 时不会重载）。重载后可能回到空白
// 会话 —— 先确保当前会话仍有会话头部（团队触发器），否则下面的"桌面不注入"断言会因为
// "浮层打不开"而误报。"撤残留"分支由 H 段在无重载的 DOM 上单独覆盖。
if (!(await page.evaluate((sel) => !!document.querySelector(sel), TEAM_TRIGGER))) {
  const desktopTitles = await openDrawerWithRows();
  const again = desktopTitles.find((t) => !/^New Session/i.test(t));
  if (again) await openSessionByTitle(again);
  await sleep(600);
}
const desktopTeam = await openPopover(TEAM_PANEL, TEAM_TRIGGER);
if (desktopTeam) {
  r.say('F 桌面宽度（1024px）团队浮层不注入收起按钮', desktopTeam.button === null,
    desktopTeam.button ? 'PC 端出现了移动端按钮' : `popover=${Math.round(desktopTeam.popover.width)}x${Math.round(desktopTeam.popover.height)}`);
  await dismissPopover(TEAM_PANEL);
  await page.screenshot({ path: `${OUT}/07-desktop.png` });
} else {
  r.say('F 桌面宽度下团队浮层可打开', false, `未找到 ${TEAM_PANEL}`);
}
if (subagentSession) {
  // 桌面阶段要先切回"有子智能体"的那条会话（跨断点重载与上面的重开都会换会话）
  await openSessionByTitle(subagentSession);
  await sleep(600);
  const desktopMenu = await openPopover(SUBAGENT_MENU, SUBAGENT_TRIGGER);
  r.say('F 桌面宽度（1024px）子智能体下拉不注入收起按钮', desktopMenu !== null && desktopMenu.button === null,
    desktopMenu ? (desktopMenu.button ? 'PC 端出现了移动端按钮' : '未注入') : `未找到 ${SUBAGENT_MENU}`);
  await dismissPopover(SUBAGENT_MENU);
}

// ---------------- G. 注入不得破坏宿主浮层本身的主行为（放最后：点行会切换会话） ----------------
if (subagentSession) {
  await page.setViewport({ width: 360, height: 803, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await sleep(800);
  await openSessionByTitle(subagentSession);
  const rowProbe = await page.evaluate(async (menuSel) => {
    document.querySelector('[aria-haspopup="tree"]')?.click();
    await new Promise((res) => setTimeout(res, 800));
    const menu = document.querySelector(menuSel);
    if (!menu) return { opened: false };
    const row = menu.querySelector('[role="treeitem"]');
    if (!row) return { opened: true, row: false };
    const rect = row.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 10, rect.top + rect.height / 2);
    const reachable = row === hit || row.contains(hit);
    row.click();
    return { opened: true, row: true, reachable, hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 30)}` : null };
  }, SUBAGENT_MENU);
  await sleep(900);
  const menuClosedByRow = !(await page.evaluate((sel) => !!document.querySelector(sel), SUBAGENT_MENU));
  r.say('G 子智能体下拉：子智能体行仍可命中、点击后正常收起（注入未破坏主行为）',
    rowProbe.opened === true && rowProbe.row === true && rowProbe.reachable === true && menuClosedByRow,
    `row=${JSON.stringify(rowProbe)} menuClosed=${menuClosedByRow}`);
  await page.screenshot({ path: `${OUT}/11-after-row-click.png` });
}

// ---------------- H. 桌面分支的"撤残留"路径（保持 isMobile 不变，避免 CDP 整页重载） ----------------
await page.setViewport({ width: 360, height: 803, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
await sleep(800);
await openSessionByTitle(tall?.title ?? subagentSession ?? firstReal);
const hBefore = await openPopover(TEAM_PANEL, TEAM_TRIGGER);
await page.setViewport({ width: 1024, height: 803, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
await sleep(900);
const hResidue = await page.evaluate((panelSel, btnSel) => ({
  panelAlive: !!document.querySelector(panelSel),
  buttons: document.querySelectorAll(btnSel).length,
  hostClasses: document.querySelectorAll('.dsh-bridge-team-panel, .dsh-bridge-subagent-menu').length,
  innerWidth,
}), TEAM_PANEL, CLOSE_BTN);
r.say('H 跨到桌面宽度（同一 isMobile、无整页重载）：注入按钮与让位类被撤掉',
  // panelAlive 必须纳入断言：若将来宿主改成 resize 即关浮层，光看"按钮数为 0"会空转通过
  hBefore?.button != null && hResidue.panelAlive === true && hResidue.buttons === 0 && hResidue.hostClasses === 0,
  `before=${hBefore?.button ? '已注入' : '未注入'} after=${JSON.stringify(hResidue)}`);
await page.screenshot({ path: `${OUT}/12-desktop-cleanup.png` });

await browser.close();
const pass = r.rows.filter((x) => x.ok).length;
const fail = r.rows.filter((x) => !x.ok).length;
const skip = r.rows.filter((x) => x.ok && String(x.detail).startsWith('SKIP')).length;
suiteResult({ label: '移动端宿主浮层收起按钮', pass, fail, skip });
