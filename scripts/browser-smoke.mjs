import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const browserPath = process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const appUrl = process.env.APP_URL || 'http://127.0.0.1:8083';
const debugPort = Number(process.env.BROWSER_DEBUG_PORT || 9323);
const runtime = path.join(root, '.runtime', `browser-${process.pid}`); mkdirSync(runtime, { recursive: true });
const output = path.join(root, 'docs', 'images'); mkdirSync(output, { recursive: true });
const logFile = openSync(path.join(runtime, 'edge.log'), 'a');
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(runtime, 'profile')}`, 'about:blank'], { stdio: ['ignore', logFile, logFile], windowsHide: true });
let launchError; browser.on('error', error => { launchError = error; });
let socket; let sequence = 0; const pending = new Map(); const exceptions = []; const checks = [];
function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 12000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: e => { clearTimeout(timer); reject(e); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(session, expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.result?.description);
  return result.result.value;
}
async function until(session, expression, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(session, expression)) return; await delay(100); }
  throw new Error(`Browser check timed out: ${description}`);
}
const click = (session, selector) => evaluate(session, `document.querySelector(${JSON.stringify(selector)}).click()`);
async function page() {
  const { browserContextId } = await command('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await command('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  await command('Runtime.enable', {}, sessionId); await command('Page.enable', {}, sessionId); await command('Network.enable', {}, sessionId);
  await command('Network.setBlockedURLs', { urls: ['*tile.openstreetmap.org*'] }, sessionId);
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await command('Page.navigate', { url: appUrl }, sessionId);
  await until(sessionId, `!!document.querySelector('[data-account-id="rider-1"]')`, 'login page');
  return sessionId;
}
async function screenshot(session, filename) {
  await evaluate(session, 'window.scrollTo(0,0)');
  const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, session);
  writeFileSync(path.join(output, filename), Buffer.from(data, 'base64'));
}
try {
  let version;
  for (let i = 0; i < 80; i++) {
    if (launchError) throw launchError;
    try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(500) })).json(); break; } catch { await delay(100); }
  }
  if (!version) throw new Error('Headless browser did not start; inspect .runtime/browser-*/edge.log');
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  });
  const rider = await page(); const driver = await page();
  await screenshot(rider, 'login.png');
  await click(driver, '#driverRoleTab'); await click(driver, '[data-account-id="driver-1"]');
  await until(driver, `!!document.querySelector('#onlineSwitch') && !document.querySelector('#onlineSwitch').disabled`, 'driver profile');
  if (!await evaluate(driver, `document.querySelector('#onlineSwitch').getAttribute('aria-checked')==='true'`)) await click(driver, '#onlineSwitch');
  await until(driver, `document.querySelector('#onlineSwitch').getAttribute('aria-checked')==='true'`, 'online acknowledgement');
  await click(rider, '[data-account-id="rider-1"]');
  await until(rider, `document.querySelector('#destinationSelect').options.length>=2`, 'places');
  await evaluate(rider, `document.querySelector('#destinationSelect').value='bund';document.querySelector('#destinationSelect').dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(rider, `!document.querySelector('#requestRide').disabled`, 'backend estimate');
  await screenshot(rider, 'rider-booking.png');
  assert.equal(await evaluate(rider, `document.querySelector('#tileWarning').hidden`), false);
  assert.ok((await evaluate(rider, `document.querySelector('#coordinateRow').textContent`)).includes('31.29890'));
  checks.push('无底图时地图标记、坐标和叫车操作可用');
  await click(rider, '#requestRide');
  await until(driver, `!!document.querySelector('[data-action="accept"]:not(:disabled)')`, 'real dispatch offer');
  await click(driver, '[data-action="accept"]');
  await until(driver, `!!document.querySelector('[data-action="arrive"]:not(:disabled)')`, 'acceptance confirmation');
  await screenshot(driver, 'driver-accepted.png'); checks.push('双独立浏览器会话：乘客叫车、司机接单');
  await click(driver, '[data-action="arrive"]');
  await until(driver, `!!document.querySelector('[data-action="start"]:not(:disabled)')`, 'arrival');
  await click(driver, '[data-action="start"]');
  await until(driver, `!!document.querySelector('[data-action="finish"]:not(:disabled)')`, 'boarding');
  await until(rider, `document.querySelector('#riderCurrent').textContent.includes('安心行程中')`, 'rider sees started ride');
  assert.equal(await evaluate(rider, `!!document.querySelector('[data-action="cancel"]')`), false);
  checks.push('乘客同步看到行程中；开始后无普通取消操作');
  await evaluate(driver, `document.querySelector('#finishDistance').value='9';document.querySelector('#finishDistance').dispatchEvent(new Event('input',{bubbles:true}))`);
  await click(driver, '[data-action="finish"]');
  await until(driver, `document.querySelector('#driverCurrent').textContent.includes('行程已完成')`, 'completed driver');
  await until(rider, `document.querySelector('#riderCurrent').textContent.includes('行程已完成')`, 'completed rider');
  assert.ok((await evaluate(rider, `document.querySelector('#riderCurrent').textContent`)).includes('27.00'));
  await screenshot(rider, 'rider-completed.png'); checks.push('前端完整流程结束，后端计费9公里=27元');
  await command('Page.reload', {}, rider);
  await until(rider, `!document.querySelector('#riderPanel').hidden && document.querySelector('#historyList').textContent.includes('已完成')`, 'refresh restores session and persistent history');
  checks.push('页面刷新保留身份并从持久化历史恢复已完成订单');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, rider);
  await screenshot(rider, 'mobile.png');
  const overflow = await evaluate(rider, 'document.documentElement.scrollWidth>window.innerWidth+1'); assert.equal(overflow, false);
  checks.push('390px移动端无页面横向溢出');
  await click(driver, '[data-action="dismiss-order"]');
  if (await evaluate(driver, `document.querySelector('#onlineSwitch').getAttribute('aria-checked')==='true'`)) await click(driver, '#onlineSwitch');
  await until(driver, `document.querySelector('#onlineSwitch').getAttribute('aria-checked')==='false'`, 'driver offline');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  checks.push('无未捕获JavaScript异常');
  console.log(`Browser PASS: ${checks.length} checks; screenshots saved in docs/images.`);
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally {
  writeFileSync(path.join(root, 'docs', 'evidence', 'browser.json'), JSON.stringify({ executed_at: new Date().toISOString(), browser: browserPath, url: appUrl, blocked_map_tiles: true, status: process.exitCode ? 'FAIL' : 'PASS', checks, exceptions }, null, 2));
  if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch {} socket.close(); }
  browser.kill();
}
