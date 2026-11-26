'use strict';

const $ = (selector) => document.querySelector(selector);
const SESSION_KEY = 'huxing.session.v1';
const CREATE_KEY = 'huxing.create.v1';
const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);
const CANCELLABLE = new Set(['MATCHING', 'ASSIGNING', 'ACCEPTED', 'ARRIVED']);
const STATUS = {
  MATCHING: ['正在寻找司机', '等待接单', '正在为你寻找可接单的司机，请稍候。'],
  ASSIGNING: ['正在确认接单', '确认中', '接单请求正在确认，请稍候。'],
  ACCEPTED: ['司机正在赶来', '已接单', '司机已接单，请前往上车点等候。'],
  ARRIVED: ['司机已到达', '等待上车', '司机已到达上车点，请核对车辆后上车。'],
  IN_PROGRESS: ['安心行程中', '行程中', '行程已开始，祝你一路顺利。'],
  COMPLETED: ['行程已完成', '已完成', '感谢这一路的信任，期待下次同行。'],
  CANCELLED: ['行程已取消', '已取消', '本次行程已取消，你可以重新选择出发。'],
  FAILED: ['暂未叫到车', '未匹配成功', '本次未能匹配到司机，请稍后重新叫车。'],
};
const state = {
  actor: null, token: '', accounts: [], loginRole: 'RIDER', places: [],
  originId: '', destinationId: '', estimate: null, estimateLoading: false, estimateError: '',
  current: null, currentDriver: null, currentPartial: false, syncPending: false,
  orders: new Map(), minVersions: new Map(), dismissed: new Set(),
  driver: null, driverGeneration: 0, offers: [], pendingAcceptance: null, assignmentEmptyChecks: 0,
  history: [], historyLoading: false, historyError: '', detail: null,
  busy: new Set(), finishDistances: new Map(), pendingCreate: null,
  loginError: '', placesError: '', connectionError: '', hasPolled: false,
};
let sessionGeneration = 0;
let routeGeneration = 0;
let pollInFlight = false;
let pollTimer = null;
let historyLastFetched = 0;
let map = null;
let mapLayers = null;
let mapSignature = '';
const renderCache = new WeakMap();

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function icon(name, className = '') {
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}
function put(element, html) {
  if (renderCache.get(element) === html) return;
  const focused = element.contains(document.activeElement) ? document.activeElement : null;
  const id = focused?.id;
  let selection;
  try { selection = [focused.selectionStart, focused.selectionEnd]; } catch { /* Number inputs do not have text selections. */ }
  element.innerHTML = html;
  renderCache.set(element, html);
  if (id) {
    const replacement = document.getElementById(id);
    if (replacement && !replacement.disabled) {
      replacement.focus({ preventScroll: true });
      if (selection?.[0] !== null) { try { replacement.setSelectionRange(...selection); } catch { /* Not a text input. */ } }
    }
  }
}
function timeMs(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return Date.parse(value || '');
}
function remaining(value) { return Math.max(0, Math.ceil((timeMs(value) - Date.now()) / 1000)) || 0; }
function hasNumber(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
function money(cents) { return hasNumber(cents) ? (Number(cents) / 100).toFixed(2) : '—'; }
function distance(meters) { return hasNumber(meters) ? `${(Number(meters) / 1000).toFixed(2)} 公里` : '—'; }
function duration(seconds) { return hasNumber(seconds) ? `${Math.max(1, Math.ceil(Number(seconds) / 60))} 分钟` : '—'; }
function dateTime(value, options = {}) {
  const ms = timeMs(value);
  if (!Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, ...options }).format(ms);
}
function isActive(order) { return order && !TERMINAL.has(order.status); }
function statusInfo(order) { return STATUS[order?.status] || ['行程状态待更新', '待更新', '请稍候，正在获取最新行程状态。']; }
function statusTag(order) {
  const className = order.status === 'FAILED' ? 'is-failed' : TERMINAL.has(order.status) ? 'is-ended' : ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'].includes(order.status) ? 'is-active' : '';
  return `<span class="status-tag ${className}">${escapeHTML(statusInfo(order)[1])}</span>`;
}
function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast is-${type}`;
  item.innerHTML = `${icon(type === 'success' ? 'check' : 'info')}<span>${escapeHTML(message)}</span>`;
  $('#toastRegion').append(item);
  setTimeout(() => item.remove(), type === 'error' ? 7000 : 4500);
}
function saveSession() {
  try {
    if (state.token) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: state.token, actor: state.actor }));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* The current tab can still run when browser storage is unavailable. */ }
}
function savePendingCreate() {
  try {
    if (state.pendingCreate) sessionStorage.setItem(CREATE_KEY, JSON.stringify({ ...state.pendingCreate, actorId: state.actor?.id }));
    else sessionStorage.removeItem(CREATE_KEY);
  } catch { /* Keep the same key in memory for safe retries. */ }
}
function uuid() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return Array.from(bytes, (b, i) => `${[4, 6, 8, 10].includes(i) ? '-' : ''}${b.toString(16).padStart(2, '0')}`).join('');
}

async function api(path, { method = 'GET', body, headers = {}, token = state.token, timeoutMs = 10_000 } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw Object.assign(new Error(cause.name === 'TimeoutError' ? '请求确认超时，正在尝试获取最新结果。' : '暂时无法连接，请检查网络或稍后重试。'), { status: 0, code: 'NETWORK_ERROR' });
  }
  let data;
  try { data = await response.json(); }
  catch { throw Object.assign(new Error('暂时无法读取服务结果，请稍后重试。'), { status: response.status, code: 'INVALID_RESPONSE' }); }
  if (!response.ok) {
    const error = Object.assign(new Error(data.error?.message || '操作暂未完成，请稍后重试。'), { status: response.status, code: data.error?.code, details: data.error?.details, requestId: data.request_id });
    if (response.status === 401 && token && token === state.token) logout('登录已失效，请重新选择账号。');
    throw error;
  }
  return { ...data, httpStatus: response.status };
}

function rememberOrder(order, authoritative = false) {
  if (!order?.id) return null;
  const previous = state.orders.get(order.id);
  const oldVersion = Number(previous?.version || 0);
  const version = Number(order.version || 0);
  const latest = !previous || version >= oldVersion ? { ...previous, ...order } : previous;
  state.orders.set(order.id, latest);
  if (authoritative) state.minVersions.set(order.id, Math.max(version, state.minVersions.get(order.id) || 0));
  return latest;
}
function applyMutation(order) {
  const latest = rememberOrder(order, true);
  if (!latest) return;
  const changedId = state.current?.id !== latest.id;
  state.current = latest;
  state.syncPending = true;
  state.currentPartial = false;
  if (changedId) state.currentDriver = null;
  state.pendingAcceptance = null;
  state.pendingCreate = null;
  savePendingCreate();
  if (TERMINAL.has(latest.status)) historyLastFetched = 0;
}
function applyQuery(result, requestedId = null) {
  const previousCurrent = state.current;
  if (!result.order) {
    if (result.sync_pending && state.current && (!requestedId || requestedId === state.current.id)) state.syncPending = true;
    return;
  }
  const order = rememberOrder(result.order);
  if (state.dismissed.has(order.id) && TERMINAL.has(order.status)) return;
  if (requestedId && requestedId !== order.id) return;
  // History and a lagging "current" lookup must never replace a newer local operation.
  if (state.current && state.current.id !== order.id && isActive(state.current)) return;
  if (state.actor?.role === 'DRIVER' && order.driver_id && order.driver_id !== state.actor.id) return;
  const changedId = state.current?.id !== order.id;
  state.current = order;
  if (changedId) state.currentDriver = null;
  const minimum = state.minVersions.get(order.id) || 0;
  state.syncPending = Boolean(result.sync_pending) || Number(result.order.version || 0) < minimum || Number(result.order.version || 0) < Number(order.version || 0);
  state.currentPartial = Boolean(result.partial);
  if (result.driver && (!order.driver_id || result.driver.id === order.driver_id)) state.currentDriver = result.driver;
  if (!order.driver_id) state.currentDriver = null;
  if (state.pendingAcceptance && order.driver_id === state.actor?.id) state.pendingAcceptance = null;
  if (state.pendingCreate) { state.pendingCreate = null; savePendingCreate(); }
  if (TERMINAL.has(order.status) && (previousCurrent?.id !== order.id || previousCurrent.status !== order.status || Number(previousCurrent.version || 0) < Number(order.version || 0))) historyLastFetched = 0;
}

function chosenRoute() {
  if (state.current && !state.dismissed.has(state.current.id) && (isActive(state.current) || state.actor?.role !== 'DRIVER' || !state.offers.length)) return { origin: state.current.origin, destination: state.current.destination };
  if (state.pendingAcceptance) return { origin: state.pendingAcceptance.origin, destination: state.pendingAcceptance.destination };
  if (state.actor?.role === 'DRIVER') {
    const offer = state.offers.find((item) => remaining(item.expires_at) > 0) || state.offers[0];
    if (offer) return { origin: offer.origin || offer.order?.origin, destination: offer.destination || offer.order?.destination };
    return { origin: null, destination: null };
  }
  return { origin: state.places.find((place) => place.id === state.originId), destination: state.places.find((place) => place.id === state.destinationId) };
}
function validPoint(point) { return point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)) && Math.abs(Number(point.lat)) <= 90 && Math.abs(Number(point.lng)) <= 180; }
function initMap() {
  try {
    if (!globalThis.L) throw new Error('Leaflet unavailable');
    map = L.map('journeyMap', { scrollWheelZoom: false, zoomControl: true, attributionControl: true }).setView([31.2304, 121.4737], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).on('tileerror', () => { $('#tileWarning').hidden = false; }).addTo(map);
    mapLayers = L.layerGroup().addTo(map);
  } catch {
    map = null;
    $('#journeyMap').hidden = true;
    $('#mapFallback').hidden = false;
    $('#tileWarning').hidden = false;
  }
}
function fitMap() {
  if (!map) return;
  const { origin, destination } = chosenRoute();
  const points = [origin, destination].filter(validPoint).map((p) => [Number(p.lat), Number(p.lng)]);
  map.invalidateSize({ animate: false });
  if (points.length > 1) map.fitBounds(points, { padding: [55, 55], maxZoom: 14, animate: false });
  else if (points.length) map.setView(points[0], 13, { animate: false });
}
function renderFallback(origin, destination) {
  const valid = validPoint(origin) && validPoint(destination);
  let journey = '<text x="300" y="200" text-anchor="middle" fill="#83947c" font-size="16">选择地点，查看行程坐标</text>';
  if (valid) {
    const minLat = Math.min(+origin.lat, +destination.lat), maxLat = Math.max(+origin.lat, +destination.lat);
    const minLng = Math.min(+origin.lng, +destination.lng), maxLng = Math.max(+origin.lng, +destination.lng);
    const latSpan = Math.max(maxLat - minLat, .012), lngSpan = Math.max(maxLng - minLng, .012);
    const point = (p) => [110 + ((+p.lng - minLng + (lngSpan - (maxLng - minLng)) / 2) / lngSpan) * 380, 290 - ((+p.lat - minLat + (latSpan - (maxLat - minLat)) / 2) / latSpan) * 180];
    const [x1, y1] = point(origin), [x2, y2] = point(destination);
    journey = `<path d="M${x1} ${y1} L${x2} ${y2}" fill="none" stroke="#2f8973" stroke-width="3" stroke-dasharray="7 7"/><circle cx="${x1}" cy="${y1}" r="9" fill="#146b5c" stroke="#fffefa" stroke-width="3"/><circle cx="${x2}" cy="${y2}" r="9" fill="#c49a44" stroke="#fffefa" stroke-width="3"/><text x="${x1}" y="${y1 - 20}" text-anchor="middle" fill="#315d4a" font-size="13">${escapeHTML(origin.name)}</text><text x="${x2}" y="${y2 + 29}" text-anchor="middle" fill="#947b43" font-size="13">${escapeHTML(destination.name)}</text>`;
  }
  put($('#mapFallback'), `<span class="fallback-note">坐标示意图 · 底图不可用</span><svg viewBox="0 0 600 380" role="img" aria-label="起终点坐标示意图"><defs><pattern id="coordinateGrid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#dce4d4" stroke-width="1"/></pattern></defs><rect width="600" height="380" fill="url(#coordinateGrid)"/>${journey}<text x="570" y="55" fill="#8f9d86" font-size="11" text-anchor="end">北 ↑</text></svg>`);
}
function renderMap() {
  const { origin, destination } = chosenRoute();
  const signature = JSON.stringify([origin, destination]);
  if (signature === mapSignature) return;
  mapSignature = signature;
  const hasRoute = validPoint(origin) && validPoint(destination);
  put($('#mapRouteSummary'), `${icon('pin')}<span>${hasRoute ? `${escapeHTML(origin.name)}<span class="summary-arrow">→</span>${escapeHTML(destination.name)}` : '选择起终点，查看行程位置'}</span>`);
  put($('#coordinateRow'), hasRoute
    ? `<span><strong>起点</strong> ${Number(origin.lat).toFixed(5)}, ${Number(origin.lng).toFixed(5)}</span><span><strong>终点</strong> ${Number(destination.lat).toFixed(5)}, ${Number(destination.lng).toFixed(5)}</span><span>WGS84</span>`
    : '<span>坐标采用 WGS84</span><span>暂无行程坐标</span>');
  $('#fitMap').disabled = !hasRoute;
  if (!map) { renderFallback(origin, destination); return; }
  mapLayers.clearLayers();
  if (hasRoute) {
    L.polyline([[+origin.lat, +origin.lng], [+destination.lat, +destination.lng]], { color: '#2f8973', weight: 3, opacity: .8, dashArray: '7 7' }).addTo(mapLayers);
    [[origin, '#146b5c', '起点'], [destination, '#c49a44', '终点']].forEach(([point, color, label]) => {
      const tooltip = document.createElement('span');
      tooltip.textContent = `${label} · ${point.name}`;
      L.circleMarker([+point.lat, +point.lng], { radius: 8, color: '#fffefa', weight: 3, fillColor: color, fillOpacity: 1 }).bindTooltip(tooltip, { permanent: true, direction: 'top', offset: [0, -10] }).addTo(mapLayers);
    });
    fitMap();
  }
}

function renderHeader() {
  const driver = state.actor?.role === 'DRIVER';
  $('#sessionButton').hidden = !state.actor;
  $('#navHistory').hidden = state.actor?.role !== 'RIDER';
  $('#navHome').textContent = driver ? '接单工作台' : '即时用车';
  $('#headerName').textContent = state.actor?.name || '';
  $('#headerAvatar').textContent = state.actor?.name?.slice(0, 1) || '';
  $('#sessionButton').setAttribute('aria-label', `${state.actor?.name || ''}，退出并切换账号`);
  $('#pageTitle').innerHTML = driver ? '每一份信任，都值得好好抵达<span>。</span>' : state.actor ? '下一程，想去哪里<span>？</span>' : '城市很大，每一程都在身边<span>。</span>';
  $('#pageSubtitle').textContent = driver ? `${state.actor.name}，你好。接单状态由你掌握，已承接的行程请安心完成。` : state.actor ? `${state.actor.name}，你好。选好起终点，开启今天的上海行程。` : '一份清晰的预估，一次安心的同行。让出发更从容。';
  const live = $('#liveState');
  live.className = `live-state${state.connectionError ? ' is-error' : state.hasPolled ? ' is-live' : ''}`;
  live.innerHTML = `<i></i>${state.connectionError ? '连接恢复中' : state.hasPolled ? '实时更新' : state.actor ? '正在连接' : '等待登录'}`;
}
function renderLogin() {
  $('#loginPanel').hidden = Boolean(state.actor);
  if (state.actor) return;
  const accounts = state.accounts.filter((account) => account.role === state.loginRole);
  for (const tab of document.querySelectorAll('[data-role]')) {
    const selected = tab.dataset.role === state.loginRole;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
  $('#accountList').setAttribute('aria-labelledby', state.loginRole === 'RIDER' ? 'riderRoleTab' : 'driverRoleTab');
  put($('#accountList'), accounts.length ? accounts.map((account) => `<button class="account-button" type="button" data-action="login" data-account-id="${escapeHTML(account.id)}" ${state.busy.has('login') ? 'disabled' : ''}><span class="avatar ${account.role === 'DRIVER' ? 'driver-avatar' : ''}">${escapeHTML(account.name.slice(0, 1))}</span><span class="account-copy"><strong>${escapeHTML(account.name)}</strong><small>${account.role === 'DRIVER' ? '司机账号' : '乘客账号'} · ${escapeHTML(account.id)}</small></span>${icon(state.busy.has('login') ? 'clock' : 'arrow')}</button>`).join('') : `<p class="loading-text">${state.loginError ? '暂时无法获取账号' : '正在获取可用账号…'}</p>`);
  $('#loginError').hidden = !state.loginError;
  $('#loginError').textContent = state.loginError;
  $('#retryAccounts').hidden = Boolean(state.accounts.length) || !state.loginError;
}
function fillPlaces() {
  const options = state.places.length ? state.places.map((place) => `<option value="${escapeHTML(place.id)}">${escapeHTML(place.name)}</option>`).join('') : '<option value="">暂无可用地点</option>';
  for (const id of ['#originSelect', '#destinationSelect']) put($(id), options);
  $('#originSelect').value = state.originId;
  $('#destinationSelect').value = state.destinationId;
}
function renderBooking() {
  $('#riderPanel').hidden = state.actor?.role !== 'RIDER';
  $('#bookingCard').hidden = Boolean(state.current && !state.dismissed.has(state.current.id));
  if (state.actor?.role !== 'RIDER') return;
  fillPlaces();
  const locked = state.busy.has('create') || Boolean(state.pendingCreate);
  $('#originSelect').disabled = locked || !state.places.length;
  $('#destinationSelect').disabled = locked || !state.places.length;
  $('#swapPlaces').disabled = locked || !state.places.length;
  const routeError = state.placesError || state.estimateError || (state.originId && state.originId === state.destinationId ? '起点和终点需要选择不同的地点。' : '');
  $('#routeError').textContent = routeError;
  $('#routeError').hidden = !routeError;
  const estimate = state.estimate;
  const expired = estimate && remaining(estimate.expires_at) <= 0;
  let estimateHtml;
  if (state.pendingCreate) estimateHtml = `<div class="estimate-empty">叫车结果正在确认中。再次确认将沿用同一次请求，避免重复叫车。</div>`;
  else if (state.estimateLoading) estimateHtml = '<div class="estimate-empty">正在为你计算预估费用…</div>';
  else if (estimate) estimateHtml = `<div class="estimate-title">预估车费<span class="tag">普通快车</span></div><div class="estimate-price"><span class="currency">¥</span>${money(estimate.amount_cents)}</div><div class="estimate-details"><span>${icon('distance')}${distance(estimate.distance_m)}</span><span>${icon('clock')}约 ${duration(estimate.duration_s)}</span><span class="${expired ? 'estimate-expired' : ''}" data-estimate-expiry>${expired ? '预估已过期' : `有效至 ${dateTime(estimate.expires_at, { month: undefined, day: undefined })}`}</span></div>`;
  else estimateHtml = `<div class="estimate-empty">${routeError ? '调整地点或重试，即可查看预估车费' : '选好起终点，即可查看预估车费'}</div>`;
  put($('#estimateBox'), estimateHtml);
  const canCreate = Boolean(state.pendingCreate || (estimate && !expired && !state.estimateLoading && !routeError));
  const request = $('#requestRide');
  request.disabled = !canCreate || state.busy.has('create');
  request.innerHTML = `${state.busy.has('create') ? '正在确认叫车…' : state.pendingCreate ? '再次确认叫车结果' : expired ? '预估已过期，请重新获取' : state.estimateLoading ? '正在获取预估…' : estimate ? '确认呼叫快车' : '请选择起终点'}${icon('arrow')}`;
  $('#refreshEstimate').hidden = Boolean(state.pendingCreate) || (!expired && !state.estimateError && !state.placesError);
  $('#refreshEstimate').disabled = state.estimateLoading || state.busy.has('create');
  $('#refreshEstimate').textContent = state.placesError ? '重新获取地点' : '重新获取预估';
}

function tripRoute(order) {
  return `<div class="trip-route"><div class="trip-stop"><i class="route-dot origin-dot"></i><div><small>上车点</small><strong>${escapeHTML(order.origin?.name || '地点信息待更新')}</strong></div></div><div class="trip-stop"><i class="route-dot destination-dot"></i><div><small>目的地</small><strong>${escapeHTML(order.destination?.name || '地点信息待更新')}</strong></div></div></div>`;
}
function timeline(order) {
  if (['CANCELLED', 'FAILED'].includes(order.status)) return '';
  const stage = { MATCHING: 0, ASSIGNING: 0, ACCEPTED: 1, ARRIVED: 2, IN_PROGRESS: 3, COMPLETED: 4 }[order.status] ?? 0;
  return `<ol class="timeline" aria-label="行程进度">${['叫车', '接单', '到达', '上车', '完成'].map((label, index) => `<li class="${index < stage ? 'is-done' : index === stage ? 'is-current' : ''}" ${index === stage ? 'aria-current="step"' : ''}><span class="timeline-dot">${index <= stage ? icon('check') : ''}</span><span>${label}</span></li>`).join('')}</ol>`;
}
function driverInfo(driver) {
  if (!driver) return '';
  const vehicle = driver.vehicle || {};
  return `<div class="driver-info"><span class="avatar">${escapeHTML(driver.name?.slice(0, 1) || '司')}</span><div class="driver-info-copy"><strong>${escapeHTML(driver.name || '司机')}</strong><small>${escapeHTML([vehicle.color, vehicle.model].filter(Boolean).join(' · '))}</small>${driver.phone_mask ? `<small>联系号码 ${escapeHTML(driver.phone_mask)}</small>` : ''}</div>${vehicle.plate ? `<span class="vehicle-plate">${escapeHTML(vehicle.plate)}</span>` : ''}</div>`;
}
function tripMetrics(order) {
  const finished = order.status === 'COMPLETED';
  const meters = finished ? order.final_distance_m : order.estimate?.distance_m;
  const cents = finished ? order.final_amount_cents : order.estimate?.amount_cents;
  return `<div class="trip-metrics"><div><small>${finished ? '实际行程里程' : '预估行程里程'}</small><strong>${meters == null ? '—' : (Number(meters) / 1000).toFixed(2)}<small>公里</small></strong></div><div><small>${finished ? '本次行程费用' : '预估车费'}</small><strong class="fare">¥ ${money(cents)}</strong></div></div>${finished ? `<p class="action-note">本次预估 ${distance(order.estimate?.distance_m)} · ¥ ${money(order.estimate?.amount_cents)}，本次费用已按实际里程结算。</p>` : ''}`;
}
function currentHtml(order, driverMode) {
  const info = statusInfo(order);
  const busy = state.busy.has(`order:${order.id}`);
  let description = info[2];
  if (driverMode) description = ({ ACCEPTED: '请前往乘客上车点，到达后确认。', ARRIVED: '请核对乘客，上车后再开始行程。', IN_PROGRESS: '请安全驾驶，抵达目的地后确认实际里程。', COMPLETED: '行程已结束，感谢你的认真服务。', CANCELLED: '乘客已取消本次行程，请停止接驾。' })[order.status] || description;
  if (order.status === 'FAILED' && /[\u4e00-\u9fff]/.test(order.failure_reason || '')) description = order.failure_reason;
  let actions = '';
  if (driverMode) {
    const action = { ACCEPTED: ['arrive', '已到达上车点'], ARRIVED: ['start', '乘客已上车，开始行程'], IN_PROGRESS: ['finish', '结束行程并计费'] }[order.status];
    if (action) {
      if (action[0] === 'finish') {
        const initial = state.finishDistances.get(order.id) ?? (order.estimate?.distance_m ? (Number(order.estimate.distance_m) / 1000).toFixed(3) : '');
        actions += `<div class="finish-field"><label for="finishDistance">本次实际里程</label><div class="finish-input-wrap"><input id="finishDistance" type="number" inputmode="decimal" min="0.001" step="0.001" value="${escapeHTML(initial)}" data-order-id="${escapeHTML(order.id)}" aria-describedby="finishDistanceHelp" ${busy ? 'disabled' : ''}><span>公里</span></div><p id="finishDistanceHelp">默认采用预估里程；可填写本次实际里程，费用由系统结算。</p></div>`;
      }
      actions += `<div class="order-actions"><button type="button" class="button button-primary button-full" data-action="${action[0]}" data-order-id="${escapeHTML(order.id)}" ${busy ? 'disabled' : ''}>${busy ? '正在确认…' : action[1]}${icon('arrow')}</button></div>`;
    }
    if (order.status === 'ASSIGNING' && order.offer_id) actions += `<div class="order-actions"><button type="button" class="button button-secondary button-full" data-action="accept" data-offer-id="${escapeHTML(order.offer_id)}" ${state.busy.has(`offer:${order.offer_id}`) ? 'disabled' : ''}>${state.busy.has(`offer:${order.offer_id}`) ? '正在确认…' : '重新确认接单结果'}</button></div><p class="action-note">接单结果确认后，才可继续到达、上车等操作。</p>`;
    if (TERMINAL.has(order.status)) actions += `<div class="order-actions"><button class="button button-secondary button-full" type="button" data-action="dismiss-order" data-order-id="${escapeHTML(order.id)}">返回接单工作台${icon('arrow')}</button></div>`;
  } else if (CANCELLABLE.has(order.status)) {
    actions = `<div class="order-actions"><button type="button" class="button button-danger button-full" data-action="cancel" data-order-id="${escapeHTML(order.id)}" ${busy ? 'disabled' : ''}>${busy ? '正在取消…' : '取消本次行程'}</button></div><p class="cancel-note">上车前可取消，行程开始后无法普通取消。</p>`;
  } else if (TERMINAL.has(order.status)) {
    actions = `<div class="order-actions"><button class="button button-primary button-full" type="button" data-action="dismiss-order" data-order-id="${escapeHTML(order.id)}">再叫一辆，继续出发${icon('arrow')}</button></div>`;
  } else if (order.status === 'IN_PROGRESS') {
    actions = '<p class="action-note">行程已开始，到达目的地后由司机确认结束。</p>';
  }
  const profile = driverMode ? '' : driverInfo(state.currentDriver);
  const profilePending = !driverMode && order.driver_id && !state.currentDriver;
  return `<div class="section-kicker">${TERMINAL.has(order.status) ? '本次行程' : driverMode ? '正在服务的行程' : '我的当前行程'}</div><div class="status-heading"><h2>${escapeHTML(info[0])}</h2>${statusTag(order)}</div><p class="status-description">${escapeHTML(description)}</p>${state.syncPending ? `<div class="sync-note">${icon('refresh')}<span>已保存，正在同步</span></div>` : ''}${tripRoute(order)}${timeline(order)}${profile}${profilePending ? '<p class="partial-note">司机已确认，详细资料正在更新。</p>' : ''}${state.currentPartial ? '<p class="partial-note">部分司机资料暂时不可用，行程进度与操作仍可继续。</p>' : ''}${tripMetrics(order)}${actions}<div class="order-reference">行程编号 ${escapeHTML(order.id)}<br>发起于 ${dateTime(order.created_at)}</div>`;
}
function renderCurrent() {
  const visible = state.current && !state.dismissed.has(state.current.id);
  const rider = $('#riderCurrent'), driver = $('#driverCurrent');
  rider.hidden = !visible || state.actor?.role !== 'RIDER';
  driver.hidden = !visible || state.actor?.role !== 'DRIVER';
  if (!visible) return;
  put(state.actor?.role === 'DRIVER' ? driver : rider, currentHtml(state.current, state.actor?.role === 'DRIVER'));
}
function renderDriver() {
  $('#driverPanel').hidden = state.actor?.role !== 'DRIVER';
  if (state.actor?.role !== 'DRIVER') return;
  const driver = state.driver;
  const busy = state.busy.has('online');
  const vehicle = driver?.vehicle || {};
  put($('#driverProfile'), `<div class="section-kicker">我的接单工作台</div><div class="driver-identity"><span class="avatar">${escapeHTML(state.actor.name.slice(0, 1))}</span><div><h2>${escapeHTML(driver?.name || state.actor.name)}</h2><p>${driver ? escapeHTML([vehicle.plate, vehicle.color, vehicle.model].filter(Boolean).join(' · ')) : '正在获取车辆信息…'}</p></div></div><div class="online-control"><div><strong>${!driver ? '正在获取接单状态…' : busy ? '正在切换接单状态…' : driver.online ? '已开启接单' : '已关闭接单'}</strong><small>${!driver ? '请稍候，正在读取你的接单状态' : driver.online ? isActive(state.current) ? '当前行程完成后，可继续接单' : '在线等待，随时准备出发' : '关闭接单后，不再接收新派单'}</small></div><button type="button" class="switch" role="switch" id="onlineSwitch" aria-label="开启或关闭接单" aria-checked="${Boolean(driver?.online)}" data-action="toggle-online" ${!driver || busy ? 'disabled' : ''}></button></div><p class="driver-control-note">接单开关独立于当前行程。关闭接单后，仍可完成已承接的行程。</p>`);
  const offers = state.offers.filter((offer) => offer.status === 'CLAIMED' || remaining(offer.expires_at) > 0);
  if (isActive(state.current)) {
    put($('#offersPanel'), '');
    return;
  }
  if (state.pendingAcceptance) {
    const pending = state.pendingAcceptance;
    put($('#offersPanel'), `<section class="card pending-card"><div class="section-kicker">接单结果确认中</div><h3>请求已受理，正在确认结果</h3><p>系统会继续核对本次接单结果，确认后即可操作行程。</p>${tripRoute(pending)}<button type="button" class="button button-secondary button-full" data-action="accept" data-offer-id="${escapeHTML(pending.id)}" ${state.busy.has(`offer:${pending.id}`) ? 'disabled' : ''}>${state.busy.has(`offer:${pending.id}`) ? '正在确认…' : '重新确认接单结果'}</button></section>`);
    return;
  }
  if (!offers.length) {
    put($('#offersPanel'), `<section class="card waiting-card"><span class="waiting-icon">${icon('car')}</span><h3>${!driver ? '正在获取接单状态' : driver.online ? '等待下一份同行' : '准备好了，就开启接单'}</h3><p>${!driver ? '请稍候，车辆与派单信息正在更新。' : driver.online ? '有新的派单时会显示在这里。<br>请留意派单的有效时间。' : '开启接单后，可接收乘客的出行请求。'}</p></section>`);
    return;
  }
  put($('#offersPanel'), `<div class="offers-heading"><h3>待处理派单</h3><span class="count-badge">${offers.length}</span></div>${offers.map((offer) => {
    const order = { ...offer.order, origin: offer.origin || offer.order?.origin, destination: offer.destination || offer.order?.destination };
    const claimed = offer.status === 'CLAIMED';
    const busyOffer = state.busy.has(`offer:${offer.id}`);
    const disabled = busyOffer || (!claimed && remaining(offer.expires_at) <= 0);
    return `<section class="card offer-card"><div class="offer-heading"><strong>${claimed ? '接单结果待确认' : '有一份新的出行邀请'}</strong><span class="offer-countdown" data-expires="${escapeHTML(offer.expires_at)}">${claimed ? '确认中' : `${remaining(offer.expires_at)} 秒内响应`}</span></div>${tripRoute(order)}${order.estimate ? `<p class="offer-expiry-note">预估 ${distance(order.estimate.distance_m)} · ¥ ${money(order.estimate.amount_cents)}</p>` : ''}<div class="offer-actions">${claimed ? '' : `<button type="button" class="button button-secondary button-small" data-action="reject" data-offer-id="${escapeHTML(offer.id)}" data-offer-expiry="${escapeHTML(offer.expires_at)}" ${disabled ? 'disabled' : ''}>暂不接单</button>`}<button type="button" class="button button-primary button-small" data-action="accept" data-offer-id="${escapeHTML(offer.id)}" ${!claimed ? `data-offer-expiry="${escapeHTML(offer.expires_at)}"` : ''} ${disabled || (!claimed && !driver?.online) ? 'disabled' : ''}>${busyOffer ? '正在确认…' : claimed ? '确认接单结果' : '接受派单'}</button></div><p class="offer-expiry-note">${claimed ? '接单请求已收到，确认结果后才会开始行程。' : !driver?.online ? '接单已关闭，请先开启接单后再接受派单。' : '请在有效时间内响应，过期后将继续寻找其他司机。'}</p></section>`;
  }).join('')}`);
}
function historyRow(order) {
  const completed = order.status === 'COMPLETED';
  const ended = TERMINAL.has(order.status);
  return `<button class="history-row" type="button" data-action="history-detail" data-order-id="${escapeHTML(order.id)}" aria-label="查看${escapeHTML(order.origin?.name)}至${escapeHTML(order.destination?.name)}的行程详情"><span class="history-date"><strong>${dateTime(order.created_at, { hour: undefined, minute: undefined })}</strong><small>${dateTime(order.created_at, { month: undefined, day: undefined })}</small></span><span class="history-route"><span><i class="route-dot origin-dot"></i>${escapeHTML(order.origin?.name || '起点待更新')}</span><span><i class="route-dot destination-dot"></i>${escapeHTML(order.destination?.name || '终点待更新')}</span></span>${statusTag(order)}<span class="history-fare">${completed ? `¥ ${money(order.final_amount_cents)}` : ended ? '—' : `¥ ${money(order.estimate?.amount_cents)}`}<small>${completed ? '实际费用' : ended ? '行程未完成' : '预估费用'}</small></span>${icon('chevron')}</button>`;
}
function renderHistory() {
  $('#historySection').hidden = state.actor?.role !== 'RIDER';
  if (state.actor?.role !== 'RIDER') return;
  $('#historyCount').textContent = state.history.length;
  $('#refreshHistory').disabled = state.historyLoading;
  let html;
  if (state.history.length) html = state.history.map(historyRow).join('');
  else if (state.historyLoading) html = '<p class="empty-state">正在获取行程记录…</p>';
  else if (state.historyError) html = `<div class="history-error">${icon('info')}<span>${escapeHTML(state.historyError)}</span></div>`;
  else html = '<p class="empty-state">还没有行程记录。下一程，从这里开始。</p>';
  if (state.history.length && state.historyError) html += '<p class="partial-note">暂时无法刷新记录，已保留上次结果。请稍后重试。</p>';
  put($('#historyList'), html);
}
function renderDetail() {
  if (!state.detail) return;
  const { order, driver, loading, error, syncPending, partial } = state.detail;
  if (!order) { put($('#historyDetail'), `<p class="empty-state">${escapeHTML(error || '正在获取行程详情…')}</p>`); return; }
  put($('#historyDetail'), `<div class="status-heading"><h3>${escapeHTML(statusInfo(order)[0])}</h3>${statusTag(order)}</div>${syncPending ? `<div class="sync-note">${icon('refresh')}<span>已保存，正在同步</span></div>` : ''}${tripRoute(order)}${timeline(order)}${driverInfo(driver)}${tripMetrics(order)}${partial ? '<p class="partial-note">部分司机资料暂时不可用，请稍后刷新查看。</p>' : ''}${loading ? '<p class="partial-note">正在获取最新详情…</p>' : ''}${error ? `<p class="inline-error">${escapeHTML(error)}</p>` : ''}<div class="detail-meta"><div><small>发起时间</small><span>${dateTime(order.created_at)}</span></div><div><small>到达上车点</small><span>${dateTime(order.arrived_at)}</span></div><div><small>开始时间</small><span>${dateTime(order.started_at)}</span></div><div><small>结束时间</small><span>${dateTime(order.finished_at)}</span></div></div><div class="order-reference">行程编号 ${escapeHTML(order.id)}</div>`);
}
function renderNotice() {
  $('#connectionNotice').hidden = !state.connectionError;
  $('#connectionMessage').textContent = state.connectionError;
  $('#retryConnection').disabled = pollInFlight;
}
function renderAll() {
  renderHeader(); renderLogin(); renderBooking(); renderCurrent(); renderDriver(); renderHistory(); renderMap(); renderNotice();
}

async function loadAccounts() {
  try {
    const result = await api('/auth/accounts', { token: '' });
    state.accounts = (result.accounts || []).filter((account) => account.id && account.name && ['RIDER', 'DRIVER'].includes(account.role));
    state.loginError = state.accounts.length ? '' : '暂无可用账号，请稍后重试。';
  } catch (error) { state.loginError = error.message; }
  renderLogin();
}
async function loadPlaces() {
  try {
    const result = await api('/places', { token: '' });
    state.places = (result.places || []).filter(validPoint);
    if (!state.places.some((place) => place.id === state.originId)) state.originId = state.places[0]?.id || '';
    if (!state.places.some((place) => place.id === state.destinationId)) state.destinationId = state.places[1]?.id || '';
    state.placesError = state.places.length >= 2 ? '' : '可用地点不足，请稍后重试。';
  } catch (error) { state.placesError = error.message; }
  renderAll();
  if (state.actor?.role === 'RIDER' && !state.current && !state.pendingCreate) await requestEstimate();
}
function resetActorData() {
  state.estimate = null; state.estimateLoading = false; state.estimateError = '';
  state.current = null; state.currentDriver = null; state.currentPartial = false; state.syncPending = false;
  state.orders.clear(); state.minVersions.clear(); state.dismissed.clear(); state.finishDistances.clear();
  state.driver = null; state.driverGeneration++; state.offers = []; state.pendingAcceptance = null; state.assignmentEmptyChecks = 0;
  state.history = []; state.historyLoading = false; state.historyError = ''; state.detail = null;
  state.pendingCreate = null; state.connectionError = ''; state.hasPolled = false; state.busy.clear();
  historyLastFetched = 0;
  routeGeneration++;
  if ($('#historyDialog').open) $('#historyDialog').close();
}
function logout(message = '') {
  sessionGeneration++;
  clearTimeout(pollTimer);
  state.actor = null; state.token = '';
  resetActorData(); saveSession(); savePendingCreate();
  $('#navHome').classList.add('is-active'); $('#navHistory').classList.remove('is-active');
  renderAll();
  if (message) toast(message, 'info');
}
async function loginAccount(accountId) {
  if (state.busy.has('login')) return;
  state.busy.add('login'); state.loginError = ''; renderLogin();
  try {
    const result = await api('/auth/login', { method: 'POST', body: { account_id: accountId }, token: '' });
    if (!result.token || !result.actor || !['RIDER', 'DRIVER'].includes(result.actor.role)) throw new Error('登录信息不完整，请重新选择账号。');
    sessionGeneration++;
    resetActorData();
    state.actor = result.actor; state.token = result.token;
    saveSession(); savePendingCreate();
    renderAll();
    toast(`${result.actor.name}，欢迎来到沪行。`);
    schedulePoll(0);
    if (result.actor.role === 'RIDER' && state.places.length) void requestEstimate();
  } catch (error) { state.loginError = error.message; }
  finally { state.busy.delete('login'); renderAll(); }
}
async function perform(key, task) {
  if (state.busy.has(key)) return;
  const generation = sessionGeneration;
  state.busy.add(key); renderAll();
  try { await task(() => generation === sessionGeneration); }
  catch (error) { if (generation === sessionGeneration) toast(error.message, 'error'); }
  finally {
    if (generation === sessionGeneration) { state.busy.delete(key); renderAll(); schedulePoll(100); }
  }
}
async function requestEstimate() {
  if (state.actor?.role !== 'RIDER' || state.pendingCreate) return;
  const origin = state.originId, destination = state.destinationId;
  const generation = ++routeGeneration;
  const session = sessionGeneration;
  state.estimate = null; state.estimateError = '';
  if (!origin || !destination || origin === destination) { state.estimateLoading = false; renderBooking(); renderMap(); return; }
  state.estimateLoading = true; renderBooking(); renderMap();
  try {
    const result = await api('/orders/estimate', { method: 'POST', body: { origin_id: origin, destination_id: destination } });
    if (generation !== routeGeneration || session !== sessionGeneration) return;
    if (!result.estimate?.id) throw new Error('暂时无法获取完整预估，请重新尝试。');
    state.estimate = result.estimate;
  } catch (error) {
    if (generation === routeGeneration && session === sessionGeneration) state.estimateError = error.message;
  } finally {
    if (generation === routeGeneration && session === sessionGeneration) { state.estimateLoading = false; renderBooking(); }
  }
}
async function createRide() {
  if (isActive(state.current)) return;
  if (!state.pendingCreate && (!state.estimate || remaining(state.estimate.expires_at) <= 0)) {
    toast('预估已过期，请重新获取后再叫车。', 'info'); renderBooking(); return;
  }
  await perform('create', async (stillCurrent) => {
    if (!state.pendingCreate) {
      state.pendingCreate = { key: uuid(), estimateId: state.estimate.id };
      savePendingCreate();
    }
    const pending = state.pendingCreate;
    try {
      const result = await api('/orders', { method: 'POST', body: { estimate_id: pending.estimateId }, headers: { 'Idempotency-Key': pending.key } });
      if (!stillCurrent()) return;
      if (!result.order) throw Object.assign(new Error('叫车请求已受理，正在确认结果。请稍后再次确认。'), { status: 0 });
      applyMutation(result.order);
      toast('叫车已受理，正在为你寻找司机。');
    } catch (error) {
      if (stillCurrent() && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        state.pendingCreate = null; savePendingCreate();
        if (error.code === 'ESTIMATE_EXPIRED') { state.estimate = null; state.estimateError = error.message; }
      }
      throw error;
    }
  });
}
async function mutateOrder(action, orderId) {
  if (!state.current || state.current.id !== orderId) return;
  let body = {};
  if (action === 'finish') {
    const kilometers = Number($('#finishDistance')?.value);
    const meters = Math.round(kilometers * 1000);
    if (!Number.isSafeInteger(meters) || meters <= 0) { toast('请填写大于 0 的实际里程，最小为 0.001 公里。', 'error'); $('#finishDistance')?.focus(); return; }
    body = { distance_m: meters };
  }
  await perform(`order:${orderId}`, async (stillCurrent) => {
    const result = await api(`/orders/${encodeURIComponent(orderId)}/${action}`, { method: 'POST', body });
    if (!stillCurrent()) return;
    if (result.order) applyMutation(result.order);
    else state.syncPending = true;
    toast(({ cancel: '本次行程已取消，可以重新叫车。', arrive: '已确认到达上车点，请等候乘客。', start: '行程已开始，祝一路顺利。', finish: '行程已完成，费用已结算。' })[action]);
  });
}
async function toggleOnline() {
  if (!state.driver) return;
  const online = !state.driver.online;
  state.driverGeneration++;
  await perform('online', async (stillCurrent) => {
    const result = await api('/drivers/me/status', { method: 'PUT', body: { online } });
    if (!stillCurrent()) return;
    if (result.driver) state.driver = result.driver;
    state.driverGeneration++;
    toast(online ? '已开启接单，准备迎接下一程。' : isActive(state.current) ? '已关闭新派单，当前行程仍可继续完成。' : '已关闭接单，好好休息。');
  });
}
async function respondOffer(action, offerId) {
  const offer = state.offers.find((item) => item.id === offerId)
    || (state.pendingAcceptance?.id === offerId ? state.pendingAcceptance : null)
    || (state.current?.offer_id === offerId ? { id: offerId, order_id: state.current.id, origin: state.current.origin, destination: state.current.destination } : null);
  if (!offer) { toast('这份派单已更新，正在重新获取。', 'info'); schedulePoll(0); return; }
  const clearPending = () => {
    state.pendingAcceptance = null;
    state.offers = state.offers.filter((item) => item.id !== offerId);
    if (state.current?.id === offer.order_id && state.current.status === 'ASSIGNING') {
      state.current = null; state.currentDriver = null; state.syncPending = false; state.currentPartial = false;
    }
  };
  await perform(`offer:${offerId}`, async (stillCurrent) => {
    let result;
    try { result = await api(`/offers/${encodeURIComponent(offerId)}/${action}`, { method: 'POST', body: {} }); }
    catch (error) {
      if (stillCurrent() && action === 'accept' && [404, 409, 410].includes(error.status)
          && (state.pendingAcceptance?.id === offerId || (state.current?.status === 'ASSIGNING' && state.current.offer_id === offerId))) {
        clearPending();
      }
      throw error;
    }
    if (!stillCurrent()) return;
    if (action === 'accept') {
      if (result.order?.status === 'MATCHING') {
        rememberOrder(result.order, true);
        clearPending();
        const message = ({ DRIVER_BUSY: '你已有其他行程，本次派单未能接单。', DRIVER_OFFLINE: '接单已关闭，本次派单未能接单。', OFFER_EXPIRED: '派单已过期，未能确认接单。' })[result.order.last_assignment_failure] || '本次未能确认接单，请等待新的派单。';
        toast(message, 'info');
        return;
      }
      if (result.order) {
        applyMutation(result.order);
        const confirmed = ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'].includes(result.order.status) && result.order.driver_id === state.actor.id;
        toast(confirmed ? '接单已确认，请留意当前行程进度。' : '接单请求已受理，正在确认结果。', confirmed ? 'success' : 'info');
      } else {
        state.pendingAcceptance = { ...offer, origin: offer.origin || offer.order?.origin, destination: offer.destination || offer.order?.destination };
        toast('接单请求已受理，正在确认结果。', 'info');
      }
      state.offers = state.offers.filter((item) => item.id !== offerId);
    } else {
      state.offers = state.offers.filter((item) => item.id !== offerId);
      toast('已拒绝本次派单，继续等待下一程。');
    }
  });
}
function dismissOrder(orderId) {
  if (!state.current || state.current.id !== orderId || !TERMINAL.has(state.current.status)) return;
  state.dismissed.add(orderId); state.current = null; state.currentDriver = null; state.syncPending = false; state.currentPartial = false;
  renderAll();
  if (state.actor?.role === 'RIDER') { void requestEstimate(); $('#bookingTitle').scrollIntoView({ behavior: 'auto', block: 'center' }); }
  schedulePoll(0);
}
async function loadHistory({ manual = false } = {}) {
  if (state.actor?.role !== 'RIDER' || state.historyLoading) return;
  const generation = sessionGeneration;
  state.historyLoading = true; state.historyError = ''; renderHistory();
  try {
    const result = await api('/orders/history');
    if (generation !== sessionGeneration) return;
    state.history = (result.orders || []).map((order) => rememberOrder(order)).filter(Boolean);
    historyLastFetched = Date.now();
    if (manual) toast('行程记录已更新。');
  } catch (error) {
    if (generation === sessionGeneration) { state.historyError = error.message; historyLastFetched = Date.now(); if (manual) toast(error.message, 'error'); }
  } finally {
    if (generation === sessionGeneration) { state.historyLoading = false; renderHistory(); }
  }
}
async function loadDetail(orderId, { open = true } = {}) {
  const generation = sessionGeneration;
  const cached = state.orders.get(orderId) || state.history.find((item) => item.id === orderId);
  if (open) {
    state.detail = { order: cached, driver: state.current?.id === orderId ? state.currentDriver : null, loading: true, error: '', syncPending: false };
    if (!$('#historyDialog').open) $('#historyDialog').showModal();
    renderDetail();
  }
  try {
    const minimum = Math.max(state.minVersions.get(orderId) || 0, Number(cached?.version || 0), 1);
    const result = await api(`/orders/${encodeURIComponent(orderId)}?min_version=${minimum}`);
    if (generation !== sessionGeneration || !state.detail || state.detail.order?.id !== orderId || !$('#historyDialog').open) return;
    const order = result.order ? rememberOrder(result.order) : cached;
    state.detail = { order, driver: result.driver || state.detail.driver, loading: false, error: '', syncPending: Boolean(result.sync_pending) || !result.order || Number(result.order.version || 0) < Number(order?.version || 0), partial: Boolean(result.partial) };
  } catch (error) {
    if (generation === sessionGeneration && state.detail?.order?.id === orderId) { state.detail.loading = false; state.detail.error = error.message; }
  }
  renderDetail();
}

function schedulePoll(delay = 1200) {
  clearTimeout(pollTimer);
  if (state.actor) pollTimer = setTimeout(poll, delay);
}
async function poll() {
  if (!state.actor) return;
  if (pollInFlight) { schedulePoll(1200); return; }
  pollInFlight = true;
  const generation = sessionGeneration;
  const role = state.actor.role;
  const current = state.current;
  const detailId = current && (isActive(current) || state.syncPending) ? current.id : null;
  const minimum = detailId ? Math.max(state.minVersions.get(detailId) || 0, Number(current.version || 0), 1) : 0;
  let assignmentQueryDenied = false;
  let driverResult = null;
  let offersResult = null;
  const tasks = [api(detailId ? `/orders/${encodeURIComponent(detailId)}?min_version=${minimum}` : '/orders/current').then((result) => {
    if (generation === sessionGeneration) applyQuery(result, detailId);
  }).catch((error) => {
    // A projection from before this driver's pending assignment can legitimately deny access.
    if (error.status === 403 && role === 'DRIVER' && current?.status === 'ASSIGNING' && !current.driver_id) {
      if (generation === sessionGeneration) { state.syncPending = true; assignmentQueryDenied = true; }
      return;
    }
    throw error;
  })];
  if (role === 'DRIVER') {
    const driverGeneration = state.driverGeneration;
    tasks.push(api('/drivers/me').then((result) => {
      driverResult = result.driver;
      if (generation === sessionGeneration && driverGeneration === state.driverGeneration && !state.busy.has('online')) state.driver = result.driver;
    }));
    tasks.push(api('/drivers/me/offers').then((result) => {
      offersResult = result.offers || [];
      if (generation === sessionGeneration) state.offers = offersResult;
    }));
  }
  try {
    const results = await Promise.allSettled(tasks);
    if (generation !== sessionGeneration) return;
    const errors = results.filter((result) => result.status === 'rejected');
    const unboundAssignment = !errors.length && assignmentQueryDenied && driverResult && offersResult
      && state.current?.id === current?.id && state.current?.status === 'ASSIGNING'
      && driverResult.active_order_id !== current.id
      && !offersResult.some((offer) => offer.id === current.offer_id && ['PENDING', 'CLAIMED'].includes(offer.status));
    // Require two complete checks to avoid combining responses from opposite sides of a confirmation.
    state.assignmentEmptyChecks = unboundAssignment ? state.assignmentEmptyChecks + 1 : 0;
    if (state.assignmentEmptyChecks >= 2) {
      state.current = null; state.currentDriver = null; state.syncPending = false; state.currentPartial = false;
      state.pendingAcceptance = null; state.assignmentEmptyChecks = 0;
      toast('本次接单未能确认，请等待新的派单。', 'info');
    }
    state.connectionError = errors.length ? '暂时无法更新部分信息，已保留行程进度，稍后将自动重试。' : '';
    state.hasPolled = errors.length === 0;
    renderAll();
    if (role === 'RIDER' && Date.now() - historyLastFetched > 8000) await loadHistory();
    if (generation === sessionGeneration && $('#historyDialog').open && state.detail?.syncPending && state.detail.order?.id) await loadDetail(state.detail.order.id, { open: false });
  } finally {
    pollInFlight = false;
    renderNotice();
    schedulePoll(1200);
  }
}

function tick() {
  for (const node of document.querySelectorAll('[data-expires]')) {
    const seconds = remaining(node.dataset.expires);
    if (node.textContent !== '确认中') node.textContent = seconds > 0 ? `${seconds} 秒内响应` : '已过期，正在更新';
  }
  for (const button of document.querySelectorAll('[data-offer-expiry]')) {
    if (remaining(button.dataset.offerExpiry) <= 0) button.disabled = true;
  }
  if (state.estimate && !state.pendingCreate && remaining(state.estimate.expires_at) <= 0 && !$('#requestRide').disabled) renderBooking();
}
function bindEvents() {
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-role]');
    if (tab) { state.loginRole = tab.dataset.role; renderLogin(); return; }
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'login') void loginAccount(button.dataset.accountId);
    else if (['cancel', 'arrive', 'start', 'finish'].includes(action)) void mutateOrder(action, button.dataset.orderId);
    else if (action === 'toggle-online') void toggleOnline();
    else if (['accept', 'reject'].includes(action)) void respondOffer(action, button.dataset.offerId);
    else if (action === 'dismiss-order') dismissOrder(button.dataset.orderId);
    else if (action === 'history-detail') void loadDetail(button.dataset.orderId);
  });
  document.addEventListener('input', (event) => {
    if (event.target.id === 'finishDistance') state.finishDistances.set(event.target.dataset.orderId, event.target.value);
  });
  for (const selector of ['#originSelect', '#destinationSelect']) $(selector).addEventListener('change', () => {
    state.originId = $('#originSelect').value; state.destinationId = $('#destinationSelect').value;
    void requestEstimate();
  });
  $('#swapPlaces').addEventListener('click', () => {
    [state.originId, state.destinationId] = [state.destinationId, state.originId];
    fillPlaces(); void requestEstimate();
  });
  $('#bookingForm').addEventListener('submit', (event) => { event.preventDefault(); void createRide(); });
  $('#refreshEstimate').addEventListener('click', () => { if (state.placesError) void loadPlaces(); else void requestEstimate(); });
  $('#retryAccounts').addEventListener('click', () => { state.loginError = ''; renderLogin(); void loadAccounts(); });
  $('#sessionButton').addEventListener('click', () => logout('已退出当前账号，请选择另一位出行伙伴。'));
  $('#refreshHistory').addEventListener('click', () => void loadHistory({ manual: true }));
  $('#retryConnection').addEventListener('click', () => schedulePoll(0));
  $('#fitMap').addEventListener('click', fitMap);
  $('#navHome').addEventListener('click', () => {
    $('#navHome').classList.add('is-active'); $('#navHistory').classList.remove('is-active');
    $('#main').scrollIntoView({ behavior: 'auto', block: 'start' });
  });
  $('#navHistory').addEventListener('click', () => {
    $('#navHistory').classList.add('is-active'); $('#navHome').classList.remove('is-active');
    $('#historySection').scrollIntoView({ behavior: 'auto', block: 'start' });
    void loadHistory();
  });
  $('#closeDetail').addEventListener('click', () => $('#historyDialog').close());
  $('#historyDialog').addEventListener('click', (event) => { if (event.target === $('#historyDialog')) { const bounds = event.target.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close(); } });
  $('#historyDialog').addEventListener('close', () => { state.detail = null; });
  window.addEventListener('online', () => { if (state.actor) schedulePoll(0); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.actor) schedulePoll(0); });
  window.addEventListener('resize', () => map?.invalidateSize({ animate: false }));
}
async function boot() {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (typeof session?.token === 'string' && session.token && session.actor?.id && typeof session.actor.name === 'string' && ['RIDER', 'DRIVER'].includes(session.actor.role)) {
      state.token = session.token; state.actor = session.actor;
      const pending = JSON.parse(sessionStorage.getItem(CREATE_KEY) || 'null');
      if (pending?.actorId === state.actor.id && typeof pending.key === 'string' && pending.estimateId) state.pendingCreate = pending;
    }
  } catch { /* An unavailable or outdated tab session starts at the account picker. */ }
  initMap(); bindEvents(); renderAll();
  if (state.actor) schedulePoll(0);
  await Promise.allSettled([loadAccounts(), loadPlaces()]);
  renderAll();
}
void boot();
setInterval(tick, 1000);
