// ---------- Supabase setup ----------
const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// 물(음용수/정제수)은 레시피에서 원가가 항상 0원으로 등록되는 필수 충전재라, 실제 구매기록이 있을 수가
// 없다(수돗물이라 자재사용량에 안 잡힘) — computeMenuConsumption의 waterRatio와 computeActualCostPerGram의
// 가격근거 신뢰도(groundedRatio) 계산이 이 목록을 공유해서 "물을 많이 쓰는 국물류 메뉴"가 부당하게
// 저신뢰로 판정되는 걸 막는다.
const WATER_CODES = ['음용수', '정제수'];

// Deleting thousands of ids in one .in() call makes the request URL too long and fails
// with "Bad Request"; split into smaller chunks instead.
async function deleteInChunks(table, ids, chunkSize = 200) {
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { error } = await sb.from(table).delete().in('id', chunk);
    if (error) return { error };
  }
  return { error: null };
}

// PostgREST caps a single request at 1000 rows by default; page through until exhausted.
async function fetchAllRows(table, applyFilters, selectCols = '*') {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(selectCols);
    if (applyFilters) q = applyFilters(q);
    // stable tiebreaker so .range() pages don't return duplicate/missing rows on tables past 1000 rows
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return { data: all, error: null };
}

const CATEGORY_ORDER = ['축산', '야채', '핫', '콜', '월남쌈', '죽', '음료', '디저트', '육수', '토핑', '소스', '드랍'];
// 드랍은 자재사용량 조닝 태그로는 쓰지만, 대시보드 원가 비교 표에는 별도 행으로 보여주지 않음
const DASHBOARD_CATEGORIES = CATEGORY_ORDER.filter(c => c !== '드랍');
const CATEGORY_ALIASES = {
  '축산파트': '축산', '야채파트': '야채', '핫파트': '핫', '콜파트': '콜',
  '월남쌈파트': '월남쌈', '죽파트': '죽',
  '음료파트': '음료', '디저트파트': '디저트',
  '육수파트': '육수', '토핑파트': '토핑',
  // 예전에 "월남쌈/죽", "음료/디저트"로 합쳐서 쓰던 표기가 그대로 들어오면 앞쪽 카테고리로 우선 배정 (정확한 분리는 원본 데이터에서 다시 태그해야 함)
  '월남쌈/죽': '월남쌈', '월남쌈죽파트': '월남쌈', '월남쌈죽': '월남쌈',
  '음료/디저트': '음료', '음료디저트파트': '음료', '음료디저트': '음료',
};
// 이츠시스템 등 외부 데이터의 "핫파트" 같은 표기를 앱 기준 카테고리명("핫")으로 정규화
function normalizeCategory(raw) {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (CATEGORY_ORDER.includes(trimmed)) return trimmed;
  if (CATEGORY_ALIASES[trimmed]) return CATEGORY_ALIASES[trimmed];
  const stripped = trimmed.replace(/파트$/, '');
  if (CATEGORY_ORDER.includes(stripped)) return stripped;
  const found = CATEGORY_ORDER.find(c => trimmed.startsWith(c) || stripped.startsWith(c));
  return found || trimmed;
}

// 매장 타입 (199-229/일반/프리미엄) — 메뉴 운영패턴을 매장 타입별로 다르게 적용하기 위한 고정 매핑.
// 199-229는 매장코드로, 프리미엄은 매장명에 "프리미엄"이 들어가는지로 구분한다. 어느 쪽도 아니면 "일반".
const VALUE_STORE_CODES = new Set([
  'RU030', // 수원터미널
  'RU031', // 중앙로역
  'RU033', // 일산
  'RU035', // 순천
  'RU039', // 광주역
  'RU037', // 괴정
  'RU041', // 부산대
]);
function storeType(storeCode, storeName) {
  if (VALUE_STORE_CODES.has(storeCode)) return 'value';
  if ((storeName || '').includes('프리미엄')) return 'premium';
  return 'regular';
}

let state = {
  seasons: [],
  currentSeasonId: null,
  categorySummary: [],
  seasonTarget: null,
  targetPriceBySeasonId: {},
};

// ---------- Utility ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const fmtNum = (v, digits = 1) => (v === null || v === undefined || v === '') ? '-' : Number(v).toLocaleString('ko-KR', { maximumFractionDigits: digits });
const fmtPct = (v) => (v === null || v === undefined || v === '') ? '-' : `${Number(v).toFixed(1)}%`;
// "물 포함(물 제외)" 형태로 한 셀에 같이 표시 (원가 계산엔 물 포함 값만 쓰고, 괄호는 참고용)
const fmtWithExclWater = (main, exclWater, digits = 0) => {
  if (main === null || main === undefined || main === '') return '-';
  const exclVal = (exclWater === null || exclWater === undefined || exclWater === '') ? main : exclWater;
  return `${fmtNum(main, digits)}(${fmtNum(exclVal, digits)})`;
};

function median(arr) {
  const nums = arr.filter(v => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}
// 정렬된 배열에서 p(0~1) 백분위 값을 최근접-순위 방식으로 뽑는다 (긴급도 등급 산출용)
function percentile(sortedNums, p) {
  if (!sortedNums.length) return null;
  const idx = Math.min(sortedNums.length - 1, Math.max(0, Math.ceil(p * sortedNums.length) - 1));
  return sortedNums[idx];
}

// 원가율(%) = (g당원가 × 인당소비량) / (목표객단가 ÷ 1.1) — 부가세 제외 매출 기준
function computeCostRatio(costPerGram, consumptionPerPerson, targetPrice) {
  if (costPerGram == null || costPerGram === '' || consumptionPerPerson == null || consumptionPerPerson === '' || !targetPrice) return null;
  const netPrice = Number(targetPrice) / 1.1;
  if (!netPrice) return null;
  return (Number(costPerGram) * Number(consumptionPerPerson)) / netPrice * 100;
}

async function getTargetPrice(seasonId) {
  if (seasonId === state.currentSeasonId && state.seasonTarget) return state.seasonTarget.target_price_per_person ?? null;
  if (seasonId in state.targetPriceBySeasonId) return state.targetPriceBySeasonId[seasonId];
  const { data } = await sb.from('season_targets').select('target_price_per_person').eq('season_id', seasonId).maybeSingle();
  const price = data?.target_price_per_person ?? null;
  state.targetPriceBySeasonId[seasonId] = price;
  return price;
}

function flash(el, msg, ok = true) {
  el.textContent = msg;
  el.style.color = ok ? 'var(--good)' : 'var(--crit)';
  setTimeout(() => { el.textContent = ''; }, 3000);
}

// ---------- Auth ----------
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  toggleView(!!session);

  sb.auth.onAuthStateChange((_event, session) => {
    toggleView(!!session);
    if (session) bootApp();
  });

  if (session) bootApp();
}

function toggleView(loggedIn) {
  $('#loginView').hidden = loggedIn;
  $('#appView').hidden = !loggedIn;
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  const errEl = $('#loginError');
  errEl.hidden = true;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = `로그인 실패: ${error.message} (status ${error.status ?? '-'})`;
    errEl.hidden = false;
    console.error('login error', error);
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await sb.auth.signOut();
});

// ---------- App boot ----------
let booted = false;
async function bootApp() {
  if (booted) return;
  booted = true;
  await loadSeasons();
  setupTabNav();
  setupSeasonControls();
  setupDatalist();
  await loadAllForCurrentSeason();
  await loadBomView(); // 레시피도 시즌과 무관하므로 한 번만 로드
  // 시장 데이터(market_prices)는 30만 행이 넘어서 매번 부팅할 때마다 통째로 받아오면
  // 다른 탭들 로딩과 계속 경합한다 — "시장 데이터" 탭을 실제로 열 때만 불러오게 미룬다.
}

function setupDatalist() {
  if ($('#categoryList')) return;
  const dl = document.createElement('datalist');
  dl.id = 'categoryList';
  dl.innerHTML = CATEGORY_ORDER.map(c => `<option value="${c}">`).join('');
  document.body.appendChild(dl);
}

// ---------- Seasons ----------
// 시즌의 실제 데이터 매칭은 season_id가 아니라 start_month~end_month 범위(일 단위)로 이루어진다.
// (자재사용량/매출·객수는 실제 날짜가 이 범위 안에 들어오는 데이터를 가져와 연동한다)
function nextMonthDate(dateStr) {
  if (!dateStr) return null;
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(y, m, 1); // m은 1-indexed이므로 그대로 넘기면 다음달 1일이 됨
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function nextDay(dateStr) {
  if (!dateStr) return null;
  const [y, m, day] = dateStr.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function lastDayOfMonth(dateStr) {
  if (!dateStr) return null;
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(y, m, 0); // day 0 of next month = last day of this month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function currentSeason() {
  return state.seasons.find(s => s.id === state.currentSeasonId) || null;
}
// 시즌에 범위가 지정되어 있으면 범위로 필터링하고, 아직 범위가 없으면 기존 방식(season_id)으로 대체.
// end_month는 "포함되는 마지막 날짜"(일 단위)로 저장되어 있어, 상한은 그 다음 날 미만으로 잡는다.
function applySeasonDateFilter(query, dateField) {
  return applyDateFilterForSeason(query, dateField, state.currentSeasonId);
}
// applySeasonDateFilter와 같은 로직이지만, 화면에 선택된 "현재 시즌"이 아니라 임의의 seasonId를 받는다 —
// 피벗처럼 화면 상단 시즌 선택과 무관하게 특정 시즌의 자재단가를 조회해야 하는 곳에서 씀.
function applyDateFilterForSeason(query, dateField, seasonId) {
  const season = state.seasons.find(s => s.id === seasonId);
  if (season?.start_month && season?.end_month) {
    return query.gte(dateField, season.start_month).lt(dateField, nextDay(season.end_month));
  }
  return query.eq('season_id', seasonId);
}

// 시즌명을 "26년 여름" 형태로 넣으면 연도 오름차순 -> 봄/여름/가을/겨울 순으로 정렬한다.
// 패턴에 안 맞는 이름은 만든 순서대로 맨 뒤에 배치.
const SEASON_ORDER_MAP = { '봄': 0, '여름': 1, '가을': 2, '겨울': 3 };
function seasonSortKey(name) {
  const yearMatch = (name || '').match(/(\d{2,4})\s*년/);
  if (!yearMatch) return null;
  let year = Number(yearMatch[1]);
  if (year < 100) year += 2000;
  const seasonMatch = (name || '').match(/(봄|여름|가을|겨울)/);
  const seasonIdx = seasonMatch ? SEASON_ORDER_MAP[seasonMatch[1]] : 4;
  return year * 10 + seasonIdx;
}
function sortSeasons(list) {
  return (list || []).slice().sort((a, b) => {
    const ka = seasonSortKey(a.name), kb = seasonSortKey(b.name);
    if (ka === null && kb === null) return new Date(a.created_at) - new Date(b.created_at);
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka - kb;
  });
}

async function loadSeasons() {
  const { data, error } = await sb.from('seasons').select('*').order('created_at', { ascending: true });
  if (error) { console.error(error); return; }
  state.seasons = sortSeasons(data);
  const sel = $('#seasonSelect');
  sel.innerHTML = state.seasons.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  if (!state.currentSeasonId && state.seasons.length) {
    state.currentSeasonId = state.seasons[state.seasons.length - 1].id;
  }
  if (state.currentSeasonId) sel.value = state.currentSeasonId;
  renderSeasonRangeInputs();
  $('#seasonNameList').innerHTML = state.seasons.map(s => `<option value="${s.name}">`).join('');
}

function renderSeasonRangeInputs() {
  const season = currentSeason();
  $('#seasonStartMonth').value = season?.start_month || '';
  $('#seasonEndMonth').value = season?.end_month || '';
}

// 시즌 범위 날짜 선택 — 재고실사 주기(매주 월요일 + 매달 말일)에 안 맞는 날짜를 실수로 고르면
// 자재사용량(주 단위)과 매출(일 단위)의 반영 구간이 어긋나서 실적이 왜곡된다(2026-08-12 발견 사례).
// EATS 시스템의 날짜 선택 화면처럼, 유효한 날짜만 클릭 가능한 팝업 달력으로 원천 차단한다.
// 종료일(재고실사일 자체) = 월요일 또는 말일. 시작일(그 다음 실사 구간의 첫날) = 화요일 또는 말일.
function isSeasonCutoffDate(d, kind) {
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const isMonthEnd = d.getDate() === lastDay;
  const isMonthStart = d.getDate() === 1;
  // 종료일(월요일 또는 말일) 다음날이 시작일이어야 하므로: 월요일 다음날=화요일, 말일 다음날=1일.
  // (예전엔 시작일도 "말일"을 허용해서 직전 시즌 종료일과 겹치는 하루가 생겼었음 — 화요일/1일로 수정)
  if (kind === 'start') return d.getDay() === 2 || isMonthStart; // 화요일 또는 1일
  return d.getDay() === 1 || isMonthEnd; // 월요일 또는 말일
}
let seasonDatePickerState = null;
function closeSeasonDatePicker() {
  $('#seasonDatePopup').style.display = 'none';
  document.removeEventListener('click', handleSeasonDatePickerOutsideClick, true);
  seasonDatePickerState = null;
}
function handleSeasonDatePickerOutsideClick(e) {
  const popup = $('#seasonDatePopup');
  if (seasonDatePickerState && !popup.contains(e.target) && e.target !== seasonDatePickerState.targetInput) {
    closeSeasonDatePicker();
  }
}
function renderSeasonDatePickerCalendar() {
  const { viewYear, viewMonth, targetInput } = seasonDatePickerState;
  const selectedStr = targetInput.value;
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const dow = ['일', '월', '화', '수', '목', '금', '토'];
  let html = `
    <div class="date-popup-header">
      <button type="button" class="date-popup-nav" data-nav="-1">‹</button>
      <span>${viewYear}년 ${viewMonth + 1}월</span>
      <button type="button" class="date-popup-nav" data-nav="1">›</button>
    </div>
    <div class="date-popup-grid date-popup-dow">${dow.map(d => `<span>${d}</span>`).join('')}</div>
    <div class="date-popup-grid">`;
  for (let i = 0; i < firstWeekday; i++) html += `<span></span>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(viewYear, viewMonth, day);
    const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const valid = isSeasonCutoffDate(d, seasonDatePickerState.kind);
    const cls = ['date-popup-day'];
    if (!valid) cls.push('is-disabled');
    if (dateStr === selectedStr) cls.push('is-selected');
    html += `<button type="button" class="${cls.join(' ')}" ${valid ? `data-date="${dateStr}"` : 'disabled'}>${day}</button>`;
  }
  html += `</div>`;
  const popup = $('#seasonDatePopup');
  popup.innerHTML = html;
  $$('.date-popup-nav', popup).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      seasonDatePickerState.viewMonth += Number(btn.dataset.nav);
      if (seasonDatePickerState.viewMonth < 0) { seasonDatePickerState.viewMonth = 11; seasonDatePickerState.viewYear--; }
      if (seasonDatePickerState.viewMonth > 11) { seasonDatePickerState.viewMonth = 0; seasonDatePickerState.viewYear++; }
      renderSeasonDatePickerCalendar();
    });
  });
  $$('.date-popup-day[data-date]', popup).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      targetInput.value = btn.dataset.date;
      targetInput.dispatchEvent(new Event('change'));
      closeSeasonDatePicker();
    });
  });
}
function openSeasonDatePicker(inputEl, kind) {
  const existing = inputEl.value;
  const [y, m, d] = existing ? existing.split('-').map(Number) : [null, null, null];
  const base = existing ? new Date(y, m - 1, d) : new Date();
  seasonDatePickerState = { targetInput: inputEl, kind, viewYear: base.getFullYear(), viewMonth: base.getMonth() };
  renderSeasonDatePickerCalendar();
  const popup = $('#seasonDatePopup');
  popup.style.display = 'block';
  const rect = inputEl.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.top = `${rect.bottom + 4}px`;
  popup.style.left = `${rect.left}px`;
  setTimeout(() => document.addEventListener('click', handleSeasonDatePickerOutsideClick, true), 0);
}

function setupSeasonControls() {
  $('#seasonStartMonth').addEventListener('click', () => openSeasonDatePicker($('#seasonStartMonth'), 'start'));
  $('#seasonEndMonth').addEventListener('click', () => openSeasonDatePicker($('#seasonEndMonth'), 'end'));

  $('#seasonSelect').addEventListener('change', async (e) => {
    state.currentSeasonId = Number(e.target.value);
    renderSeasonRangeInputs();
    await loadAllForCurrentSeason();
  });

  $('#newSeasonBtn').addEventListener('click', async () => {
    const name = prompt('새 시즌 이름을 입력하세요 (예: 26년 가을시즌)');
    if (!name) return;
    const { data, error } = await sb.from('seasons').insert({ name: name.trim() }).select().single();
    if (error) { alert('시즌 생성 실패: ' + error.message); return; }
    await loadSeasons();
    state.currentSeasonId = data.id;
    $('#seasonSelect').value = data.id;
    renderSeasonRangeInputs();
    await loadAllForCurrentSeason();
  });

  const saveSeasonRange = async () => {
    if (!state.currentSeasonId) return;
    const startVal = $('#seasonStartMonth').value;
    const endVal = $('#seasonEndMonth').value;
    if (startVal && endVal && startVal > endVal) {
      alert('시작일이 종료일보다 늦을 수 없습니다.');
      renderSeasonRangeInputs();
      return;
    }
    const { error } = await sb.from('seasons')
      .update({ start_month: startVal || null, end_month: endVal || null })
      .eq('id', state.currentSeasonId);
    if (error) { alert('시즌 범위 저장 실패: ' + error.message); return; }
    await loadSeasons();
    await loadAllForCurrentSeason();
  };
  $('#seasonStartMonth').addEventListener('change', saveSeasonRange);
  $('#seasonEndMonth').addEventListener('change', saveSeasonRange);
}

async function loadAllForCurrentSeason() {
  await loadDashboard(); // loadTargetForm/renderTargetCostTab이 state.categorySummary를 읽으므로 먼저 끝나야 함
  renderTargetCostTab();
  await Promise.all([
    loadTargetForm(),
    loadTargetCostLog(),
    loadUsageView(),
    loadSalesView(),
    loadMenuConsumptionView(),
    loadProduceMonitoring(),
    loadSeasonPilotView(),
  ]);
  await loadRecipeLog();
}

// ---------- Tab navigation ----------
let marketViewLoaded = false;
function setupTabNav() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('is-active'));
      $$('.tab-panel').forEach(p => p.classList.remove('is-active'));
      btn.classList.add('is-active');
      $(`#tab-${btn.dataset.tab}`).classList.add('is-active');
      // "데이터" 그룹은 기본 서브탭이 "시장 데이터"라 그룹 버튼 클릭만으로도 그 화면이 바로 보이므로,
      // 서브탭 자체를 누르지 않아도 여기서 한 번 지연로드를 트리거해야 한다.
      if (btn.dataset.tab === 'data-group' && !marketViewLoaded) {
        marketViewLoaded = true;
        loadMarketView();
      }
    });
  });
}

// =====================================================================
// Tab 1: Dashboard
// =====================================================================
async function loadDashboard() {
  if (!state.currentSeasonId) return;
  const [{ data: target }, { data: rows }] = await Promise.all([
    sb.from('season_targets').select('*').eq('season_id', state.currentSeasonId).maybeSingle(),
    sb.from('category_summary').select('*').eq('season_id', state.currentSeasonId).in('category', DASHBOARD_CATEGORIES),
  ]);
  state.seasonTarget = target || null;
  state.categorySummary = rows || [];
  renderKpiRow();
  renderDashboardTable();
  renderFeedback();
  loadCostTrend();
}

// 실적-목표 차이(%p)를 색깔 있는 셀로 보여준다. 원가율은 낮을수록 좋으므로 실적이 목표보다 높으면(초과) 경고색.
function deltaCell(actualRatio, targetRatio) {
  if (actualRatio == null || targetRatio == null) return `<td class="computed-ratio">-</td>`;
  const gap = actualRatio - targetRatio;
  const cls = gap >= 1 ? 'pill-crit' : gap >= 0.3 ? 'pill-warn' : 'pill-good';
  const sign = gap > 0 ? '+' : '';
  return `<td class="${cls}">${sign}${gap.toFixed(1)}%p</td>`;
}

function weightedTotals(rows, prefix) {
  const ck = `${prefix}_consumption_per_person`, gk = `${prefix}_cost_per_gram`;
  let totalC = 0, totalCost = 0;
  rows.forEach(r => {
    const c = Number(r[ck]) || 0;
    totalC += c;
    totalCost += c * (Number(r[gk]) || 0);
  });
  return {
    consumption: totalC,
    costPerGram: totalC ? totalCost / totalC : 0,
  };
}

function renderKpiRow() {
  const t = state.seasonTarget;
  const targetPrice = t?.target_price_per_person ?? null;
  const brandTarget = weightedTotals(state.categorySummary, 'target');
  const brandActual = weightedTotals(state.categorySummary, 'actual');
  const brandActualExclWater = state.categorySummary.reduce((a, r) => a + (Number(r.actual_consumption_per_person_excl_water) || 0), 0);
  const targetRatio = computeCostRatio(brandTarget.costPerGram, brandTarget.consumption, targetPrice);
  const actualRatio = t?.actual_cost_ratio_brand ?? null; // 자재실사용액 / (총매출/1.1), 실적 반영 버튼으로 계산됨
  const wrap = $('#kpiRow');
  const gap = (targetRatio !== null && actualRatio !== null) ? (actualRatio - targetRatio) : null;
  const sevClass = gap === null ? '' : gap >= 1 ? 'is-crit' : gap >= 0.3 ? 'is-warn' : 'is-good';

  wrap.innerHTML = `
    <div class="kpi-tile">
      <div class="kpi-label">목표 원가율</div>
      <div class="kpi-value">${targetRatio !== null ? fmtPct(targetRatio) : '미설정'}</div>
    </div>
    <div class="kpi-tile kpi-hero ${sevClass}">
      <div class="kpi-label">브랜드 실적 원가율</div>
      <div class="kpi-value">${actualRatio !== null ? fmtPct(actualRatio) : '미반영'}</div>
      <div class="kpi-sub">${gap === null ? '' : (gap >= 0 ? `목표 대비 +${gap.toFixed(1)}%p` : `목표 대비 ${gap.toFixed(1)}%p`)}</div>
    </div>
    <div class="kpi-tile">
      <div class="kpi-label">객단가 (실적 기준)</div>
      <div class="kpi-value">${t?.actual_price_per_person != null ? fmtNum(t.actual_price_per_person, 0) + '원' : '미반영'}</div>
    </div>
    <div class="kpi-tile">
      <div class="kpi-label">인당소비량 (목표 / 실적)</div>
      <div class="kpi-value">${fmtNum(brandTarget.consumption, 0)}g / ${fmtWithExclWater(brandActual.consumption, brandActualExclWater)}g</div>
    </div>
  `;
}

function renderDashboardTable() {
  const body = $('#dashboardBody');
  const rows = state.categorySummary;
  const t = state.seasonTarget;
  const targetPrice = t?.target_price_per_person ?? null;
  const byCategory = Object.fromEntries(rows.map(r => [r.category, r]));
  const target = weightedTotals(rows, 'target');
  const design = weightedTotals(rows, 'design');
  const actual = weightedTotals(rows, 'actual');
  const targetRatio = computeCostRatio(target.costPerGram, target.consumption, targetPrice);
  const designRatio = computeCostRatio(design.costPerGram, design.consumption, targetPrice);
  const actualRatio = t?.actual_cost_ratio_brand ?? null;
  const actualExclWaterTotal = rows.reduce((a, r) => a + (Number(r.actual_consumption_per_person_excl_water) || 0), 0);

  const brandRow = `
    <tr class="row-brand">
      <td>로운 (전체)</td>
      <td>${fmtPct(targetRatio)}</td><td>${fmtPct(designRatio)}</td><td>${fmtPct(actualRatio)}</td>
      ${deltaCell(actualRatio, targetRatio)}
      <td>${fmtNum(target.costPerGram, 1)}g</td><td>${fmtNum(design.costPerGram, 1)}g</td><td>${fmtNum(actual.costPerGram, 1)}g</td>
      <td>${fmtNum(target.consumption, 0)}</td><td>${fmtNum(design.consumption, 0)}</td><td>${fmtWithExclWater(actual.consumption, actualExclWaterTotal)}</td>
    </tr>`;

  const catRows = DASHBOARD_CATEGORIES.map(cat => {
    const r = byCategory[cat] || { category: cat };
    const catTargetRatio = computeCostRatio(r.target_cost_per_gram, r.target_consumption_per_person, targetPrice);
    const catDesignRatio = computeCostRatio(r.design_cost_per_gram, r.design_consumption_per_person, targetPrice);
    const catActualRatio = computeCostRatio(r.actual_cost_per_gram, r.actual_consumption_per_person, targetPrice);
    return `
      <tr data-category="${cat}">
        <td>${cat}</td>
        <td class="computed-ratio">${fmtPct(catTargetRatio)}</td>
        <td>${fmtPct(catDesignRatio)}</td>
        <td class="computed-ratio">${fmtPct(catActualRatio)}</td>
        ${deltaCell(catActualRatio, catTargetRatio)}
        <td class="computed-ratio">${fmtNum(r.target_cost_per_gram, 1)}${r.target_cost_per_gram != null ? 'g' : ''}</td>
        <td>${fmtNum(r.design_cost_per_gram, 1)}${r.design_cost_per_gram != null ? 'g' : ''}</td>
        <td>${fmtNum(r.actual_cost_per_gram, 1)}${r.actual_cost_per_gram != null ? 'g' : ''}</td>
        <td class="computed-ratio">${fmtNum(r.target_consumption_per_person, 0)}</td>
        <td>${fmtNum(r.design_consumption_per_person, 0)}</td>
        <td>${fmtWithExclWater(r.actual_consumption_per_person, r.actual_consumption_per_person_excl_water)}</td>
      </tr>`;
  }).join('');

  body.innerHTML = brandRow + catRows;
}

// =====================================================================
// Tab: 목표원가 (시즌·조닝별 목표 g당원가/인당소비량 입력 — 대시보드는 이 값을 읽기만 함)
// =====================================================================
function renderTargetCostTab() {
  const body = $('#targetCostBody');
  if (!body) return;
  const seasonLabel = $('#targetCostSeasonLabel');
  if (seasonLabel) seasonLabel.textContent = `시즌 목표원가 — ${currentSeason()?.name ?? '시즌 미선택'}`;
  const rows = state.categorySummary;
  const byCategory = Object.fromEntries(rows.map(r => [r.category, r]));
  const targetPrice = state.seasonTarget?.target_price_per_person ?? null;
  const target = weightedTotals(rows, 'target');
  const brandRatio = computeCostRatio(target.costPerGram, target.consumption, targetPrice);

  const brandRow = `
    <tr class="row-brand">
      <td>로운 (전체)</td>
      <td>${fmtPct(brandRatio)}</td>
      <td>${fmtNum(target.costPerGram, 1)}${target.costPerGram ? 'g' : ''}</td>
      <td>${fmtNum(target.consumption, 0)}</td>
    </tr>`;

  const catRows = DASHBOARD_CATEGORIES.map(cat => {
    const r = byCategory[cat] || { category: cat };
    const ratio = computeCostRatio(r.target_cost_per_gram, r.target_consumption_per_person, targetPrice);
    return `
      <tr data-category="${cat}">
        <td>${cat}</td>
        <td class="computed-ratio">${fmtPct(ratio)}</td>
        <td><input type="number" step="0.1" class="target-input" data-field="target_cost_per_gram" value="${r.target_cost_per_gram ?? ''}"></td>
        <td><input type="number" step="1" class="target-input" data-field="target_consumption_per_person" value="${r.target_consumption_per_person ?? ''}"></td>
      </tr>`;
  }).join('');

  body.innerHTML = brandRow + catRows;

  $$('.target-input', body).forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const tr = e.target.closest('tr');
      const category = tr.dataset.category;
      const field = e.target.dataset.field;
      const value = e.target.value === '' ? null : Number(e.target.value);
      const gramInp = $('.target-input[data-field="target_cost_per_gram"]', tr);
      const consInp = $('.target-input[data-field="target_consumption_per_person"]', tr);
      const nextGram = field === 'target_cost_per_gram' ? value : (gramInp.value === '' ? null : Number(gramInp.value));
      const nextCons = field === 'target_consumption_per_person' ? value : (consInp.value === '' ? null : Number(consInp.value));
      const newRatio = computeCostRatio(nextGram, nextCons, targetPrice);
      const { error } = await sb.from('category_summary')
        .upsert({ season_id: state.currentSeasonId, category, [field]: value, target_cost_ratio: newRatio }, { onConflict: 'season_id,category' });
      if (error) { alert('저장 실패: ' + error.message); return; }
      await loadDashboard();
      renderTargetCostTab();
    });
  });
}

// 저장된 시즌별 목표원가를 전부 불러와 시즌 필터로 조회/수정할 수 있게 보여준다 ("등록된 메뉴" 목록과 같은 방식)
let targetCostLogCache = [];
async function loadTargetCostLog() {
  const { data, error } = await sb.from('category_summary').select('*, seasons(name)').order('season_id', { ascending: false });
  if (error) { console.error(error); return; }
  targetCostLogCache = (data || []).filter(r => DASHBOARD_CATEGORIES.includes(r.category));

  const seasonSel = $('#targetCostSeasonFilter');
  const seasonNames = [...new Set(targetCostLogCache.map(r => r.seasons?.name).filter(Boolean))];
  const prevValue = seasonSel.value;
  seasonSel.innerHTML = '<option value="">전체 시즌</option>' + seasonNames.map(n => `<option value="${n}">${n}</option>`).join('');
  seasonSel.value = seasonNames.includes(prevValue) ? prevValue : '';

  renderTargetCostLog();
}

async function renderTargetCostLog() {
  const seasonF = $('#targetCostSeasonFilter').value;
  const rows = targetCostLogCache.filter(r => !seasonF || r.seasons?.name === seasonF);
  const seasonIds = [...new Set(rows.map(r => r.season_id))];
  await Promise.all(seasonIds.map(sid => getTargetPrice(sid)));

  const body = $('#targetCostLogBody');
  body.innerHTML = rows.map(r => {
    const targetPrice = state.targetPriceBySeasonId[r.season_id] ?? (r.season_id === state.currentSeasonId ? state.seasonTarget?.target_price_per_person : null);
    const ratio = computeCostRatio(r.target_cost_per_gram, r.target_consumption_per_person, targetPrice);
    return `
    <tr data-id="${r.id}" data-season-id="${r.season_id}" data-category="${r.category}">
      <td>${r.seasons?.name ?? '-'}</td>
      <td class="cell-left">${r.category}</td>
      <td class="computed-ratio-cell">${fmtPct(ratio)}</td>
      <td><input class="cell-input" type="number" step="0.1" data-field="target_cost_per_gram" value="${r.target_cost_per_gram ?? ''}"></td>
      <td><input class="cell-input" type="number" step="1" data-field="target_consumption_per_person" value="${r.target_consumption_per_person ?? ''}"></td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" style="text-align:center;color:var(--muted)">데이터가 없습니다.</td></tr>`;

  $$('input.cell-input', body).forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const tr = e.target.closest('tr');
      const seasonId = Number(tr.dataset.seasonId);
      const category = tr.dataset.category;
      const field = e.target.dataset.field;
      const value = numOrNull(e.target.value);
      const gramInp = $('input[data-field="target_cost_per_gram"]', tr);
      const consInp = $('input[data-field="target_consumption_per_person"]', tr);
      const nextGram = field === 'target_cost_per_gram' ? value : numOrNull(gramInp.value);
      const nextCons = field === 'target_consumption_per_person' ? value : numOrNull(consInp.value);
      const newRatio = computeCostRatio(nextGram, nextCons, await getTargetPrice(seasonId));
      const { error } = await sb.from('category_summary')
        .upsert({ season_id: seasonId, category, [field]: value, target_cost_ratio: newRatio }, { onConflict: 'season_id,category' });
      if (error) { alert('저장 실패: ' + error.message); return; }
      if (seasonId === state.currentSeasonId) { await loadDashboard(); renderTargetCostTab(); }
      await loadTargetCostLog();
    });
  });
}
$('#targetCostSeasonFilter').addEventListener('change', renderTargetCostLog);

// 월별 실적 원가율 추이 (전체 시즌의 자재사용량·매출을 월 단위로 묶어 계산 — 시즌 경계와 무관하게 흐름을 보여줌)
// 자재사용량이 27만 행이 넘어서 예전엔 전체를 다 받아와 브라우저에서 월별로 더했음 — 시즌 전환할 때마다
// 100초 넘게 걸리며 다른 모든 요청을 굶기던 원인. DB에 만든 집계 함수(material_usage_monthly_totals)로
// 월별 합계만 받아오도록 바꿈.
async function loadCostTrend() {
  const [{ data: usage, error: usageErr }, { data: sales }] = await Promise.all([
    sb.rpc('material_usage_monthly_totals'),
    fetchAllRows('store_sales', null, 'sales_date, sales_total'),
  ]);
  if (usageErr) console.error(usageErr);
  const costByMonth = {}, salesByMonth = {};
  (usage || []).forEach(r => {
    const m = (r.usage_month || '').slice(0, 7);
    if (!m) return;
    costByMonth[m] = (costByMonth[m] || 0) + (Number(r.total_amount) || 0);
  });
  (sales || []).forEach(r => {
    const m = (r.sales_date || '').slice(0, 7);
    if (!m) return;
    salesByMonth[m] = (salesByMonth[m] || 0) + (Number(r.sales_total) || 0);
  });
  const months = [...new Set([...Object.keys(costByMonth), ...Object.keys(salesByMonth)])].sort();
  const ratios = months.map(m => salesByMonth[m] ? (costByMonth[m] || 0) / (salesByMonth[m] / 1.1) * 100 : null);

  const target = weightedTotals(state.categorySummary, 'target');
  const targetPrice = state.seasonTarget?.target_price_per_person ?? null;
  const targetRatio = computeCostRatio(target.costPerGram, target.consumption, targetPrice);

  renderCostTrendChart(months, ratios, targetRatio);
}

function renderCostTrendChart(months, ratios, targetRatio) {
  const wrap = $('#costTrendChartWrap');
  if (!wrap) return;
  const valid = ratios.filter(v => v != null);
  if (!months.length || !valid.length) { wrap.innerHTML = `<div class="chart-empty">데이터가 없습니다.</div>`; return; }

  const width = 780, height = 200, padding = { top: 14, right: 16, bottom: 22, left: 40 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const allValues = valid.concat(targetRatio != null ? [targetRatio] : []);
  const maxV = Math.max(...allValues) * 1.15 || 1;
  const xFor = (i) => months.length > 1 ? padding.left + (plotW * i / (months.length - 1)) : padding.left + plotW / 2;
  const yFor = (v) => padding.top + plotH - (plotH * v / maxV);

  const gridLines = Array.from({ length: 4 }, (_, i) => {
    const y = padding.top + plotH * i / 3;
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--line)" stroke-width="1" />`;
  }).join('');
  const yLabels = Array.from({ length: 4 }, (_, i) => {
    const v = maxV * (3 - i) / 3;
    const y = padding.top + plotH * i / 3;
    return `<text x="${padding.left - 6}" y="${y + 3}" font-size="10" fill="var(--muted)" text-anchor="end">${v.toFixed(0)}%</text>`;
  }).join('');
  const xLabels = months.map((m, i) => `<text x="${xFor(i)}" y="${height - 4}" font-size="10" fill="var(--muted)" text-anchor="middle">${m.slice(2)}</text>`).join('');

  const pts = ratios.map((v, i) => v != null ? [xFor(i), yFor(v)] : null).filter(Boolean);
  const path = buildSmoothPath(pts);
  // 점마다 원가율 라벨 — 짝수/홀수 번째를 위아래로 살짝 엇갈리게 둬서 인접한 점끼리 겹치지 않게 함
  const pointLabels = ratios.map((v, i) => {
    if (v == null) return '';
    const [x, y] = [xFor(i), yFor(v)];
    const dy = i % 2 === 0 ? -10 : -20;
    return `<text x="${x}" y="${y + dy}" font-size="10" font-weight="700" fill="var(--accent-deep)" text-anchor="middle">${v.toFixed(1)}%</text>`;
  }).join('');

  const targetLine = targetRatio != null
    ? `<line x1="${padding.left}" y1="${yFor(targetRatio)}" x2="${width - padding.right}" y2="${yFor(targetRatio)}" stroke="var(--line-strong)" stroke-width="2" stroke-dasharray="4 3" />`
    : '';

  wrap.innerHTML = `
    <div class="chart-legend">
      <span><span class="dot" style="background:var(--accent)"></span>실적 원가율</span>
      ${targetRatio != null ? `<span><span class="dot" style="background:var(--line-strong)"></span>목표 원가율</span>` : ''}
    </div>
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-width:${width}px;">
      ${gridLines}${yLabels}${targetLine}
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" />
      ${pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="var(--accent)" />`).join('')}
      ${pointLabels}
      ${xLabels}
    </svg>`;
}

// 예전엔 설계-실적 갭을 자동으로 문구화해 보여줬는데, 자동생성 문구 대신 직접 메모를 남기고
// 싶다는 요청으로 수기 입력 텍스트로 바꿨다. season_targets.feedback_note에 시즌별로 저장한다.
function renderFeedback() {
  const input = $('#feedbackNoteInput');
  input.value = state.seasonTarget?.feedback_note ?? '';
}
$('#feedbackNoteInput').addEventListener('change', async (e) => {
  const seasonId = state.currentSeasonId;
  if (!seasonId) return;
  const hint = $('#feedbackSavedHint');
  const payload = { feedback_note: e.target.value };
  if (state.seasonTarget?.id) {
    await sb.from('season_targets').update(payload).eq('id', state.seasonTarget.id);
  } else {
    const { data } = await sb.from('season_targets').insert({ ...payload, season_id: seasonId }).select().maybeSingle();
    if (data) state.seasonTarget = data;
  }
  if (state.seasonTarget) state.seasonTarget.feedback_note = payload.feedback_note;
  hint.textContent = '저장됨';
  setTimeout(() => { if (hint.textContent === '저장됨') hint.textContent = ''; }, 2000);
});

// =====================================================================
// Tab 2: Target + Menu design input
// =====================================================================
async function loadTargetForm() {
  const t = state.seasonTarget;
  const targetPrice = t?.target_price_per_person ?? null;
  $('#targetPriceDisplay').textContent = targetPrice != null ? fmtNum(targetPrice, 0) + '원' : '미반영';

  const design = weightedTotals(state.categorySummary, 'design');
  const designRatio = computeCostRatio(design.costPerGram, design.consumption, targetPrice);
  const designValue = (design.costPerGram && design.consumption) ? design.costPerGram * design.consumption : null;
  $('#designRatioDisplay').textContent = fmtPct(designRatio);
  $('#designCostPerGramDisplay').textContent = design.costPerGram ? fmtNum(design.costPerGram, 1) + 'g' : '-';
  $('#designConsumptionDisplay').textContent = design.consumption ? fmtNum(design.consumption, 0) + 'g' : '-';
  $('#designValueDisplay').textContent = designValue != null ? fmtNum(designValue, 0) + '원' : '-';
}

function numOrNull(v) { return v === '' || v === null || v === undefined ? null : Number(v); }

// -- Menu design grid --
// data-col: 0=시즌(텍스트, season_id로 변환) 1=카테고리 2=메뉴명 3=g당원가 4=인당소비량
//           5=운영패턴(199-229) 6=운영패턴(일반) 7=운영패턴(프리미엄) (원가율은 자동계산이라 붙여넣기 대상이 아님)
const menuGridBody = $('#menuGridBody');
function recomputeMenuRowRatio(tr) {
  const gram = tr.querySelector('input[data-col="3"]').value;
  const cons = tr.querySelector('input[data-col="4"]').value;
  const seasonName = tr.querySelector('input[data-col="0"]').value.trim();
  const season = state.seasons.find(s => s.name === seasonName);
  const targetPrice = season ? state.targetPriceBySeasonId[season.id] : state.seasonTarget?.target_price_per_person;
  const ratio = computeCostRatio(numOrNull(gram), numOrNull(cons), targetPrice ?? state.seasonTarget?.target_price_per_person);
  tr.querySelector('.computed-ratio-cell').textContent = ratio != null ? ratio.toFixed(1) + '%' : '-';
}
function addMenuRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" data-col="0" list="seasonNameList"></td>
    <td><input type="text" data-col="1" list="categoryList"></td>
    <td><input type="text" data-col="2"></td>
    <td class="cell-left computed-ratio-cell">-</td>
    <td><input type="number" step="0.01" data-col="3"></td>
    <td><input type="number" step="1" data-col="4"></td>
    <td><input type="text" data-col="5" list="patternList"></td>
    <td><input type="text" data-col="6" list="patternList"></td>
    <td><input type="text" data-col="7" list="patternList"></td>
    <td><button type="button" class="row-del-btn" title="삭제">×</button></td>
  `;
  tr.querySelector('.row-del-btn').addEventListener('click', () => tr.remove());
  tr.querySelector('input[data-col="3"]').addEventListener('input', () => recomputeMenuRowRatio(tr));
  tr.querySelector('input[data-col="4"]').addEventListener('input', () => recomputeMenuRowRatio(tr));
  menuGridBody.appendChild(tr);
  return tr;
}
for (let i = 0; i < 5; i++) addMenuRow();
$('#addMenuRowBtn').addEventListener('click', () => addMenuRow());
attachPasteFill(menuGridBody, addMenuRow);
menuGridBody.addEventListener('paste', () => setTimeout(() => $$('tr', menuGridBody).forEach(recomputeMenuRowRatio), 0));

$('#saveMenuGridBtn').addEventListener('click', async () => {
  const rows = [];
  const unresolvedSeasons = new Set();
  for (const tr of $$('tr', menuGridBody)) {
    const seasonName = tr.querySelector('input[data-col="0"]').value.trim();
    const category = tr.querySelector('input[data-col="1"]').value;
    const menu_name = tr.querySelector('input[data-col="2"]').value;
    const cost_per_gram = tr.querySelector('input[data-col="3"]').value;
    const consumption_per_person = tr.querySelector('input[data-col="4"]').value;
    const availability_pattern_value = tr.querySelector('input[data-col="5"]').value;
    const availability_pattern_regular = tr.querySelector('input[data-col="6"]').value;
    const availability_pattern_premium = tr.querySelector('input[data-col="7"]').value;
    if (!seasonName || !category || !menu_name) continue;
    const season = state.seasons.find(s => s.name === seasonName);
    if (!season) { unresolvedSeasons.add(seasonName); continue; }
    const targetPrice = await getTargetPrice(season.id);
    rows.push({
      season_id: season.id, category: normalizeCategory(category), menu_name: menu_name.trim(),
      cost_per_gram: numOrNull(cost_per_gram), consumption_per_person: numOrNull(consumption_per_person),
      cost_ratio: computeCostRatio(numOrNull(cost_per_gram), numOrNull(consumption_per_person), targetPrice),
      availability_pattern_value: availability_pattern_value ? availability_pattern_value.trim() : null,
      availability_pattern_regular: availability_pattern_regular ? availability_pattern_regular.trim() : null,
      availability_pattern_premium: availability_pattern_premium ? availability_pattern_premium.trim() : null,
    });
  }
  if (unresolvedSeasons.size) {
    flash($('#menuSaveMsg'), `존재하지 않는 시즌명이 있어 저장하지 않았습니다: ${[...unresolvedSeasons].join(', ')} (상단 "+ 새 시즌"으로 먼저 만들어주세요)`, false);
    return;
  }
  if (!rows.length) { flash($('#menuSaveMsg'), '입력된 행이 없습니다.', false); return; }
  const { error } = await sb.from('menu_designs').insert(rows);
  if (error) { flash($('#menuSaveMsg'), '저장 실패: ' + error.message, false); return; }

  // recompute category_summary design_* rollup (이번에 저장된 시즌들 전부)
  const seasonIds = [...new Set(rows.map(r => r.season_id))];
  for (const sid of seasonIds) await rebuildCategoryDesignRollup(sid);

  menuGridBody.innerHTML = '';
  for (let i = 0; i < 5; i++) addMenuRow();
  flash($('#menuSaveMsg'), `${rows.length}개 메뉴가 저장되었습니다.`);
  await loadDashboard();
  await loadRecipeLog();
});

// =====================================================================
// Tab: 시즌 파일럿 — 실제 매출/자재사용량 데이터 없이, 시즌·조닝·메뉴별 g당원가와 매장형태별
// 인당소비량만으로 매장군별(199-229/일반/프리미엄) 예상 원가율과 브랜드 전체 예상 원가율을 미리
// 그려보는 가상 시나리오 계산기. season_pilot_menu 테이블에 저장하고, 현재 선택된 시즌 것만
// 계산해서 보여준다. 매장형태별 인당소비량 칸이 비어있으면 그 매장형태에서 미운영으로 취급한다
// (운영패턴을 별도로 안 받는 이유 — "그 메뉴를 살 수 있었던 손님" 기준이 아니라 "그 매장형태 전체
// 손님" 기준으로 인당소비량을 입력하면, 디너/주말 한정 메뉴는 이미 낮은 숫자로 들어와 있어서
// 운영패턴 정보가 따로 필요 없다).
// data-col: 0=시즌 1=조닝 2=메뉴명 3=g당원가 4=인당소비량(199-229) 5=인당소비량(일반) 6=인당소비량(프리미엄)
// =====================================================================
const seasonPilotGridBody = $('#seasonPilotGridBody');
function addSeasonPilotRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" data-col="0" list="seasonNameList"></td>
    <td><input type="text" data-col="1" list="categoryList"></td>
    <td><input type="text" data-col="2"></td>
    <td><input type="number" step="0.01" data-col="3"></td>
    <td><input type="number" step="1" data-col="4"></td>
    <td><input type="number" step="1" data-col="5"></td>
    <td><input type="number" step="1" data-col="6"></td>
    <td><button type="button" class="row-del-btn" title="삭제">×</button></td>
  `;
  tr.querySelector('.row-del-btn').addEventListener('click', () => tr.remove());
  seasonPilotGridBody.appendChild(tr);
  return tr;
}
for (let i = 0; i < 5; i++) addSeasonPilotRow();
$('#addSeasonPilotRowBtn').addEventListener('click', () => addSeasonPilotRow());
attachPasteFill(seasonPilotGridBody, addSeasonPilotRow);

$('#saveSeasonPilotBtn').addEventListener('click', async () => {
  const rows = [];
  const unresolvedSeasons = new Set();
  for (const tr of $$('tr', seasonPilotGridBody)) {
    const seasonName = tr.querySelector('input[data-col="0"]').value.trim();
    const category = tr.querySelector('input[data-col="1"]').value;
    const menu_name = tr.querySelector('input[data-col="2"]').value;
    const cost_per_gram = tr.querySelector('input[data-col="3"]').value;
    const consumption_value = tr.querySelector('input[data-col="4"]').value;
    const consumption_regular = tr.querySelector('input[data-col="5"]').value;
    const consumption_premium = tr.querySelector('input[data-col="6"]').value;
    if (!seasonName || !category || !menu_name) continue;
    const season = state.seasons.find(s => s.name === seasonName);
    if (!season) { unresolvedSeasons.add(seasonName); continue; }
    rows.push({
      season_id: season.id, category: normalizeCategory(category), menu_name: menu_name.trim(),
      cost_per_gram: numOrNull(cost_per_gram),
      consumption_per_person_value: numOrNull(consumption_value),
      consumption_per_person_regular: numOrNull(consumption_regular),
      consumption_per_person_premium: numOrNull(consumption_premium),
    });
  }
  if (unresolvedSeasons.size) {
    flash($('#saveSeasonPilotMsg'), `존재하지 않는 시즌명이 있어 저장하지 않았습니다: ${[...unresolvedSeasons].join(', ')} (상단 "+ 새 시즌"으로 먼저 만들어주세요)`, false);
    return;
  }
  if (!rows.length) { flash($('#saveSeasonPilotMsg'), '입력된 행이 없습니다.', false); return; }

  // 같은 시즌+메뉴명 조합이 그리드에 두 번 이상 있으면 upsert가 "ON CONFLICT DO UPDATE command cannot
  // affect row a second time" 오류로 통째로 실패한다 — 마지막 값만 남기고 병합해서 보낸다(레시피 등록
  // 저장과 동일한 방식).
  const dedup = new Map();
  rows.forEach(r => dedup.set(`${r.season_id}||${r.menu_name}`, r));
  const finalRows = [...dedup.values()];

  const { error } = await sb.from('season_pilot_menu').upsert(finalRows, { onConflict: 'season_id,menu_name' });
  if (error) { flash($('#saveSeasonPilotMsg'), '저장 실패: ' + error.message, false); return; }

  seasonPilotGridBody.innerHTML = '';
  for (let i = 0; i < 5; i++) addSeasonPilotRow();
  flash($('#saveSeasonPilotMsg'), `${finalRows.length}개 메뉴가 저장되었습니다.`);
  await loadSeasonPilotView();
});

let seasonPilotCache = null;
let seasonPilotCollapsed = {};
// 결과표에서 g당원가/인당소비량을 바로 고칠 때, 고치기 전 값을 여기 쌓아뒀다가 "뒤로가기"로
// 한 단계씩 되돌린다(누를 때마다 DB에도 그 이전 값을 다시 저장).
let seasonPilotUndoStack = [];
const SEASON_PILOT_TIERS = [
  { key: 'premium', label: '프리미엄', consumptionField: 'consumption_per_person_premium' },
  { key: 'regular', label: '일반', consumptionField: 'consumption_per_person_regular' },
  { key: 'value', label: '199-229', consumptionField: 'consumption_per_person_value' },
];
// 매장군별로 객단가(원/객)가 실제로 다른데(프리미엄이 199-229보다 비싸게 파는 등), 시즌 파일럿이
// 시즌 하나에 대해 수기입력된 단일 목표가(season_targets.target_price_per_person)를 매장군 전부에
// 똑같이 적용해서 원가율을 왜곡시키고 있었다 — 매장군별로 실제 객단가 기준 원가율을 보려면
// 매장군마다 다른 분모(객단가)를 써야 한다. 가장 최근 달의 실제 매출/객수(store_sales)로
// 매장군별 객단가를 직접 계산해서 쓴다(설계 단계의 "목표"가 아니라 "지금 실제로 받고 있는 가격" 기준).
async function getRecentMonthPriceByType() {
  const { data: latestRow } = await sb.from('store_sales').select('sales_date').order('sales_date', { ascending: false }).limit(1).maybeSingle();
  const latestDate = latestRow?.sales_date;
  if (!latestDate) return null;
  // 매장형태마다 매출 입력 시점이 다를 수 있다(예: 이번 달 시작 직후엔 일부 매장형태만 입력이 끝났고
  // 나머지는 아직 안 들어옴) — "전체 공통의 가장 최근 달" 하나로 고정하면, 데이터가 늦게 들어오는
  // 매장형태는 그 시점에 통째로 "—"(계산 불가)가 되어버린다(실측: 시즌 시작 직후 프리미엄/199-229가
  // 전부 빠짐). 최근 3개월치를 모아 매장형태별로 "그 형태 자신의 가장 최근 유효한 달"을 각자 찾는다.
  const windowStartDate = new Date(latestDate);
  windowStartDate.setMonth(windowStartDate.getMonth() - 2);
  const windowStart = windowStartDate.toISOString().slice(0, 7) + '-01';
  const { data: rows } = await fetchAllRows('store_sales',
    q => q.gte('sales_date', windowStart), 'store_code, store_name, sales_date, sales_total, customers_total');
  const byTypeMonth = {};
  (rows || []).forEach(r => {
    const t = storeType(r.store_code, r.store_name);
    const month = (r.sales_date || '').slice(0, 7);
    if (!month) return;
    if (!byTypeMonth[t]) byTypeMonth[t] = {};
    if (!byTypeMonth[t][month]) byTypeMonth[t][month] = { sales: 0, customers: 0 };
    byTypeMonth[t][month].sales += Number(r.sales_total) || 0;
    byTypeMonth[t][month].customers += Number(r.customers_total) || 0;
  });
  const priceByType = {}, monthByType = {};
  ['premium', 'regular', 'value'].forEach(t => {
    const months = Object.keys(byTypeMonth[t] || {}).filter(m => byTypeMonth[t][m].customers > 0).sort();
    const m = months[months.length - 1];
    if (m) {
      const v = byTypeMonth[t][m];
      priceByType[t] = (v.sales / 1.1) / v.customers;
      monthByType[t] = m;
    } else {
      priceByType[t] = null;
      monthByType[t] = null;
    }
  });
  // 브랜드 전체 값은 기존처럼 "전체 공통 가장 최근 달" 하나로 계산(대부분의 매장형태는 데이터가
  // 같이 들어오므로 문제없고, 개별 매장형태 계산만 위처럼 각자 안전망을 둔다).
  const latestMonth = latestDate.slice(0, 7);
  let totalSales = 0, totalCustomers = 0;
  Object.values(byTypeMonth).forEach(monthMap => {
    const v = monthMap[latestMonth];
    if (v) { totalSales += v.sales; totalCustomers += v.customers; }
  });
  const brandPrice = totalCustomers > 0 ? (totalSales / 1.1) / totalCustomers : null;
  return { priceByType, brandPrice, month: latestMonth, monthByType };
}
async function loadSeasonPilotView() {
  const tbl = $('#seasonPilotTable');
  if (!tbl) return; // 아직 이 탭을 한 번도 안 열었으면 DOM에 없을 수 있음
  const seasonId = state.currentSeasonId;
  const season = state.seasons.find(s => s.id === seasonId);
  if (!seasonId) { tbl.innerHTML = '<tbody><tr><td style="padding:24px;color:var(--muted)">시즌을 선택해주세요.</td></tr></tbody>'; return; }
  tbl.innerHTML = '<tbody><tr><td style="padding:24px;color:var(--muted)">불러오는 중...</td></tr></tbody>';

  const [{ data: pilotRows, error }, priceInfo, salesRes, { data: categorySummary }, targetPrice] = await Promise.all([
    sb.from('season_pilot_menu').select('*').eq('season_id', seasonId),
    getRecentMonthPriceByType(),
    (season?.start_month && season?.end_month)
      ? fetchAllRows('store_sales', q => q.gte('sales_date', season.start_month).lt('sales_date', nextDay(season.end_month)), 'store_code, store_name, sales_total')
      : Promise.resolve({ data: [] }),
    sb.from('category_summary').select('category, target_cost_per_gram, target_consumption_per_person').eq('season_id', seasonId),
    getTargetPrice(seasonId),
  ]);
  if (error) { tbl.innerHTML = `<tbody><tr><td style="padding:24px;color:var(--crit)">${esc(error.message)}</td></tr></tbody>`; return; }

  // 브랜드 값의 가중치 = 이 시즌 실제 매장군별 매출 비중(매장당이 아니라 매장군 전체 합산 매출 기준 —
  // ①비교 피벗의 "브랜드" 열과 같은 방식). 객단가(분모)는 위에서 구한 최근월 실제값을 쓰고, 이 매출
  // 비중(가중치)만 "지금 계획 중인 시즌"의 매장군별 매출 비중을 그대로 쓴다 — 둘은 서로 다른 목적.
  const salesByType = { premium: 0, regular: 0, value: 0 };
  (salesRes.data || []).forEach(r => {
    const t = storeType(r.store_code, r.store_name);
    salesByType[t] = (salesByType[t] || 0) + (Number(r.sales_total) || 0);
  });
  const totalSales = salesByType.premium + salesByType.regular + salesByType.value;

  // "목표" 열 — "시즌설계 › 목표원가"에 입력해둔 조닝별 목표 원가율(category_summary)을 그대로 가져와
  // 보여준다. 매장형태별로는 목표를 따로 안 두므로(시즌 하나에 목표는 하나) 이 열은 항상 단일 값.
  const targetByCategory = new Map();
  // 통합조닝 시절의 낡은 category_summary 행("월남쌈/죽", "음료/디저트" 등)이 남아있을 수 있어,
  // 대시보드/목표원가 탭과 똑같이 현재 조닝 목록(DASHBOARD_CATEGORIES)만 골라 쓴다 — 안 그러면
  // 옛날 통합 행과 새 분리 행이 같이 합산돼 브랜드 목표가 실제보다 높게 잡힌다.
  (categorySummary || []).forEach(r => { if (r.category && DASHBOARD_CATEGORIES.includes(r.category)) targetByCategory.set(r.category, r); });

  seasonPilotCache = {
    pilotRows: pilotRows || [], priceByType: priceInfo?.priceByType || {}, brandPrice: priceInfo?.brandPrice ?? null,
    priceMonth: priceInfo?.month ?? null, monthByType: priceInfo?.monthByType || {}, salesByType, totalSales,
    targetByCategory, targetPrice,
  };
  seasonPilotUndoStack = [];
  renderSeasonPilotTable();
}
function seasonPilotTierAmt(rows, tierKey) {
  const field = SEASON_PILOT_TIERS.find(t => t.key === tierKey).consumptionField;
  return rows.reduce((sum, r) => {
    const consumption = r[field];
    if (consumption == null || consumption === '') return sum; // 빈 칸 = 그 매장형태에서 미운영
    return sum + (Number(r.cost_per_gram) || 0) * Number(consumption);
  }, 0);
}
function seasonPilotTierRatio(rows, tierKey, priceByType) {
  const price = priceByType?.[tierKey];
  if (!price) return null;
  return seasonPilotTierAmt(rows, tierKey) / price * 100;
}
function seasonPilotBrandRatio(rows, data) {
  if (!data.totalSales) return null;
  let weighted = 0;
  SEASON_PILOT_TIERS.forEach(t => {
    const r = seasonPilotTierRatio(rows, t.key, data.priceByType);
    if (r != null) weighted += r * (data.salesByType[t.key] || 0) / data.totalSales;
  });
  return weighted;
}
function renderSeasonPilotTable() {
  const tbl = $('#seasonPilotTable');
  const data = seasonPilotCache;
  if (!tbl || !data) return;
  const priceHint = $('#seasonPilotPriceHint');
  if (priceHint) {
    // 매장형태별로 기준 달이 다를 수 있어서(예: 이번 달 초라 일부만 입력됨), 그 형태 자신의 달을 같이 표시한다.
    const fmtP = key => {
      const p = data.priceByType[key], m = data.monthByType?.[key];
      if (p == null) return '—';
      return m && m !== data.priceMonth ? `${fmtNum(p, 0)}원(${m})` : `${fmtNum(p, 0)}원`;
    };
    priceHint.textContent = data.priceMonth
      ? `기준 객단가(VAT 제외, 매장형태별 최근 실측월 기준): 프리미엄 ${fmtP('premium')} · 일반 ${fmtP('regular')} · 199-229 ${fmtP('value')}`
      : '기준 객단가를 계산할 매출 데이터가 없습니다.';
  }
  const undoBtn = $('#seasonPilotUndoBtn');
  if (undoBtn) undoBtn.disabled = seasonPilotUndoStack.length === 0;
  if (!data.pilotRows.length) {
    tbl.innerHTML = `<tbody><tr><td style="padding:24px;color:var(--muted)">입력된 메뉴가 없습니다. 위에서 메뉴를 입력하고 저장해주세요.</td></tr></tbody>`;
    return;
  }
  const fmtR = r => r != null ? r.toFixed(1) + '%' : '—';
  const byZone = {};
  data.pilotRows.forEach(r => { (byZone[r.category] = byZone[r.category] || []).push(r); });
  const zones = Object.keys(byZone).sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));

  // "목표"열 — 시즌설계 › 목표원가에서 입력한 조닝별 목표 원가율(category_summary)을 그대로 보여준다.
  // 메뉴 단위 목표는 따로 안 두므로(목표는 조닝 단위) 메뉴 행에서는 "—"로 비워둔다.
  const targetRatioForZone = zone => computeCostRatio(data.targetByCategory.get(zone)?.target_cost_per_gram, data.targetByCategory.get(zone)?.target_consumption_per_person, data.targetPrice);
  const brandTarget = weightedTotals([...data.targetByCategory.values()], 'target');
  const brandTargetRatio = computeCostRatio(brandTarget.costPerGram, brandTarget.consumption, data.targetPrice);

  // 존/전체 합계 행은 여러 메뉴를 묶은 값이라 직접 수정할 대상이 없다 — 숫자만 보여준다.
  const tierCells = rows => SEASON_PILOT_TIERS.map(t => `<td>${fmtR(seasonPilotTierRatio(rows, t.key, data.priceByType))}</td>`).join('');
  // 메뉴 행은 season_pilot_menu의 실제 한 행이라, 매장형태별 인당소비량을 원가율 옆에서 바로 고칠 수 있게 한다.
  const tierCellsEditable = r => SEASON_PILOT_TIERS.map(t => {
    const val = r[t.consumptionField];
    const ratio = fmtR(seasonPilotTierRatio([r], t.key, data.priceByType));
    return `<td><input class="pilot-inline-in" type="number" step="any" value="${val ?? ''}" placeholder="g" data-menu="${esc(r.menu_name)}" data-tier="${t.key}" onchange="seasonPilotEditConsumption(this)"> <span class="pivot-d">${ratio}</span></td>`;
  }).join('');

  let H = '<thead><tr><th>존 / 메뉴</th><th>목표</th><th>브랜드</th><th>프리미엄</th><th>일반</th><th>199-229</th></tr></thead><tbody>';
  H += `<tr class="pivot-zone pivot-met"><td>【전체】</td><td>${fmtR(brandTargetRatio)}</td><td>${fmtR(seasonPilotBrandRatio(data.pilotRows, data))}</td>${tierCells(data.pilotRows)}</tr>`;

  zones.forEach(zone => {
    const rows = byZone[zone];
    const zid = 'pilot|' + zone;
    H += `<tr class="pivot-zone" onclick="seasonPilotToggle('${esc(zid)}')"><td>${seasonPilotCollapsed[zid] ? '▸' : '▾'} 【${esc(zone)}】</td><td>${fmtR(targetRatioForZone(zone))}</td><td>${fmtR(seasonPilotBrandRatio(rows, data))}</td>${tierCells(rows)}</tr>`;
    if (seasonPilotCollapsed[zid]) return;
    rows.slice().sort((a, b) => (seasonPilotBrandRatio([b], data) || 0) - (seasonPilotBrandRatio([a], data) || 0))
      .forEach(r => {
        H += `<tr class="pivot-menu"><td title="${esc(r.menu_name)}">　${esc(r.menu_name)} ` +
          `<input class="pilot-inline-in" type="number" step="any" value="${r.cost_per_gram ?? ''}" placeholder="g당원가" data-menu="${esc(r.menu_name)}" onchange="seasonPilotEditCost(this)"></td>` +
          `<td class="pivot-na">—</td><td>${fmtR(seasonPilotBrandRatio([r], data))}</td>${tierCellsEditable(r)}</tr>`;
      });
  });
  H += '</tbody>';
  tbl.innerHTML = H;
}
function seasonPilotToggle(zoneId) { seasonPilotCollapsed[zoneId] = !seasonPilotCollapsed[zoneId]; renderSeasonPilotTable(); }
// 결과 표에서 g당원가/인당소비량을 바로 고치면 화면 재계산과 동시에 DB에도 저장한다 —
// 위쪽 입력 그리드까지 스크롤해서 그 메뉴 줄을 찾아 고치는 게 메뉴가 많아지면 불편해서 추가함.
function seasonPilotEditCost(el) {
  const row = seasonPilotCache?.pilotRows.find(r => r.menu_name === el.dataset.menu);
  if (!row) return;
  seasonPilotUndoStack.push({ rowId: row.id, field: 'cost_per_gram', prevValue: row.cost_per_gram });
  row.cost_per_gram = numOrNull(el.value);
  renderSeasonPilotTable();
  seasonPilotSaveField(row.id, 'cost_per_gram', row.cost_per_gram);
}
function seasonPilotEditConsumption(el) {
  const row = seasonPilotCache?.pilotRows.find(r => r.menu_name === el.dataset.menu);
  const tier = SEASON_PILOT_TIERS.find(t => t.key === el.dataset.tier);
  if (!row || !tier) return;
  seasonPilotUndoStack.push({ rowId: row.id, field: tier.consumptionField, prevValue: row[tier.consumptionField] });
  row[tier.consumptionField] = numOrNull(el.value);
  renderSeasonPilotTable();
  seasonPilotSaveField(row.id, tier.consumptionField, row[tier.consumptionField]);
}
async function seasonPilotSaveField(rowId, field, value) {
  const { error } = await sb.from('season_pilot_menu').update({ [field]: value }).eq('id', rowId);
  if (error) console.error('시즌 파일럿 결과표 수정 저장 실패:', error);
}
// "뒤로가기" — 누를 때마다 스택에서 바로 직전 수정 한 건씩 꺼내 되돌린다(여러 번 누르면 그만큼 더 과거로).
function seasonPilotUndo() {
  const entry = seasonPilotUndoStack.pop();
  if (!entry) return;
  const row = seasonPilotCache?.pilotRows.find(r => r.id === entry.rowId);
  if (row) {
    row[entry.field] = entry.prevValue;
    seasonPilotSaveField(row.id, entry.field, entry.prevValue);
  }
  renderSeasonPilotTable();
}
$('#seasonPilotUndoBtn')?.addEventListener('click', seasonPilotUndo);

async function rebuildCategoryDesignRollup(seasonId) {
  const { data: menus, error } = await sb.from('menu_designs').select('*').eq('season_id', seasonId);
  if (error || !menus) return;
  const targetPrice = await getTargetPrice(seasonId);
  const byCat = {};
  menus.forEach(m => {
    if (!byCat[m.category]) byCat[m.category] = [];
    byCat[m.category].push(m);
  });
  const categoriesWithMenus = new Set(Object.keys(byCat));
  const upserts = DASHBOARD_CATEGORIES.filter(cat => categoriesWithMenus.has(cat)).map((category) => {
    const list = byCat[category];
    const t = weightedTotals(list.map(m => ({
      design_consumption_per_person: m.consumption_per_person,
      design_cost_per_gram: m.cost_per_gram,
    })), 'design');
    return {
      season_id: seasonId, category,
      design_cost_ratio: computeCostRatio(t.costPerGram, t.consumption, targetPrice),
      design_cost_per_gram: t.costPerGram, design_consumption_per_person: t.consumption,
    };
  });
  if (upserts.length) {
    await sb.from('category_summary').upsert(upserts, { onConflict: 'season_id,category' });
  }
}

// =====================================================================
// Tab: 레시피 등록 (BOM) — 시즌과 무관하게 누적되는 메뉴별 자재 비율표
// =====================================================================
// data-col: 0=시즌(텍스트, season_id로 변환) 1=메뉴명 2=카테고리 3=조리후중량 4=자재코드 5=자재명
//           6=환산계수 7=자재단가 8=전처리수율 9=투입중량 10=자재사용량 11=운영패턴(199-229) 12=운영패턴(일반) 13=운영패턴(프리미엄)
const BOM_FIELDS = ['season_name', 'menu_name', 'category', 'cooked_weight', 'material_code', 'material_name',
  'conversion_factor', 'material_price', 'prep_yield', 'input_weight', 'usage_amount', 'availability_pattern_value', 'availability_pattern_regular', 'availability_pattern_premium'];
const BOM_NUMERIC_COLS = [3, 6, 7, 8, 9, 10];

const bomGridBody = $('#bomGridBody');
function addBomRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = BOM_FIELDS.map((f, i) => {
    const isNumeric = BOM_NUMERIC_COLS.includes(i);
    const listAttr = f === 'category' ? 'list="categoryList"' : f === 'season_name' ? 'list="seasonNameList"' : (f === 'availability_pattern_value' || f === 'availability_pattern_regular' || f === 'availability_pattern_premium') ? 'list="patternList"' : '';
    return `<td><input type="${isNumeric ? 'number' : 'text'}" ${isNumeric ? 'step="0.01"' : ''} data-col="${i}" ${listAttr}></td>`;
  }).join('') + `<td><button type="button" class="row-del-btn" title="삭제">×</button></td>`;
  tr.querySelector('.row-del-btn').addEventListener('click', () => tr.remove());
  bomGridBody.appendChild(tr);
  return tr;
}
for (let i = 0; i < 3; i++) addBomRow();
$('#addBomRowBtn').addEventListener('click', () => addBomRow());
attachPasteFill(bomGridBody, addBomRow);

$('#saveBomGridBtn').addEventListener('click', async () => {
  const rows = [];
  const unresolvedSeasons = new Set();
  $$('tr', bomGridBody).forEach(tr => {
    const values = BOM_FIELDS.map((_, i) => tr.querySelector(`input[data-col="${i}"]`).value);
    // 시즌 + 메뉴명 필수, 자재는 코드 또는 이름 중 하나만 있어도 됨 (자재코드가 빈 줄은 다른 레시피를 소스로 참조하는 줄)
    if (!values[0] || !values[1] || (!values[4] && !values[5])) return;
    const seasonName = values[0].trim();
    const season = state.seasons.find(s => s.name === seasonName);
    if (!season) { unresolvedSeasons.add(seasonName); return; }
    const rec = { season_id: season.id };
    BOM_FIELDS.forEach((f, i) => {
      if (f === 'season_name') return;
      rec[f] = BOM_NUMERIC_COLS.includes(i) ? numOrNull(values[i]) : (values[i] ? values[i].trim() : null);
    });
    rec.menu_name = rec.menu_name?.trim();
    rec.category = rec.category ? normalizeCategory(rec.category) : null;
    // 자재코드가 없는 소스/서브레시피 참조 줄은 자재명을 코드 대신 써서, 같은 참조를 재저장할 때 중복이 아니라 덮어쓰기가 되게 함
    if (!rec.material_code && rec.material_name) rec.material_code = rec.material_name;
    rows.push(rec);
  });
  if (unresolvedSeasons.size) {
    flash($('#bomSaveMsg'), `존재하지 않는 시즌명이 있어 저장하지 않았습니다: ${[...unresolvedSeasons].join(', ')} (상단 "+ 새 시즌"으로 먼저 만들어주세요)`, false);
    return;
  }
  if (!rows.length) { flash($('#bomSaveMsg'), '입력된 행이 없습니다.', false); return; }

  // 같은 시즌+메뉴+자재코드 조합이 한 번의 저장에 두 번 이상 들어오면 upsert가 실패하므로 마지막 값만 남기고 병합
  const dedup = new Map();
  rows.forEach(r => dedup.set(`${r.season_id}||${r.menu_name}||${r.material_code}`, r));
  const finalRows = [...dedup.values()];

  const { error } = await sb.from('recipe_items').upsert(finalRows, { onConflict: 'season_id,menu_name,material_code' });
  if (error) { flash($('#bomSaveMsg'), '저장 실패: ' + error.message, false); return; }
  invalidateSeasonCalcCaches();
  bomGridBody.innerHTML = '';
  for (let i = 0; i < 3; i++) addBomRow();
  flash($('#bomSaveMsg'), `${finalRows.length}개 행이 저장되었습니다.${rows.length > finalRows.length ? ` (중복 ${rows.length - finalRows.length}건 병합됨)` : ''}`);
  await loadBomView();
});

let bomViewCache = [];
async function loadBomView() {
  const { data, error } = await fetchAllRows('recipe_items', q => q.order('menu_name', { ascending: true }), '*, seasons(name)');
  if (error) { console.error(error); return; }
  bomViewCache = data || [];

  const seasonSel = $('#bomSeasonFilter');
  const prevVal = seasonSel.value;
  const seasonNames = [...new Set(bomViewCache.map(r => r.seasons?.name).filter(Boolean))];
  seasonSel.innerHTML = `<option value="">전체 시즌</option>` + seasonNames.map(n => `<option value="${n}">${n}</option>`).join('');
  seasonSel.value = seasonNames.includes(prevVal) ? prevVal : '';

  renderBomView();
}

function renderBomView() {
  const search = $('#bomSearch').value.trim();
  const seasonF = $('#bomSeasonFilter').value;
  const rows = bomViewCache.filter(r =>
    (!search || (r.menu_name || '').includes(search)) &&
    (!seasonF || r.seasons?.name === seasonF)
  );
  const body = $('#bomViewBody');
  body.innerHTML = rows.map(r => `
    <tr data-id="${r.id}">
      <td class="col-check"><input type="checkbox" class="row-check"></td>
      <td>${r.seasons?.name ?? '-'}</td>
      <td>${r.menu_name ?? '-'}</td>
      <td>${r.category ?? '-'}</td>
      <td>${fmtNum(r.cooked_weight, 0)}</td>
      <td>${r.material_code ?? '-'}</td>
      <td>${r.material_name ?? '-'}</td>
      <td>${fmtNum(r.conversion_factor, 1)}</td>
      <td>${fmtNum(r.material_price, 0)}</td>
      <td>${r.prep_yield != null ? fmtNum(r.prep_yield, 0) + '%' : '-'}</td>
      <td>${fmtNum(r.input_weight, 1)}</td>
      <td>${fmtNum(r.usage_amount, 1)}</td>
      <td>${r.availability_pattern_value ?? '-'}</td>
      <td>${r.availability_pattern_regular ?? '-'}</td>
      <td>${r.availability_pattern_premium ?? '-'}</td>
    </tr>
  `).join('') || `<tr><td colspan="15" style="text-align:center;color:var(--muted)">등록된 레시피가 없습니다.</td></tr>`;
}

['bomSearch', 'bomSeasonFilter'].forEach(id => {
  $(`#${id}`).addEventListener('input', renderBomView);
  $(`#${id}`).addEventListener('change', renderBomView);
});

$('#bomSelectAll').addEventListener('change', (e) => {
  $$('#bomViewBody .row-check').forEach(cb => { cb.checked = e.target.checked; });
});

$('#bulkDeleteBomBtn').addEventListener('click', async () => {
  const ids = $$('#bomViewBody tr').filter(tr => tr.querySelector('.row-check')?.checked).map(tr => Number(tr.dataset.id));
  if (!ids.length) { flash($('#bomBulkMsg'), '선택된 항목이 없습니다.', false); return; }
  if (!confirm(`${ids.length}개 행을 삭제할까요?`)) return;
  const { error } = await deleteInChunks('recipe_items', ids);
  if (error) { flash($('#bomBulkMsg'), '삭제 실패: ' + error.message, false); return; }
  $('#bomSelectAll').checked = false;
  flash($('#bomBulkMsg'), `${ids.length}개 삭제되었습니다.`);
  await loadBomView();
});

// =====================================================================
// Tab 3: Recipe cumulative log
// =====================================================================
let recipeLogCache = [];
async function loadRecipeLog() {
  const { data, error } = await sb.from('menu_designs').select('*, seasons(name)').order('created_at', { ascending: false });
  if (error) { console.error(error); return; }
  recipeLogCache = data || [];

  const seasonSel = $('#recipeSeasonFilter');
  const catSel = $('#recipeCategoryFilter');
  const seasonNames = [...new Set(recipeLogCache.map(r => r.seasons?.name).filter(Boolean))];
  const cats = [...new Set(recipeLogCache.map(r => r.category).filter(Boolean))];
  seasonSel.innerHTML = '<option value="">전체 시즌</option>' + seasonNames.map(n => `<option value="${n}">${n}</option>`).join('');
  catSel.innerHTML = '<option value="">전체 카테고리</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');

  renderRecipeLog();
}

async function renderRecipeLog() {
  const search = $('#recipeSearch').value.trim().toLowerCase();
  const seasonF = $('#recipeSeasonFilter').value;
  const catF = $('#recipeCategoryFilter').value;
  const rows = recipeLogCache.filter(r =>
    (!search || r.menu_name?.toLowerCase().includes(search)) &&
    (!seasonF || r.seasons?.name === seasonF) &&
    (!catF || r.category === catF)
  );
  const seasonIds = [...new Set(rows.map(r => r.season_id))];
  await Promise.all(seasonIds.map(sid => getTargetPrice(sid)));

  const body = $('#recipeLogBody');
  body.innerHTML = rows.map(r => {
    const targetPrice = state.targetPriceBySeasonId[r.season_id] ?? (r.season_id === state.currentSeasonId ? state.seasonTarget?.target_price_per_person : null);
    const ratio = computeCostRatio(r.cost_per_gram, r.consumption_per_person, targetPrice);
    return `
    <tr data-id="${r.id}" data-season-id="${r.season_id}">
      <td class="col-check"><input type="checkbox" class="row-check"></td>
      <td>${r.seasons?.name ?? '-'}</td>
      <td class="cell-left"><input class="cell-input" data-field="category" value="${r.category ?? ''}" list="categoryList"></td>
      <td class="cell-left"><input class="cell-input" data-field="menu_name" value="${r.menu_name ?? ''}"></td>
      <td class="computed-ratio-cell">${fmtPct(ratio)}</td>
      <td><input class="cell-input" type="number" step="0.01" data-field="cost_per_gram" value="${r.cost_per_gram ?? ''}"></td>
      <td><input class="cell-input" type="number" step="1" data-field="consumption_per_person" value="${r.consumption_per_person ?? ''}"></td>
      <td class="cell-left"><input class="cell-input" data-field="availability_pattern_value" value="${r.availability_pattern_value ?? ''}" list="patternList"></td>
      <td class="cell-left"><input class="cell-input" data-field="availability_pattern_regular" value="${r.availability_pattern_regular ?? ''}" list="patternList"></td>
      <td class="cell-left"><input class="cell-input" data-field="availability_pattern_premium" value="${r.availability_pattern_premium ?? ''}" list="patternList"></td>
      <td class="col-check"><button type="button" class="row-del-btn" title="삭제">×</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="11" style="text-align:center;color:var(--muted)">데이터가 없습니다.</td></tr>`;

  $$('input.cell-input', body).forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const tr = e.target.closest('tr');
      const id = Number(tr.dataset.id);
      const seasonId = Number(tr.dataset.seasonId);
      const field = e.target.dataset.field;
      const isText = field === 'category' || field === 'menu_name' || field === 'availability_pattern_value' || field === 'availability_pattern_regular' || field === 'availability_pattern_premium';
      const value = field === 'category' ? normalizeCategory(e.target.value) : isText ? (e.target.value.trim() || null) : numOrNull(e.target.value);
      const payload = { [field]: value };
      if (field === 'cost_per_gram' || field === 'consumption_per_person') {
        const gramInp = $('input[data-field="cost_per_gram"]', tr);
        const consInp = $('input[data-field="consumption_per_person"]', tr);
        const nextGram = field === 'cost_per_gram' ? value : numOrNull(gramInp.value);
        const nextCons = field === 'consumption_per_person' ? value : numOrNull(consInp.value);
        payload.cost_ratio = computeCostRatio(nextGram, nextCons, await getTargetPrice(seasonId));
      }
      const { error } = await sb.from('menu_designs').update(payload).eq('id', id);
      if (error) { alert('수정 실패: ' + error.message); return; }
      await rebuildCategoryDesignRollup(seasonId);
      if (seasonId === state.currentSeasonId) await loadDashboard();
      await loadRecipeLog();
    });
  });

  $$('.row-del-btn', body).forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const tr = e.target.closest('tr');
      const id = Number(tr.dataset.id);
      const seasonId = Number(tr.dataset.seasonId);
      if (!confirm('이 메뉴를 삭제할까요?')) return;
      const { error } = await sb.from('menu_designs').delete().eq('id', id);
      if (error) { alert('삭제 실패: ' + error.message); return; }
      await rebuildCategoryDesignRollup(seasonId);
      if (seasonId === state.currentSeasonId) await loadDashboard();
      await loadRecipeLog();
    });
  });
}
['recipeSearch', 'recipeSeasonFilter', 'recipeCategoryFilter'].forEach(id => {
  $(`#${id}`).addEventListener('input', renderRecipeLog);
  $(`#${id}`).addEventListener('change', renderRecipeLog);
});

$('#recipeSelectAll').addEventListener('change', (e) => {
  $$('#recipeLogBody .row-check').forEach(cb => { cb.checked = e.target.checked; });
});

$('#bulkDeleteRecipeBtn').addEventListener('click', async () => {
  const trs = $$('#recipeLogBody tr').filter(tr => tr.querySelector('.row-check')?.checked);
  if (!trs.length) { flash($('#recipeBulkMsg'), '선택된 항목이 없습니다.', false); return; }
  if (!confirm(`${trs.length}개 메뉴를 삭제할까요?`)) return;
  const ids = trs.map(tr => Number(tr.dataset.id));
  const affectedSeasonIds = [...new Set(trs.map(tr => Number(tr.dataset.seasonId)))];
  const { error } = await deleteInChunks('menu_designs', ids);
  if (error) { flash($('#recipeBulkMsg'), '삭제 실패: ' + error.message, false); return; }
  await Promise.all(affectedSeasonIds.map(sid => rebuildCategoryDesignRollup(sid)));
  if (affectedSeasonIds.includes(state.currentSeasonId)) await loadDashboard();
  $('#recipeSelectAll').checked = false;
  flash($('#recipeBulkMsg'), `${ids.length}개 삭제되었습니다.`);
  await loadRecipeLog();
});

// ---- generic smooth-curve SVG path helper (reused by produce monitoring chart) ----
function buildSmoothPath(points) {
  if (points.length < 2) return '';
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? i : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

// =====================================================================
// Tab: Menu consumption (메뉴별 소비액)
// 메뉴명·g당원가는 설계원가 탭(menu_designs)의 현재 시즌 데이터를 그대로 반영하고,
// 인당소비량만 이 탭에서 입력받아 menu_consumption에 저장한다.
// =====================================================================
let menuConsumptionRowsCache = [];
async function loadMenuConsumptionView() {
  if (!state.currentSeasonId) return;
  const [{ data: designs, error: designErr }, { data: consumption, error: consErr }, { data: recipeMenus }] = await Promise.all([
    fetchAllRows('menu_designs', q => q.eq('season_id', state.currentSeasonId).order('created_at', { ascending: true })),
    fetchAllRows('menu_consumption', q => q.eq('season_id', state.currentSeasonId)),
    fetchAllRows('recipe_items', q => q.eq('season_id', state.currentSeasonId), 'menu_name, category'),
  ]);
  if (designErr || consErr) { console.error(designErr || consErr); return; }

  // 같은 메뉴명이 여러 번 저장됐으면 가장 최근 값을 그 메뉴의 현재 설계원가로 사용
  const byMenu = new Map();
  (designs || []).forEach(m => { if (m.menu_name) byMenu.set(m.menu_name, m); });
  // 레시피(recipe_items)는 있는데 목표원가에 아직 등록 안 된 메뉴는(설계 단계를 건너뛰고 바로 레시피부터
  // 등록한 경우) 여기서 통째로 빠지는 문제가 있었다 — 실제 원가/소비량이 계산되는데도 이 표에 안 보여서
  // 대시보드 합계에서도 조용히 누락됐음. 최소한 이름·조닝만이라도 채워서(설계원가는 비워둠) 빠지지 않게 한다.
  (recipeMenus || []).forEach(r => {
    if (!r.menu_name || r.menu_name.startsWith('#') || byMenu.has(r.menu_name)) return;
    byMenu.set(r.menu_name, { menu_name: r.menu_name, category: r.category, cost_per_gram: null });
  });
  const consumptionByMenu = Object.fromEntries((consumption || []).map(c => [c.menu_name, c]));
  const seasonName = state.seasons.find(s => s.id === state.currentSeasonId)?.name ?? '-';

  const targetPrice = state.seasonTarget?.target_price_per_person ?? null;
  menuConsumptionRowsCache = [...byMenu.values()].map(m => {
    const c = consumptionByMenu[m.menu_name];
    const consumptionPerPerson = c?.consumption_per_person ?? null;
    const actualCostPerGram = c?.actual_cost_per_gram ?? null;
    const effectiveCostPerGram = actualCostPerGram ?? m.cost_per_gram;
    const value = (effectiveCostPerGram != null && consumptionPerPerson != null) ? effectiveCostPerGram * consumptionPerPerson : null;
    // 원가율은 메뉴마다 운영패턴(상시/디너·주말/주말)이 달라 손님 수 분모가 다르므로, consumption_per_person이 아니라
    // 시즌 전체 손님 수 기준으로 통일한 consumption_per_person_brand로 계산해야 메뉴 간 비교가 정확하다
    // (그렇지 않으면 주말·디너 한정 메뉴의 원가율이 실제보다 부풀려져 보인다 — 카테고리 실적 합산 때와 같은 이유).
    const costRatio = computeCostRatio(effectiveCostPerGram, c?.consumption_per_person_brand ?? null, targetPrice);
    return {
      menu_name: m.menu_name, category: m.category, cost_per_gram: m.cost_per_gram,
      actual_cost_per_gram: actualCostPerGram, cost_source: c?.cost_source ?? null, cost_month: c?.cost_month ?? null,
      consumption_per_person: consumptionPerPerson,
      consumption_per_person_excl_water: c?.consumption_per_person_excl_water ?? null,
      value, cost_ratio: costRatio, seasonName,
      consumption_source: c?.consumption_source ?? null, confidence: c?.confidence ?? null,
    };
  });

  renderMenuConsumptionView();
}

const CONSUMPTION_SOURCE_LABEL = {
  exact: { label: '확정값', cls: 'pill-good' },
  allocated: { label: '추정값(신뢰)', cls: 'pill-warn' },
  partial: { label: '추정값(일부매장)', cls: 'pill-warn' },
  design_fallback: { label: '추정값(낮음)', cls: 'pill-crit' },
  no_data: { label: '데이터없음', cls: 'pill-crit' },
};

const COST_SOURCE_LABEL = {
  actual: { label: '실단가', cls: 'pill-good' },
  partial: { label: '일부실단가', cls: 'pill-warn' },
  estimated: { label: '추정단가(장기평균)', cls: 'pill-warn' },
  design_fallback: { label: '레시피단가', cls: 'pill-crit' },
};

function renderMenuConsumptionView() {
  const sortMode = $('#menuConsumptionSortSelect').value;
  const rows = menuConsumptionRowsCache.slice().sort((a, b) => {
    if (sortMode === 'cost_per_gram') return (b.cost_per_gram ?? -Infinity) - (a.cost_per_gram ?? -Infinity);
    if (sortMode === 'consumption') return (b.consumption_per_person ?? -Infinity) - (a.consumption_per_person ?? -Infinity);
    if (sortMode === 'value') return (b.value ?? -Infinity) - (a.value ?? -Infinity);
    return (a.category || '').localeCompare(b.category || '', 'ko');
  });

  const body = $('#menuConsumptionViewBody');
  body.innerHTML = rows.map(m => {
    const src = CONSUMPTION_SOURCE_LABEL[m.consumption_source];
    const badge = src
      ? `<span class="${src.cls}">${src.label}${m.confidence != null ? ` ${m.confidence}%` : ''}</span>`
      : '<span style="color:var(--muted)">-</span>';
    const costSrc = COST_SOURCE_LABEL[m.cost_source];
    // cost_month는 이제 시즌 전체 기간 평균이라 "2025-11~2026-03"처럼 범위로 올 수 있어, 각 쪽을 월 단위로 줄인다.
    const costMonthLabel = m.cost_month
      ? (m.cost_month.includes('~') ? m.cost_month.split('~').map(x => x.slice(0, 7)).join('~') : m.cost_month.slice(0, 7))
      : null;
    const costBadge = costSrc
      ? `<span class="${costSrc.cls}">${fmtNum(m.actual_cost_per_gram, 2)}</span>${costMonthLabel ? ` <span class="hint">${costMonthLabel}</span>` : ''}`
      : '<span style="color:var(--muted)">-</span>';
    return `
    <tr data-menu="${m.menu_name}">
      <td>${m.seasonName}</td>
      <td>${m.category ?? '-'}</td>
      <td class="cell-left">${m.menu_name}</td>
      <td>${fmtNum(m.cost_per_gram, 2)}</td>
      <td>${costBadge}</td>
      <td>${fmtWithExclWater(m.consumption_per_person, m.consumption_per_person_excl_water, 1)}</td>
      <td>${badge}</td>
      <td>${m.value != null ? fmtNum(m.value, 0) : '-'}</td>
      <td>${m.cost_ratio != null ? m.cost_ratio.toFixed(1) + '%' : '-'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="9" style="text-align:center;color:var(--muted)">설계원가 탭에 저장된 메뉴가 없습니다.</td></tr>`;
}

$('#menuConsumptionSortSelect').addEventListener('change', renderMenuConsumptionView);

// =====================================================================
// Tab: 메뉴 진단 (4분면 + 긴급도)
// menuConsumptionRowsCache를 그대로 재사용 — 새 DB 조회 없음.
// =====================================================================
// cls는 KPI 타일(.kpi-tile.is-*)용, pillCls는 표 셀(.data-table td.pill-*)용 — 같은 색 의미를 두 군데 다른 클래스로 낸다.
const QUADRANT_META = {
  A: { label: '고단가·고취식', cls: 'is-crit', pillCls: 'pill-crit' },
  B: { label: '저단가·고취식', cls: 'is-good', pillCls: 'pill-good' },
  C: { label: '고단가·저취식', cls: 'is-warn', pillCls: 'pill-warn' },
  D: { label: '저단가·저취식', cls: '', pillCls: '' },
};
const URGENCY_TIERS = ['즉시', '우선', '검토', '낮음'];
// 이 조닝들은 대부분 자재 1개짜리 단독메뉴라 손댈 수 있는 방법이 g당단가(공급처 협상) 하나뿐이라
// "메뉴 진단"(자재 조합을 바꿔볼 여지가 있는 메뉴 찾기)의 대상에서 뺀다.
const MENU_DIAGNOSIS_EXCLUDED_CATEGORIES = ['축산', '야채', '소스', '토핑', '육수'];

// menuConsumptionRowsCache 행에서 원가율 계산과 동일한 "유효 g당원가"를 뽑아 4분면/긴급도용 행을 만든다.
function computeMenuDiagnosisQuadrants(rows) {
  const diagRows = rows
    .map(m => ({
      menu_name: m.menu_name, category: m.category,
      costPerGram: m.actual_cost_per_gram ?? m.cost_per_gram,
      consumption: m.consumption_per_person,
      value: m.value,
    }))
    .filter(r => r.costPerGram != null && r.consumption != null && r.value != null)
    .filter(r => !MENU_DIAGNOSIS_EXCLUDED_CATEGORIES.includes(r.category));

  const medianCost = median(diagRows.map(r => r.costPerGram));
  const medianConsumption = median(diagRows.map(r => r.consumption));

  diagRows.forEach(r => {
    const highCost = r.costPerGram >= medianCost;
    const highConsumption = r.consumption >= medianConsumption;
    r.quadrant = highCost && highConsumption ? 'A' : highConsumption ? 'B' : highCost ? 'C' : 'D';
  });

  const totalValue = diagRows.reduce((a, r) => a + r.value, 0);
  const quadrantSummary = {};
  Object.keys(QUADRANT_META).forEach(q => {
    const inQ = diagRows.filter(r => r.quadrant === q);
    const qValue = inQ.reduce((a, r) => a + r.value, 0);
    quadrantSummary[q] = { count: inQ.length, totalValue: qValue, pct: totalValue > 0 ? qValue / totalValue * 100 : 0 };
  });

  return { diagRows, medianCost, medianConsumption, quadrantSummary };
}

// 객당원가(value) 기준 백분위수로 긴급도를 매긴다. 시즌마다 물가 수준이 달라지므로 고정 금액(예: "70원 이상")
// 대신 상대적 기준(P90/P75/P50)을 쓴다.
function computeUrgencyTiers(diagRows) {
  const sortedValues = diagRows.map(r => r.value).sort((a, b) => a - b);
  const p90 = percentile(sortedValues, 0.9), p75 = percentile(sortedValues, 0.75), p50 = percentile(sortedValues, 0.5);
  diagRows.forEach(r => {
    r.tier = r.value >= p90 ? '즉시' : r.value >= p75 ? '우선' : r.value >= p50 ? '검토' : '낮음';
  });
  return { p90, p75, p50 };
}

// menuDiagnosisCache/렌더 함수는 "메뉴 진단" 탭 자체를 없애면서 같이 정리함 — computeMenuDiagnosisQuadrants·
// computeUrgencyTiers(위)는 VE 탭이 그대로 재사용하므로 남겨둔다.

// =====================================================================
// 레시피 기반 메뉴별 인당소비량 자동계산 엔진
// =====================================================================

// recipe_items를 서브레시피(자재코드 없이 다른 메뉴명을 참조하는 줄)까지 재귀적으로 원자재 단위로 풀어낸다.
async function flattenRecipesForSeason(seasonId) {
  const { data: recipeRows, error } = await fetchAllRows('recipe_items', q => q.eq('season_id', seasonId));
  if (error) { console.error(error); return null; }
  const byMenu = new Map();
  (recipeRows || []).forEach(r => {
    if (!byMenu.has(r.menu_name)) byMenu.set(r.menu_name, []);
    byMenu.get(r.menu_name).push(r);
  });
  const menuNameSet = new Set(byMenu.keys());
  const cookedWeightByMenu = new Map();
  byMenu.forEach((rows, name) => cookedWeightByMenu.set(name, rows[0]?.cooked_weight ?? null));
  // 운영패턴(상시/디너·주말/주말) — 인당소비량 계산 시 분모(객수)를 이 메뉴가 실제로 팔릴 수 있었던
  // 시간대의 객수로 좁히는 데 쓰인다. 199-229/일반/프리미엄 매장이 서로 다른 패턴을 가질 수 있어 매장타입별로 따로 저장.
  // 안 정해져 있으면 상시로 간주(기존 동작과 동일).
  const availabilityPatternByMenu = new Map();
  byMenu.forEach((rows, name) => availabilityPatternByMenu.set(name, {
    value: rows[0]?.availability_pattern_value || '상시',
    regular: rows[0]?.availability_pattern_regular || '상시',
    premium: rows[0]?.availability_pattern_premium || '상시',
  }));
  // 메뉴 진단 탭에서 "같은 조닝의 다른 메뉴가 쓰는 저가 자재" 후보를 찾을 때 씀
  const categoryByMenu = new Map();
  byMenu.forEach((rows, name) => categoryByMenu.set(name, rows[0]?.category ?? null));

  const rawMaterialNameByCode = new Map(); // 원자재 코드 -> 레시피에 등록된 자재명 (자재 매칭 후보 탐색에 사용)
  const memo = new Map();
  function flatten(menuName, visiting) {
    if (memo.has(menuName)) return memo.get(menuName);
    if (visiting.has(menuName)) return new Map(); // 순환 참조 방지
    visiting.add(menuName);
    const result = new Map();
    (byMenu.get(menuName) || []).forEach(r => {
      const code = r.material_code;
      const amount = Number(r.usage_amount) || 0;
      if (!code || !amount) return;
      if (menuNameSet.has(code) && code !== menuName) {
        // 서브레시피(소스 등) 참조 -> 재귀적으로 원자재로 전개
        const subCookedWeight = cookedWeightByMenu.get(code);
        if (!subCookedWeight) return;
        const scale = amount / subCookedWeight;
        flatten(code, visiting).forEach((g, rawCode) => result.set(rawCode, (result.get(rawCode) || 0) + g * scale));
      } else {
        result.set(code, (result.get(code) || 0) + amount);
        if (!rawMaterialNameByCode.has(code)) rawMaterialNameByCode.set(code, r.material_name || code);
      }
    });
    visiting.delete(menuName);
    memo.set(menuName, result);
    return result;
  }

  const finalMenus = [...menuNameSet].filter(n => !n.startsWith('#'));
  const flatByMenu = new Map();
  finalMenus.forEach(name => flatByMenu.set(name, flatten(name, new Set())));
  return { flatByMenu, cookedWeightByMenu, finalMenus, rawMaterialNameByCode, availabilityPatternByMenu, categoryByMenu };
}

// ---- 시즌 단위(레시피 전개·실제g당원가) 계산 캐싱 ----
// 비교/전매장/시계열 탭이 탭을 바꾸거나 기간(월/주)만 바꿔도 매번 flattenRecipesForSeason +
// computeActualCostPerGram(레시피 재조회 + 자재단가 RPC + 별칭조회 등 5개 이상 쿼리)을 처음부터
// 다시 돌려서 체감 속도가 느렸다. 이 계산은 seasonId에만 의존하고(기간 필터와 무관), 종료된
// 시즌은 실적이 다시 바뀌지 않으므로 세션 내내 재사용해도 안전하다. 진행 중 시즌은 자재사용량이
// 계속 들어오므로 일정 시간(TTL)마다만 새로 계산해서 최신성과 속도를 절충한다.
const SEASON_CALC_TTL_MS = 2 * 60 * 1000;
const flatCache = new Map(); // seasonId -> { ts, promise }
const costCache = new Map(); // seasonId -> { ts, promise }
const costByStoreCache = new Map(); // seasonId -> { ts, promise } — 매장별 실제 g당원가(②③ 피벗 전용)
function seasonCacheGet(seasonId, cache) {
  const entry = cache.get(seasonId);
  if (!entry) return null;
  const season = state.seasons.find(s => s.id === seasonId);
  if (!(season && isSeasonClosed(season)) && Date.now() - entry.ts > SEASON_CALC_TTL_MS) return null;
  return entry.promise;
}
function getFlatForSeason(seasonId) {
  const cached = seasonCacheGet(seasonId, flatCache);
  if (cached) return cached;
  const p = flattenRecipesForSeason(seasonId);
  flatCache.set(seasonId, { ts: Date.now(), promise: p });
  return p;
}
function getActualCostPerGram(seasonId) {
  const cached = seasonCacheGet(seasonId, costCache);
  if (cached) return cached;
  const p = computeActualCostPerGram(seasonId);
  costCache.set(seasonId, { ts: Date.now(), promise: p });
  return p;
}
function getActualCostPerGramByStore(seasonId) {
  const cached = seasonCacheGet(seasonId, costByStoreCache);
  if (cached) return cached;
  const p = computeActualCostPerGramByStore(seasonId);
  costByStoreCache.set(seasonId, { ts: Date.now(), promise: p });
  return p;
}
// 레시피(BOM)나 자재 별칭을 저장하면 위 캐시가 낡은 값을 들고 있게 되므로, 저장 시점에 통째로 비운다
// (어느 시즌이 영향받는지 매번 정확히 추적하는 것보다, 전체를 비우고 다음 조회에서 다시 계산하는
// 편이 훨씬 단순하고 안전 — 비용도 탭 하나 다시 여는 정도라 무시할만함).
// pivot_snapshot(종료 시즌 피벗 결과 캐시)도 자재/레시피 값에 의존하는데 만료 기준이 없어서(종료
// 시즌은 "다시 안 바뀐다"는 전제로 영구 캐시) 여기서 같이 비워주지 않으면, 별칭을 새로 확정하거나
// 레시피를 고쳐도 ①②③ 탭이 예전 계산값을 계속 보여주는 문제가 생긴다(실제로 겪음 — 자재 별칭
// 확정 후 "메뉴별 소비액"엔 반영됐는데 피벗 탭만 그대로였음). 종료 시즌 결과는 캐시일 뿐이라
// 지워도 다음 조회 때 다시 계산해서 채워지므로 안전하다.
// Promise를 반환하도록 해서, "피벗 최신화" 버튼처럼 삭제가 끝난 뒤에 바로 재계산을 이어가야 하는
// 곳에서는 await로 순서를 보장하고, 기존 호출부(레시피/별칭 저장 후)처럼 굳이 안 기다려도 되는
// 곳은 그냥 호출만 해도 되게 한다.
function invalidateSeasonCalcCaches() {
  flatCache.clear();
  costCache.clear();
  costByStoreCache.clear();
  return sb.from('pivot_snapshot').delete().gt('id', 0).then(({ error }) => { if (error) console.error('pivot_snapshot 캐시 삭제 실패:', error); });
}

// ---- 자재명 유사도 (브랜드/공급처가 바뀌어 자재코드가 달라진 경우를 후보로 찾기 위함) ----
// keepParenContent=false: 괄호와 그 안 내용을 통째로 제거 (브랜드가 괄호로 앞에 붙는 경우, 예: "(참고을)참기름")
// keepParenContent=true : 괄호만 지우고 안의 글자는 남김 (핵심 단어가 괄호 안에 있는 경우, 예: "자숙스지(소스지:미국산)")
// 둘 중 하나로만 정하면 반대 케이스에서 오탐/누락이 생겨서, 두 방식 다 계산해 더 유사한 쪽을 쓴다.
function cleanMaterialName(s, keepParenContent) {
  let t = (s || '');
  t = keepParenContent ? t.replace(/[()\[\]{}]/g, ' ') : t.replace(/\([^)]*\)/g, ' ');
  t = t.replace(/[\d.]+\s*(kg|g|l|lt|ml|box|팩|입|개|ea)\b/gi, ' '); // 숫자+단위 규격 제거
  t = t.replace(/-[가-힣A-Za-z0-9]*TC\b/gi, ' '); // 끝에 붙는 "-공급업체TC" 코드 제거
  return t.replace(/[\s()\[\]{}\-_,./:]/g, '');
}
function longestCommonSubstring(a, b) {
  let maxLen = 0, endA = 0;
  let prevRow = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const curRow = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        curRow[j] = prevRow[j - 1] + 1;
        if (curRow[j] > maxLen) { maxLen = curRow[j]; endA = i; }
      }
    }
    prevRow = curRow;
  }
  return { len: maxLen, startA: endA - maxLen };
}
function longestCommonSubstringLength(a, b) {
  return longestCommonSubstring(a, b).len;
}
// 대파/부추/두부처럼 2글자짜리 핵심 식자재명은 후보로 살리되, "감자+전분", "가지+소스",
// "자몽+에이드베이스", "배추+김치"처럼 원자재명 뒤에 가공 표시어가 붙어 전혀 다른 가공품이 된
// 경우는 걸러내기 위한 목록 (자재 매칭 후보는 사용자가 한 번 더 확인하고 확정하는 화면이라,
// 여기서 다 걸러내지 못해도 최종 확인 단계에서 걸러진다)
const PROCESSED_NAME_MARKERS = ['소스', '전분', '에이드', '베이스', '김치', '잼', '시럽', '드레싱', '즙', '액상', '분말', '농축액', '과자', '치즈', '요거트', '아이스크림', '크림', '스프레드', '피클', '절임', '장아찌'];
function hasProcessedMarkerInRemainder(clean, matchStart, matchLen) {
  const remainder = clean.slice(0, matchStart) + clean.slice(matchStart + matchLen);
  return PROCESSED_NAME_MARKERS.some(m => remainder.includes(m));
}
function materialNameSimilarity(a, b) {
  if (!a || !b) return 0;
  const variantsA = [cleanMaterialName(a, false), cleanMaterialName(a, true)];
  const variantsB = [cleanMaterialName(b, false), cleanMaterialName(b, true)];
  let best = 0;
  variantsA.forEach(cleanA => {
    variantsB.forEach(cleanB => {
      if (!cleanA || !cleanB) return;
      if (cleanA === cleanB) { best = Math.max(best, 1); return; }
      const { len: lcsLen, startA } = longestCommonSubstring(cleanA, cleanB);
      // 1글자만 겹치는 건 우연의 일치일 뿐이라 제외
      if (lcsLen < 2) return;
      if (lcsLen === 2) {
        // 2글자 매칭은 "기름/소스/육수" 같은 흔한 종류어 우연 일치일 위험이 커서,
        // 매칭 안 된 나머지 부분에 가공 표시어가 있으면 다른 가공품으로 보고 제외
        if (hasProcessedMarkerInRemainder(cleanA, startA, lcsLen)) return;
        const posB = cleanB.indexOf(cleanA.slice(startA, startA + lcsLen));
        if (posB >= 0 && hasProcessedMarkerInRemainder(cleanB, posB, lcsLen)) return;
      }
      best = Math.max(best, lcsLen / Math.min(cleanA.length, cleanB.length));
    });
  });
  return best;
}
// 부분적으로만 겹치는 경우(팽이버섯 vs 백목이버섯처럼 "버섯"만 같은 경우 등) 오탐이 많아서,
// 둘 중 짧은 이름이 긴 이름 안에 거의 통째로 들어있는 경우(완전포함)만 후보로 올린다.
const MATERIAL_ALIAS_THRESHOLD = 0.9;

// 레시피 원자재들과 이름이 비슷한, 다른 코드로 쓰인 자재를 자재사용량에서 찾아 후보로 제시
async function findMaterialAliasCandidates() {
  const seasonId = state.currentSeasonId;
  if (!seasonId) return [];
  const flat = await flattenRecipesForSeason(seasonId);
  if (!flat) return [];
  const { rawMaterialNameByCode } = flat;

  const { data: usageRows } = await fetchAllRows('material_usage', q => applySeasonDateFilter(q, 'period_end'));
  const usageByCode = new Map();
  (usageRows || []).forEach(r => {
    if (!r.material_code) return;
    const grams = (Number(r.actual_usage_qty) || 0) * (Number(r.conversion_factor) || 0);
    if (!usageByCode.has(r.material_code)) usageByCode.set(r.material_code, { name: r.material_name, grams: 0 });
    usageByCode.get(r.material_code).grams += grams;
  });

  const { data: existingAliases } = await sb.from('material_aliases').select('primary_material_code, alt_material_code');
  const decided = new Set((existingAliases || []).map(a => `${a.primary_material_code}||${a.alt_material_code}`));

  const candidates = [];
  rawMaterialNameByCode.forEach((recipeName, code) => {
    usageByCode.forEach((info, altCode) => {
      if (altCode === code || !info.grams) return;
      if (decided.has(`${code}||${altCode}`)) return;
      const sim = materialNameSimilarity(recipeName, info.name);
      if (sim >= MATERIAL_ALIAS_THRESHOLD) {
        candidates.push({
          primary_material_code: code, primary_material_name: recipeName,
          alt_material_code: altCode, alt_material_name: info.name,
          alt_usage_grams: info.grams, similarity: sim,
        });
      }
    });
  });
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates;
}

let aliasCandidatesCache = [];
function renderAliasCandidates() {
  const body = $('#aliasCandidatesBody');
  body.innerHTML = aliasCandidatesCache.map((c, i) => `
    <tr data-idx="${i}">
      <td class="cell-left">${c.primary_material_name} <span class="hint">(${c.primary_material_code})</span></td>
      <td class="cell-left">${c.alt_material_name} <span class="hint">(${c.alt_material_code})</span></td>
      <td>${fmtNum(c.alt_usage_grams, 0)}</td>
      <td>${Math.round(c.similarity * 100)}%</td>
      <td>
        <button type="button" class="btn btn-sm btn-primary alias-confirm-btn">같은 자재</button>
        <button type="button" class="btn btn-sm btn-ghost alias-reject-btn">다른 자재</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="5" style="text-align:center;color:var(--muted)">찾은 후보가 없습니다.</td></tr>`;

  const decide = async (idx, status) => {
    const c = aliasCandidatesCache[idx];
    const { error } = await sb.from('material_aliases').upsert({
      primary_material_code: c.primary_material_code, primary_material_name: c.primary_material_name,
      alt_material_code: c.alt_material_code, alt_material_name: c.alt_material_name, status,
    }, { onConflict: 'primary_material_code,alt_material_code' });
    if (error) { flash($('#aliasCandidatesMsg'), '저장 실패: ' + error.message, false); return; }
    invalidateSeasonCalcCaches();
    aliasCandidatesCache = aliasCandidatesCache.filter((_, i) => i !== idx);
    renderAliasCandidates();
    flash($('#aliasCandidatesMsg'), status === 'confirmed'
      ? '같은 자재로 등록했습니다. "인당소비량 자동계산"을 다시 눌러 반영하세요.'
      : '다른 자재로 표시했습니다 (다시 안 뜹니다).');
  };
  $$('.alias-confirm-btn', body).forEach(btn => {
    btn.addEventListener('click', () => decide(Number(btn.closest('tr').dataset.idx), 'confirmed'));
  });
  $$('.alias-reject-btn', body).forEach(btn => {
    btn.addEventListener('click', () => decide(Number(btn.closest('tr').dataset.idx), 'rejected'));
  });
}

$('#findAliasCandidatesBtn').addEventListener('click', async () => {
  const btn = $('#findAliasCandidatesBtn');
  btn.disabled = true;
  try {
    flash($('#aliasCandidatesMsg'), '찾는 중...');
    aliasCandidatesCache = await findMaterialAliasCandidates();
    renderAliasCandidates();
    flash($('#aliasCandidatesMsg'), `${aliasCandidatesCache.length}건 발견`);
  } finally {
    btn.disabled = false;
  }
});

// 공유자재 그룹(cluster) 하나를 반복적 비례배분(IPF)으로 푼다.
// materialUsers: Map<자재코드, Map<메뉴명, a비율(=그램/조리후중량)>>, residualByMaterial: Map<자재코드, 잔여실사용g>
function ipfSolveCluster(menuNames, materialUsers, residualByMaterial, initialWeights) {
  const x = {};
  menuNames.forEach(m => { x[m] = initialWeights[m] > 0 ? initialWeights[m] : 1; });
  const materials = [...materialUsers.keys()];

  for (let iter = 0; iter < 80; iter++) {
    materials.forEach(mat => {
      const users = materialUsers.get(mat);
      const target = residualByMaterial.get(mat) ?? 0;
      let predicted = 0;
      users.forEach((aRatio, m) => { predicted += aRatio * x[m]; });
      if (predicted > 1e-9 && target > 0) {
        const factor = target / predicted;
        users.forEach((_, m) => { x[m] *= factor; });
      } else if (target <= 0) {
        users.forEach((_, m) => { x[m] *= 0.7; }); // 근거가 없으면 서서히 0에 수렴
      }
    });
  }

  let errSum = 0, targetSum = 0;
  materials.forEach(mat => {
    const users = materialUsers.get(mat);
    const target = residualByMaterial.get(mat) ?? 0;
    let predicted = 0;
    users.forEach((aRatio, m) => { predicted += aRatio * x[m]; });
    errSum += Math.abs(predicted - target);
    targetSum += Math.abs(target);
  });
  const confidence = targetSum > 0 ? Math.max(0, Math.min(1, 1 - errSum / targetSum)) : 0;
  return { x, confidence };
}

// 자재 실사용 근거(actualByMaterial: 자재그룹대표코드 -> 그램)를 받아 메뉴별 "총 생산 그램"을
// 전용자재(1단계) → 공유자재 IPF배분(2단계) 순으로 추정한다. 매장 전체 실사용량을 넣으면 브랜드 계산,
// 특정 매장 실사용량만 넣으면 그 매장만의 계산이 되는 매장 무관 공용 함수.
// onNoEvidence(menu): 그 자재 근거로는 도저히 추정이 안 되는 메뉴에 대한 콜백 (브랜드/매장이 서로 다르게 처리하기 위해 분리)
function estimateGramsProduced({ flatByMenu, cookedWeightByMenu, finalMenus, find, materialToMenus, clusterGramsInMenu, designByMenu }, actualByMaterial, onNoEvidence, unavailableMenus) {
  const gramsProducedByMenu = new Map();
  const sourceByMenu = new Map();
  const confidenceByMenu = new Map();

  // unavailableMenus: 이 매장 등급(199-229/일반/프리미엄)에서 운영패턴상 아예 안 파는 메뉴 목록.
  // 이런 메뉴는 완전히 배제하고(값 자체를 매기지 않음 — 데이터없음 처리는 그대로 유지),
  // 그 메뉴와 자재를 공유하던 다른 메뉴는 "이 매장에선 사실상 전용자재"가 되어 정확히 계산되게 한다
  // (예: 199매장은 닭강정을 안 팔아서, 공유자재인 치킨이 그 매장에선 후라이드순살치킨 전용이 됨).
  const activeMenus = unavailableMenus && unavailableMenus.size ? finalMenus.filter(m => !unavailableMenus.has(m)) : finalMenus;

  // ---- 1단계: 전용자재 메뉴 ----
  // 전용자재가 여러 개면 레시피상 자재사용량(gramsPerBatch) 크기로 가중평균한다(=cookedWeight*ΣU/ΣgramsPerBatch).
  // 예전엔 단순평균이라, 0.3g짜리 가니시 자재처럼 분모가 극히 작은 자재의 추정치(실사용량 계량오차에
  // 극도로 민감)가 220g짜리 주자재 추정치와 동일한 발언권을 가져 전체가 크게 왜곡됐다
  // (예: 도지마롤 — 데코화이트 0.3g 때문에 인당소비량이 2.7g이 아니라 38g으로 잡혔던 사례).
  const unknownMenus = [];
  activeMenus.forEach(menu => {
    const flatBOM = flatByMenu.get(menu);
    const cookedWeight = cookedWeightByMenu.get(menu);
    if (!flatBOM.size || !cookedWeight) { unknownMenus.push(menu); return; }
    const exclusiveKeys = [...new Set([...flatBOM.keys()].map(find))].filter(key => {
      const users = materialToMenus.get(key);
      if (!users) return false;
      const activeUserCount = unavailableMenus && unavailableMenus.size ? [...users].filter(u => !unavailableMenus.has(u)).length : users.size;
      return activeUserCount === 1;
    });
    let sumU = 0, sumGramsPerBatch = 0;
    exclusiveKeys.forEach(key => {
      const U = actualByMaterial.get(key);
      const gramsPerBatch = clusterGramsInMenu(menu, key);
      if (U != null && gramsPerBatch > 0) { sumU += U; sumGramsPerBatch += gramsPerBatch; }
    });
    if (sumGramsPerBatch > 0) {
      gramsProducedByMenu.set(menu, sumU * cookedWeight / sumGramsPerBatch);
      sourceByMenu.set(menu, 'exact');
    } else {
      unknownMenus.push(menu);
    }
  });

  // ---- 2단계: 공유자재 메뉴 (연결된 그룹별로 IPF) ----
  const menuNeighbors = new Map();
  unknownMenus.forEach(m => menuNeighbors.set(m, new Set()));
  unknownMenus.forEach(menu => {
    (flatByMenu.get(menu) || new Map()).forEach((grams, code) => {
      const users = materialToMenus.get(find(code));
      if (!users || users.size < 2) return;
      [...users].filter(u => menuNeighbors.has(u)).forEach(u => {
        if (u !== menu) { menuNeighbors.get(menu).add(u); menuNeighbors.get(u).add(menu); }
      });
    });
  });

  const visited = new Set();
  const clusters = [];
  unknownMenus.forEach(start => {
    if (visited.has(start)) return;
    const cluster = [];
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const cur = queue.shift();
      cluster.push(cur);
      menuNeighbors.get(cur).forEach(n => { if (!visited.has(n)) { visited.add(n); queue.push(n); } });
    }
    clusters.push(cluster);
  });

  clusters.forEach(cluster => {
    const materialUsers = new Map();
    cluster.forEach(menu => {
      const flatBOM = flatByMenu.get(menu) || new Map();
      const cookedWeight = cookedWeightByMenu.get(menu);
      if (!cookedWeight) return;
      const keysSeen = new Set([...flatBOM.keys()].map(find));
      keysSeen.forEach(key => {
        const users = materialToMenus.get(key);
        if (!users || users.size < 2) return;
        if (!materialUsers.has(key)) materialUsers.set(key, new Map());
        materialUsers.get(key).set(menu, clusterGramsInMenu(menu, key) / cookedWeight);
      });
    });

    if (!materialUsers.size) { cluster.forEach(onNoEvidence); return; }

    // 잔여 사용량 = 실제사용량 - 이미 확정된(1단계) 메뉴들이 쓴 만큼
    const residualByMaterial = new Map();
    materialUsers.forEach((_, key) => {
      const U = actualByMaterial.get(key) || 0;
      let consumedByKnown = 0;
      (materialToMenus.get(key) || new Set()).forEach(m => {
        if (gramsProducedByMenu.has(m) && sourceByMenu.get(m) === 'exact') {
          const g = clusterGramsInMenu(m, key);
          const cw = cookedWeightByMenu.get(m);
          if (cw) consumedByKnown += gramsProducedByMenu.get(m) * (g / cw);
        }
      });
      residualByMaterial.set(key, Math.max(0, U - consumedByKnown));
    });

    // 설계원가 탭의 인당소비량을 초기 가중치로 사용 (없으면 균등 배분에서 시작)
    const initialWeights = {};
    cluster.forEach(menu => {
      const d = designByMenu.get(menu);
      initialWeights[menu] = d?.consumption_per_person > 0 ? d.consumption_per_person : 0;
    });

    const { x, confidence } = ipfSolveCluster(cluster, materialUsers, residualByMaterial, initialWeights);
    cluster.forEach(menu => {
      // 이 메뉴가 걸쳐 있는 자재들이 전부 잔여사용량 0이면(=실사용 근거 없음) IPF가 0으로 수렴시키는 대신 onNoEvidence로 위임
      const flatBOM = flatByMenu.get(menu) || new Map();
      const hasEvidence = [...new Set([...flatBOM.keys()].map(find))].some(key => materialUsers.has(key) && (residualByMaterial.get(key) || 0) > 1e-6);
      if (!hasEvidence) { onNoEvidence(menu); return; }
      // 신뢰도(confidence)가 낮다는 건 IPF 배분 결과가 실제 자재사용 패턴을 거의 설명 못 한다는 뜻이라,
      // x값 자체가 수백만g처럼 발산해버릴 수 있다(실측: 무관한 메뉴 20여 개가 한 그룹으로 얽힌 경우
      // confidence 0.00~0.08에 x가 수천만~수억g으로 튐). 예전엔 이럴 때 'design_fallback'이라는 딱지만
      // 붙이고 발산한 값을 그대로 썼는데, 그 값을 실제 설계값으로 바꿔치기하는 코드가 없어서 사실상
      // "낮음" 표시만 된 틀린 숫자가 그대로 쓰이고 있었다. 신뢰도 낮은 배분값은 아예 버리고 "근거 없음"과
      // 동일하게 처리해서(onNoEvidence) 이 매장은 이 메뉴 데이터없음으로 남기고, 다른 매장 데이터나
      // 브랜드 전체 안전망(설계값 대체)으로 넘어가게 한다.
      if (confidence < 0.6) { onNoEvidence(menu); return; }
      gramsProducedByMenu.set(menu, Math.max(0, x[menu] || 0));
      sourceByMenu.set(menu, 'allocated');
      confidenceByMenu.set(menu, Math.round(confidence * 100));
    });
  });

  return { gramsProducedByMenu, sourceByMenu, confidenceByMenu };
}

// 메뉴별 인당소비량을 "매장별로 먼저 취합한 뒤 브랜드로 합산"하는 방식으로 계산한다.
// (예전에는 전 매장 실사용량을 하나로 합쳐서 한 번에 배분했는데, 그러면 디너/주말 메뉴가 덜 들어가는 일부
//  매장의 편차가 브랜드 평균에 왜곡되어 반영되고, 매장별 이상값도 구분할 수 없었음)
// dateRange({start,end}, 둘 다 'YYYY-MM-DD')를 주면 시즌 선택과 무관하게 그 기간의 자재사용량·매출로 계산한다
// (피벗 탭 전용 — 레시피/설계원가는 그 기간을 포함하는 시즌 것을 자동으로 찾아 쓴다).
// 생략하면 기존처럼 현재 선택된 시즌 기준으로 계산한다(기존 호출부는 전부 이 경로 그대로).
function findSeasonIdForDate(dateStr) {
  if (!dateStr) return null;
  const hit = state.seasons.find(s => s.start_month && s.end_month && s.start_month <= dateStr && dateStr <= s.end_month);
  if (hit) return hit.id;
  // 그 기간을 정확히 포함하는 시즌이 없으면(신설 시즌 경계 밖 등) 시작월이 가장 늦은 시즌으로 대체한다.
  const withRange = state.seasons.filter(s => s.start_month);
  if (!withRange.length) return state.currentSeasonId;
  return withRange.reduce((a, b) => (a.start_month > b.start_month ? a : b)).id;
}
// brandOnly=true면 매장별 IPF(가장 느린 부분, 17개 매장×반복계산)를 건너뛰고 전 매장 실사용량을 한 번에
// 합쳐 브랜드 전체 그램만 계산한다 — 시계열 탭처럼 짧은 기간을 여러 번(주차별·월별) 반복 계산해야 할 때 씀.
// 매장별 세부값은 못 주지만, 브랜드 전체 원가율/존별 소비액은 정확하다(레퍼런스도 존별 분해는 브랜드만 제공).
async function computeMenuConsumption(onProgress, dateRange, brandOnly) {
  let seasonId, applyRange;
  if (dateRange) {
    seasonId = findSeasonIdForDate(dateRange.end);
    applyRange = (q, field) => q.gte(field, dateRange.start).lt(field, nextDay(dateRange.end));
  } else {
    seasonId = state.currentSeasonId;
    applyRange = (q, field) => applySeasonDateFilter(q, field);
  }
  if (!seasonId) return { error: '시즌이 선택되지 않았습니다.' };

  const flat = await flattenRecipesForSeason(seasonId);
  if (!flat) return { error: '레시피 데이터를 불러오지 못했습니다.' };
  const { flatByMenu, cookedWeightByMenu, finalMenus, availabilityPatternByMenu } = flat;

  const [{ data: usageRows, error: usageErr }, { data: salesRows, error: salesErr }, { data: designRows }, aliasRes] = await Promise.all([
    fetchAllRows('material_usage', q => applyRange(q, 'period_end'), 'store_code, store_name, material_code, actual_usage_qty, conversion_factor'),
    fetchAllRows('store_sales', q => applyRange(q, 'sales_date'), 'store_code, store_name, customers_total, customers_dinner, is_holiday, sales_total'),
    fetchAllRows('menu_designs', q => q.eq('season_id', seasonId)),
    sb.from('material_aliases').select('primary_material_code, alt_material_code').eq('status', 'confirmed'),
  ]);
  if (usageErr || salesErr) return { error: '자재사용량/매출 데이터를 불러오지 못했습니다.' };
  const confirmedAliases = aliasRes.data;

  // ---- 매장과 무관한, 레시피에서만 나오는 구조는 한 번만 계산 ----
  // 브랜드/공급처가 바뀌어 다른 코드로 쓰인 것으로 확정된 자재들을 "그룹"으로 묶는다 (union-find로 중복 합산 방지).
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  (confirmedAliases || []).forEach(a => union(a.primary_material_code, a.alt_material_code));

  const designByMenu = new Map();
  (designRows || []).forEach(d => { if (d.menu_name) designByMenu.set(d.menu_name, d); });

  // 자재별로 그 자재를 쓰는 최종메뉴 목록 (전용자재 판별용) — 레시피 구조에서만 나오므로 매장 무관.
  const materialToMenus = new Map();
  finalMenus.forEach(menu => {
    (flatByMenu.get(menu) || new Map()).forEach((grams, code) => {
      const key = find(code);
      if (!materialToMenus.has(key)) materialToMenus.set(key, new Set());
      materialToMenus.get(key).add(menu);
    });
  });

  function clusterGramsInMenu(menu, key) {
    let total = 0;
    (flatByMenu.get(menu) || new Map()).forEach((grams, code) => { if (find(code) === key) total += grams; });
    return total;
  }

  function waterRatio(menu) {
    const bom = flatByMenu.get(menu);
    const cookedWeight = cookedWeightByMenu.get(menu);
    if (!bom || !cookedWeight) return 0;
    const waterGrams = WATER_CODES.reduce((a, code) => a + (bom.get(code) || 0), 0);
    return Math.min(1, waterGrams / cookedWeight);
  }

  const recipeCtx = { flatByMenu, cookedWeightByMenu, finalMenus, find, materialToMenus, clusterGramsInMenu, designByMenu };

  // 자재실사용 행들을 받아 별칭그룹 기준 합계(actualByMaterial)를 만든다 (브랜드 전체든 매장 하나든 동일 로직).
  function buildActualByMaterial(rows) {
    const ownUsageByCode = new Map();
    rows.forEach(r => {
      if (!r.material_code) return;
      const grams = (Number(r.actual_usage_qty) || 0) * (Number(r.conversion_factor) || 0);
      ownUsageByCode.set(r.material_code, (ownUsageByCode.get(r.material_code) || 0) + grams);
    });
    const clusterTotal = new Map();
    ownUsageByCode.forEach((grams, code) => {
      const rep = find(code);
      clusterTotal.set(rep, (clusterTotal.get(rep) || 0) + grams);
    });
    const allCodes = new Set(ownUsageByCode.keys());
    (confirmedAliases || []).forEach(a => { allCodes.add(a.primary_material_code); allCodes.add(a.alt_material_code); });
    const actualByMaterial = new Map();
    allCodes.forEach(code => actualByMaterial.set(code, clusterTotal.get(find(code)) || 0));
    return actualByMaterial;
  }

  // ---- 매장 목록 및 매장별 실사용량/객수 ----
  const storeMap = new Map();
  const usageByStore = new Map();
  (usageRows || []).forEach(r => {
    if (!r.store_code) return;
    storeMap.set(r.store_code, r.store_name || r.store_code);
    if (!usageByStore.has(r.store_code)) usageByStore.set(r.store_code, []);
    usageByStore.get(r.store_code).push(r);
  });
  // 운영패턴별 객수 — "상시"는 전체 객수, "디너/주말"은 평일 저녁객수+휴일 전체객수, "주말"은 휴일 전체객수만.
  // is_holiday가 "휴일"이면 토/일과 공휴일을 모두 주말 취급(매출/객수 탭 입력 기준과 동일).
  const PATTERNS = ['상시', '디너/주말', '주말'];
  const emptyPatternBucket = () => ({ '상시': 0, '디너/주말': 0, '주말': 0 });
  const customersByStorePattern = new Map();
  (salesRows || []).forEach(r => {
    if (!r.store_code) return;
    storeMap.set(r.store_code, r.store_name || r.store_code);
    if (!customersByStorePattern.has(r.store_code)) customersByStorePattern.set(r.store_code, emptyPatternBucket());
    const bucket = customersByStorePattern.get(r.store_code);
    const total = Number(r.customers_total) || 0;
    const dinner = Number(r.customers_dinner) || 0;
    const isWeekend = r.is_holiday === '휴일';
    bucket['상시'] += total;
    bucket['주말'] += isWeekend ? total : 0;
    bucket['디너/주말'] += isWeekend ? total : dinner;
  });
  const storeCodes = [...storeMap.keys()];

  // 매장 등급(199-229/일반/프리미엄)별로 운영패턴이 "(없음)"인 메뉴 목록 — 그 등급에선 아예 안 파는 메뉴.
  // IPF에 넘겨서 그 메뉴를 배제하면, 같이 자재를 쓰던 다른 메뉴가 그 등급에서는 사실상 전용자재가 되어
  // 억지 반반배분 대신 정확한 값을 얻는다 (예: 199매장의 닭강정↔후라이드순살치킨 공유 치킨).
  const unavailableMenusByTier = { value: new Set(), regular: new Set(), premium: new Set() };
  finalMenus.forEach(menu => {
    const p = availabilityPatternByMenu.get(menu);
    if (!p) return;
    // 운영패턴은 "상시/디너주말/주말" 요일 구분을 없애고 O(판매)/X(미판매)로 단순화했다(2026-08-27).
    // patternFor()는 'O'가 PATTERNS 목록에 없어 자동으로 '상시'(전체 손님) 취급으로 떨어지므로 별도 수정 불필요.
    ['value', 'regular', 'premium'].forEach(tier => { if (p[tier] === 'X') unavailableMenusByTier[tier].add(menu); });
  });

  // ---- 매장별로 각각 1단계(전용자재)+2단계(IPF) 계산. 그 매장에 근거가 전혀 없는 메뉴는 "데이터없음"으로 남겨둔다 ----
  // 매장 수만큼 IPF를 반복 계산하느라 시간이 걸려서, 매장 사이마다 한 틱씩 양보해 브라우저가 멈춘 것처럼 보이지 않게 하고
  // 진행 상황을 onProgress로 알려준다.
  const perStore = [];
  if (!brandOnly) {
    for (let i = 0; i < storeCodes.length; i++) {
      const storeCode = storeCodes[i];
      if (onProgress) onProgress(i + 1, storeCodes.length, storeMap.get(storeCode));
      await new Promise(r => setTimeout(r, 0));
      const actualByMaterial = buildActualByMaterial(usageByStore.get(storeCode) || []);
      const tier = storeType(storeCode, storeMap.get(storeCode));
      const { gramsProducedByMenu, sourceByMenu, confidenceByMenu } = estimateGramsProduced(recipeCtx, actualByMaterial, () => {}, unavailableMenusByTier[tier]);
      perStore.push({
        store_code: storeCode, store_name: storeMap.get(storeCode), store_type: storeType(storeCode, storeMap.get(storeCode)),
        customersByPattern: customersByStorePattern.get(storeCode) || emptyPatternBucket(),
        gramsProducedByMenu, sourceByMenu, confidenceByMenu,
      });
    }
  }

  // ---- 브랜드 전체(전 매장 실사용량 합)는 안전망 용도로만 계산 — 모든 매장에서 데이터없음인 메뉴에 한해 설계값 대체 ----
  const totalCustomers = (salesRows || []).reduce((a, r) => a + (Number(r.customers_total) || 0), 0);
  const totalSales = (salesRows || []).reduce((a, r) => a + (Number(r.sales_total) || 0), 0);
  const pricePerCustomer = totalCustomers ? totalSales / totalCustomers : null;

  const consumptionOverrideByMenu = new Map();
  const wholeBrandPass = estimateGramsProduced(recipeCtx, buildActualByMaterial(usageRows || []), (menu) => {
    const d = designByMenu.get(menu);
    if (d?.consumption_per_person > 0) consumptionOverrideByMenu.set(menu, d.consumption_per_person);
  });

  if (brandOnly) {
    return {
      brandOnly: true,
      gramsProducedByMenu: wholeBrandPass.gramsProducedByMenu,
      designByMenu, totalCustomers, totalSales,
    };
  }

  // ---- 메뉴별로 매장 결과를 취합해 브랜드값을 만든다 (실사용 근거가 있는 매장만 분자/분모에 반영) ----
  // 분모(객수)는 메뉴의 운영패턴에 맞는 객수를 쓴다 — 자재사용량은 월 단위라 그램(분자)은 못 쪼개지만,
  // "이 메뉴를 살 수 있었던 손님 수"로 나누면 상시가 아닌 메뉴의 인당소비량이 실제에 가깝게 잡힌다.
  const results = finalMenus.map(menu => {
    const wr = waterRatio(menu);
    const patternsForMenu = availabilityPatternByMenu.get(menu) || { value: '상시', regular: '상시', premium: '상시' };
    const patternFor = (type) => {
      const p = type === 'value' ? patternsForMenu.value : type === 'premium' ? patternsForMenu.premium : patternsForMenu.regular;
      return PATTERNS.includes(p) ? p : '상시';
    };
    let sumGrams = 0, sumCustomers = 0, fullPatternCustomers = 0, storesWithData = 0, anyAllocated = false;
    const perStoreOut = perStore.map(s => {
      const grams = s.gramsProducedByMenu.get(menu);
      const hasData = grams != null;
      const storeCustomers = s.customersByPattern[patternFor(s.store_type)] || 0;
      fullPatternCustomers += storeCustomers; // 그 매장에 이 메뉴의 실사용 데이터가 없어도, 이 메뉴를 살 수 있었던 손님 수는 항상 누적한다
      if (hasData) {
        sumGrams += grams; sumCustomers += storeCustomers; storesWithData++;
        if (s.sourceByMenu.get(menu) === 'allocated') anyAllocated = true;
      }
      const cpp = (hasData && storeCustomers > 0) ? grams / storeCustomers : null;
      return {
        store_code: s.store_code, store_name: s.store_name, store_type: s.store_type,
        consumption_per_person: cpp,
        consumption_per_person_excl_water: cpp != null ? cpp * (1 - wr) : null,
        consumption_source: hasData ? s.sourceByMenu.get(menu) : 'no_data',
        confidence: hasData ? (s.confidenceByMenu.get(menu) ?? null) : null,
        grams: hasData ? grams : null, store_customers: storeCustomers, // 피벗 탭에서 매장군(일반/199-229) 합산용
      };
    });

    let consumption_per_person = null, consumption_source = null, confidence = null;
    if (storesWithData > 0 && sumCustomers > 0) {
      consumption_per_person = sumGrams / sumCustomers;
      consumption_source = storesWithData < storeCodes.length ? 'partial' : (anyAllocated ? 'allocated' : 'exact');
      confidence = Math.round(100 * storesWithData / storeCodes.length);
    } else if (consumptionOverrideByMenu.has(menu)) {
      consumption_per_person = consumptionOverrideByMenu.get(menu);
      consumption_source = 'design_fallback';
      confidence = 0;
    }
    // 카테고리/브랜드 합산 전용 값 — 메뉴마다 다른 운영패턴 손님 수로 나누면(위 consumption_per_person)
    // 서로 다른 분모를 그냥 더하는 셈이 되어 주말·디너 한정 메뉴가 있는 쪽이 과대 반영된다.
    // 합산할 때는 항상 시즌 전체 손님 수로 나눈 값을 써야 분모가 통일되어 정확히 더해진다.
    // consumption_per_person(그 메뉴를 실제로 판 매장들만의 인당소비율)에 "이 메뉴를 살 수 있었던 전체 손님 수"
    // (데이터가 없는 매장 포함, fullPatternCustomers)를 곱해 브랜드 전체 그램으로 추정한 뒤 시즌 전체 손님 수로 나눈다.
    // (grams/totalCustomers로 직접 나누면 일부 매장만 데이터가 있는 메뉴의 분자가 과소해져 값이 크게 깎인다 — 실측 버그.)
    const consumption_per_person_brand = (consumption_per_person != null && totalCustomers > 0)
      ? consumption_per_person * fullPatternCustomers / totalCustomers
      : null;

    return {
      menu_name: menu,
      consumption_per_person,
      consumption_per_person_excl_water: consumption_per_person != null ? consumption_per_person * (1 - wr) : null,
      consumption_per_person_brand,
      consumption_per_person_brand_excl_water: consumption_per_person_brand != null ? consumption_per_person_brand * (1 - wr) : null,
      consumption_source,
      confidence,
      availability_pattern_value: patternsForMenu.value,
      availability_pattern_regular: patternsForMenu.regular,
      availability_pattern_premium: patternsForMenu.premium,
      stores_with_data: storesWithData,
      stores_total: storeCodes.length,
      per_store: perStoreOut,
    };
  });

  return { results, totalCustomers, totalSales, pricePerCustomer };
}

// 자재코드 -> "실제 g당단가"를 계산하는 로직만 따로 뗀 함수. 시즌 내 자재사용량 데이터가 있는 가장 최근
// 달의 브랜드 전체 가중평균 단가(실사용금액 ÷ 실사용량)를 우선 쓰고, 그 달에 실사용 근거가 없는 자재는
// 레시피 등록 단가(최초 1회성 수기입력, 원/kg -> 원/g 환산)로 대체한다. computeActualCostPerGram과
// 메뉴 진단 탭(자재별 원가 기여도 분석)이 이 로직을 공유한다.
async function buildMaterialPriceResolver(seasonId) {
  const season = state.seasons.find(s => s.id === seasonId);
  if (!season?.start_month || !season?.end_month) return { error: '시즌 기간 정보가 없습니다.' };
  const rangeStart = season.start_month, rangeEnd = nextDay(season.end_month);

  // 특정 한 달(예: 가장 최근 달)만 보면 그 달에만 가격이 급등/급락했을 때 시즌 전체 실단가가 왜곡된다
  // (예: 5월에 폭등했다가 7월에 폭락하면, 마지막 달만 볼 땐 폭락한 가격만 반영되고 5월의 높은 단가는
  // 전혀 반영이 안 됨). 그래서 시즌 시작~끝 전체 기간의 실사용량을 다 모아 가중평균하는데, 시즌 하나에
  // material_usage 행이 수만~수십만 개라 그걸 다 받아서 브라우저에서 합치면 너무 느려진다(실측 20분+) —
  // Postgres RPC로 자재코드별 합계를 DB에서 미리 내서(자재 종류 수만큼만, 보통 수백 행) 받는다.
  const [{ data: usageRows, error: usageErr }, { data: recipeRows }, aliasRes, minMonthRes, maxMonthRes] = await Promise.all([
    sb.rpc('material_usage_totals_for_range', { p_start: rangeStart, p_end: rangeEnd }),
    fetchAllRows('recipe_items', q => q.eq('season_id', seasonId), 'material_code, material_price'),
    sb.from('material_aliases').select('primary_material_code, primary_material_name, alt_material_code, alt_material_name').eq('status', 'confirmed'),
    sb.from('material_usage').select('usage_month').gte('period_end', rangeStart).lt('period_end', rangeEnd)
      .not('usage_month', 'is', null).order('usage_month', { ascending: true }).limit(1).maybeSingle(),
    sb.from('material_usage').select('usage_month').gte('period_end', rangeStart).lt('period_end', rangeEnd)
      .not('usage_month', 'is', null).order('usage_month', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (usageErr) return { error: usageErr.message || String(usageErr) };
  if (!usageRows || !usageRows.length) return { error: '자재사용량 데이터가 없습니다.' };
  const minMonth = minMonthRes.data?.usage_month, maxMonth = maxMonthRes.data?.usage_month;
  const costMonth = minMonth && maxMonth ? (minMonth === maxMonth ? minMonth : `${minMonth}~${maxMonth}`) : null;
  const confirmedAliases = aliasRes.data;

  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  (confirmedAliases || []).forEach(a => union(a.primary_material_code, a.alt_material_code));

  // 별칭그룹(대표코드) 단위로 시즌 전체 총 사용금액/총 그램을 모아 가중평균 g당단가를 만든다.
  // usageRows는 RPC가 자재코드별로 이미 합산해서 준 것(원본 구매행이 아니라 자재 종류 수만큼만 있음).
  const costByCluster = new Map(), gramsByCluster = new Map();
  (usageRows || []).forEach(r => {
    if (!r.material_code || !r.total_grams) return;
    const grams = Number(r.total_grams) || 0;
    if (!grams) return;
    const key = find(r.material_code);
    gramsByCluster.set(key, (gramsByCluster.get(key) || 0) + grams);
    costByCluster.set(key, (costByCluster.get(key) || 0) + (Number(r.total_amount) || 0));
  });
  const realPricePerGram = new Map(); // 대표코드 -> 원/g (시즌 전체 기간 브랜드 전체 가중평균)
  gramsByCluster.forEach((grams, key) => { if (grams > 0) realPricePerGram.set(key, costByCluster.get(key) / grams); });
  // 코드 하나하나의 실제 단가(클러스터로 뭉치기 전) — "이 자재에 연결된 자재들 각각 얼마인지" 보여줄 때 씀.
  const rawCodePricePerGram = new Map();
  (usageRows || []).forEach(r => { if (r.material_code && r.total_grams > 0) rawCodePricePerGram.set(r.material_code, (Number(r.total_amount) || 0) / Number(r.total_grams)); });
  // 별칭그룹 대표코드 -> 그 그룹에 속한 모든 원본 코드 (자재별 단가 대체용, 자재 연결 목록 표시용 둘 다 씀)
  const clusterMembers = new Map();
  const aliasNameByCode = new Map();
  (confirmedAliases || []).forEach(a => {
    [[a.primary_material_code, a.primary_material_name], [a.alt_material_code, a.alt_material_name]].forEach(([code, name]) => {
      const root = find(code);
      if (!clusterMembers.has(root)) clusterMembers.set(root, new Set());
      clusterMembers.get(root).add(code);
      if (name) aliasNameByCode.set(code, name);
    });
  });

  // 시즌 안에 실사용 근거가 전혀 없는 자재만, 시즌 시작 전 6개월 구매기록 평균으로 보완한다("헷징" 추정) —
  // 시즌 기간이 짧아서(예: 1주일치만 등록) 그 안에 안 산 자재가 많을 때, 메뉴 전체가 통째로 계산에서
  // 빠지는 걸 줄이기 위함. 시즌 내 실단가보다는 신뢰도가 낮지만, 레시피 등록 단가(1회성 수기입력, 검증
  // 안 됨)보다는 실제 구매 근거가 있어 훨씬 낫다. 시즌 레시피가 실제로 쓰는 자재만 조회한다.
  const codesNeedingExtended = [...new Set((recipeRows || []).map(r => r.material_code))]
    .filter(c => c && !realPricePerGram.has(find(c)));
  const extendedPricePerGram = new Map();
  if (codesNeedingExtended.length && season?.start_month) {
    const expandedCodes = new Set();
    codesNeedingExtended.forEach(c => {
      expandedCodes.add(c);
      (clusterMembers.get(find(c)) || []).forEach(m => expandedCodes.add(m));
    });
    const expandedList = [...expandedCodes];
    const sixMonthsAgoDate = new Date(season.start_month);
    sixMonthsAgoDate.setMonth(sixMonthsAgoDate.getMonth() - 6);
    const sixMonthsAgo = sixMonthsAgoDate.toISOString().slice(0, 10);
    let extRows = [];
    const CH = 25;
    for (let i = 0; i < expandedList.length; i += CH) {
      const batch = expandedList.slice(i, i + CH);
      const { data } = await fetchAllRows(
        'material_usage',
        q => q.in('material_code', batch).gte('usage_month', sixMonthsAgo).lt('usage_month', season.start_month),
        'material_code, actual_usage_qty, actual_usage_amount, conversion_factor'
      );
      extRows = extRows.concat(data || []);
    }
    const gByCluster = new Map(), cByCluster = new Map();
    extRows.forEach(r => {
      if (!r.material_code || !r.actual_usage_qty) return;
      const grams = Number(r.actual_usage_qty) * (Number(r.conversion_factor) || 0);
      if (!grams) return;
      const key = find(r.material_code);
      gByCluster.set(key, (gByCluster.get(key) || 0) + grams);
      cByCluster.set(key, (cByCluster.get(key) || 0) + (Number(r.actual_usage_amount) || 0));
    });
    gByCluster.forEach((grams, key) => { if (grams > 0) extendedPricePerGram.set(key, cByCluster.get(key) / grams); });
  }

  // 레시피 등록 단가(원/kg 기준으로 입력돼있어 1000으로 나눠 원/g로 맞춤)는 실단가·장기평균 둘 다 없는
  // 자재의 마지막 대체값으로만 사용.
  const fallbackPriceByCode = new Map();
  (recipeRows || []).forEach(r => {
    if (r.material_code && r.material_price != null && !fallbackPriceByCode.has(r.material_code)) {
      fallbackPriceByCode.set(r.material_code, Number(r.material_price) / 1000);
    }
  });

  function priceForCode(code) {
    const real = realPricePerGram.get(find(code));
    if (real != null) return { price: real, isReal: true, isExtended: false };
    const ext = extendedPricePerGram.get(find(code));
    if (ext != null) return { price: ext, isReal: false, isExtended: true };
    const fb = fallbackPriceByCode.get(code);
    if (fb != null) return { price: fb, isReal: false, isExtended: false };
    return null;
  }

  return { priceForCode, find, realPricePerGram, extendedPricePerGram, fallbackPriceByCode, costMonth, rawCodePricePerGram, clusterMembers, aliasNameByCode };
}

// 메뉴별 "실제 g당원가"를 계산한다. buildMaterialPriceResolver로 얻은 자재별 단가를 레시피 BOM에 곱해
// 메뉴 단위로 합산한다.
async function computeActualCostPerGram(seasonId) {
  const flat = await getFlatForSeason(seasonId);
  if (!flat) return { error: '레시피 데이터를 불러오지 못했습니다.' };
  const { flatByMenu, cookedWeightByMenu, finalMenus } = flat;

  const pricing = await buildMaterialPriceResolver(seasonId);
  if (pricing.error) return pricing;
  const { priceForCode, costMonth, rawCodePricePerGram, clusterMembers, aliasNameByCode, find } = pricing;

  const results = finalMenus.map(menu => {
    const bom = flatByMenu.get(menu);
    const cookedWeight = cookedWeightByMenu.get(menu);
    if (!bom?.size || !cookedWeight) return { menu_name: menu, actual_cost_per_gram: null, cost_source: null };

    let totalCost = 0, totalGrams = 0, realGrams = 0, groundedGrams = 0;
    bom.forEach((grams, code) => {
      const p = priceForCode(code);
      if (p) totalCost += grams * p.price;
      // 물은 원가가 항상 0원이라 구매 근거(real/extended)가 있든 없든 최종 원가에 영향이 없다 —
      // 물을 많이 쓰는 국물류 메뉴가 실제로는 문제없는데도 "가격 근거 부족"으로 원가가 안 뜨는 걸
      // 막기 위해, 신뢰도 비율(분모) 계산에서는 물 그램수를 아예 빼고 본다.
      if (WATER_CODES.includes(code)) return;
      totalGrams += grams;
      if (!p) return;
      if (p.isReal) realGrams += grams;
      if (p.isReal || p.isExtended) groundedGrams += grams;
    });

    // "실제 구매 근거(이번 달 실단가 + 장기평균 헷징단가)로 확보된" 비중이 95% 미만이면(근거 없는 레시피
    // 등록 단가로 대체된 부분이 5%를 넘으면) 신뢰할 수 없다고 보고 비워둔다. (레시피 등록 단가는 최초
    // 1회성 수기입력이라 검증된 적이 없어서, 대체 비중이 크면 엉뚱한 값을 그대로 실적에 반영하게 됨)
    const realRatio = totalGrams > 0 ? realGrams / totalGrams : 0;
    const groundedRatio = totalGrams > 0 ? groundedGrams / totalGrams : 0;
    if (totalGrams <= 0 || groundedRatio < 0.95) {
      return { menu_name: menu, actual_cost_per_gram: null, cost_source: null };
    }
    return {
      menu_name: menu,
      actual_cost_per_gram: totalCost / cookedWeight,
      cost_source: realRatio >= 0.999 ? 'actual' : (realRatio >= 0.95 ? 'partial' : 'estimated'),
    };
  });

  return { results, costMonth, rawCodePricePerGram, clusterMembers, aliasNameByCode, find };
}

// RPC(material_usage_totals_for_range_by_store)는 PostgREST 기본 응답 상한(1000행)에 걸릴 수 있어서
// (자재종류수 x 매장수가 쉽게 1000을 넘음) .range()로 끝까지 페이지네이션한다.
async function fetchAllRpcPages(fnName, args, pageSize = 1000) {
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.rpc(fnName, args).range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return { data: all, error: null };
}

// buildMaterialPriceResolver의 매장별 버전. 매장마다 실제 사들이는 공급처/코드가 달라서
// (예: 수도권은 직송 저가, 지방은 구매팀 경유 고가) 브랜드 전체 평균 단가 하나로는
// 매장별 원가율이 부정확해진다 — ②모델별비교/③전매장처럼 매장 단위로 쪼개서 보는 화면 전용.
// 대시보드/카테고리 롤업 등 브랜드 전체 지표는 기존 buildMaterialPriceResolver(브랜드 평균)를 그대로 쓴다.
// 폴백(장기평균·레시피등록가) 없이, 그 매장이 그 기간에 실제로 안 산 자재는 그냥 가격 없음으로 둔다 —
// "그 달에 안 샀다"는 메뉴가 드랍됐거나 다른 자재로 바뀌어 매칭이 필요하다는 신호이므로, 추정치로
// 덮어써서 숨기지 않고 그대로 드러내는 쪽이 자재 매칭 문제를 찾기에 더 낫다.
async function buildMaterialPriceResolverByStore(seasonId) {
  const season = state.seasons.find(s => s.id === seasonId);
  if (!season?.start_month || !season?.end_month) return { error: '시즌 기간 정보가 없습니다.' };
  const rangeStart = season.start_month, rangeEnd = nextDay(season.end_month);

  const [{ data: usageRows, error: usageErr }, aliasRes] = await Promise.all([
    fetchAllRpcPages('material_usage_totals_for_range_by_store', { p_start: rangeStart, p_end: rangeEnd }),
    sb.from('material_aliases').select('primary_material_code, alt_material_code').eq('status', 'confirmed'),
  ]);
  if (usageErr) return { error: usageErr.message || String(usageErr) };
  const confirmedAliases = aliasRes.data;

  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  (confirmedAliases || []).forEach(a => union(a.primary_material_code, a.alt_material_code));

  const gramsByStoreCluster = new Map(), costByStoreCluster = new Map(); // storeCode -> Map<cluster, n>
  (usageRows || []).forEach(r => {
    if (!r.material_code || !r.store_code || !r.total_grams) return;
    const grams = Number(r.total_grams) || 0;
    if (!grams) return;
    const key = find(r.material_code);
    if (!gramsByStoreCluster.has(r.store_code)) { gramsByStoreCluster.set(r.store_code, new Map()); costByStoreCluster.set(r.store_code, new Map()); }
    const g = gramsByStoreCluster.get(r.store_code), c = costByStoreCluster.get(r.store_code);
    g.set(key, (g.get(key) || 0) + grams);
    c.set(key, (c.get(key) || 0) + (Number(r.total_amount) || 0));
  });
  const pricePerGramByStore = new Map(); // storeCode -> Map<cluster, 원/g>
  gramsByStoreCluster.forEach((gramsMap, storeCode) => {
    const priceMap = new Map();
    gramsMap.forEach((grams, key) => { if (grams > 0) priceMap.set(key, costByStoreCluster.get(storeCode).get(key) / grams); });
    pricePerGramByStore.set(storeCode, priceMap);
  });

  // 그 매장이 그 기간에 (별칭 묶음 전체를 통틀어) 아예 안 산 자재는, "완전히 다른 자재로 바뀌었다"는
  // 신호일 수도 있지만 "그냥 이번 기간엔 재고가 남아 안 샀다"인 경우가 대부분이다. 이때는 매장을
  // 넘어(원가 매칭이 끝난) 같은 자재코드를 산 다른 매장들의 단가로 채운다 — 같은 자재코드=같은
  // 제품이라 매장이 달라도 단가가 사실상 같기 때문에, 아예 자재를 다른 걸로 착각해 새는 것보다 낫다.
  // 별칭으로 묶인 "다른 코드"까지는 안 섞는다(그건 매장마다 실제 공급처가 달라 단가가 다를 수 있어서,
  // 오늘 이 기능을 만든 원래 목적과 충돌한다) — 딱 "완전히 똑같은 코드"끼리만 매장을 넘어 채운다.
  const gramsByRawCode = new Map(), costByRawCode = new Map();
  (usageRows || []).forEach(r => {
    if (!r.material_code || !r.total_grams) return;
    const grams = Number(r.total_grams) || 0;
    if (!grams) return;
    gramsByRawCode.set(r.material_code, (gramsByRawCode.get(r.material_code) || 0) + grams);
    costByRawCode.set(r.material_code, (costByRawCode.get(r.material_code) || 0) + (Number(r.total_amount) || 0));
  });
  const crossStorePriceByRawCode = new Map();
  gramsByRawCode.forEach((grams, code) => { if (grams > 0) crossStorePriceByRawCode.set(code, costByRawCode.get(code) / grams); });

  function priceForCode(storeCode, code) {
    const clusterPrice = pricePerGramByStore.get(storeCode)?.get(find(code));
    if (clusterPrice != null) return { price: clusterPrice, isReal: true };
    const crossStorePrice = crossStorePriceByRawCode.get(code);
    if (crossStorePrice != null) return { price: crossStorePrice, isReal: true, isCrossStoreFallback: true };
    return null;
  }

  // 매장x원본코드(클러스터로 묶기 전) 실제 구매량 — "이 매장이 이 자재코드를 얼마나 샀는지"를
  // 그대로 보여줄 때 씀(축산/야채 자재 연결 목록 펼치기 전용).
  const usageByStoreRawCode = new Map();
  (usageRows || []).forEach(r => {
    if (!r.material_code || !r.store_code) return;
    if (!usageByStoreRawCode.has(r.store_code)) usageByStoreRawCode.set(r.store_code, new Map());
    usageByStoreRawCode.get(r.store_code).set(r.material_code, { grams: Number(r.total_grams) || 0, amount: Number(r.total_amount) || 0 });
  });

  return { priceForCode, find, storeCodes: [...pricePerGramByStore.keys()], usageByStoreRawCode };
}

// computeActualCostPerGram의 매장별 버전 — 메뉴x매장별 실제 g당원가.
// 반환: Map<menu_name, Map<store_code, { actual_cost_per_gram, grounded_ratio }>>
// 그 매장에 그 메뉴의 자재 구매 근거가 부족하면(95% 미만) 조용히 대체하지 않고 그 매장만 비워둔다.
async function computeActualCostPerGramByStore(seasonId) {
  const flat = await getFlatForSeason(seasonId);
  if (!flat) return { error: '레시피 데이터를 불러오지 못했습니다.' };
  const { flatByMenu, cookedWeightByMenu, finalMenus } = flat;

  const pricing = await buildMaterialPriceResolverByStore(seasonId);
  if (pricing.error) return pricing;
  const { priceForCode, storeCodes, usageByStoreRawCode } = pricing;

  const byMenu = new Map();
  finalMenus.forEach(menu => {
    const bom = flatByMenu.get(menu);
    const cookedWeight = cookedWeightByMenu.get(menu);
    if (!bom?.size || !cookedWeight) return;
    const byStore = new Map();
    storeCodes.forEach(storeCode => {
      let totalCost = 0, totalGrams = 0, groundedGrams = 0;
      bom.forEach((grams, code) => {
        const p = priceForCode(storeCode, code);
        if (p) totalCost += grams * p.price;
        if (WATER_CODES.includes(code)) return;
        totalGrams += grams;
        if (p) groundedGrams += grams;
      });
      const groundedRatio = totalGrams > 0 ? groundedGrams / totalGrams : 0;
      if (totalGrams > 0 && groundedRatio >= 0.95) {
        byStore.set(storeCode, { actual_cost_per_gram: totalCost / cookedWeight, grounded_ratio: groundedRatio });
      }
    });
    if (byStore.size) byMenu.set(menu, byStore);
  });

  return { byMenu, usageByStoreRawCode };
}

// "매장별 히트맵"·"메뉴 진단" 탭 자체를 없애면서 이 두 탭 전용 렌더 코드를 정리함 — 다른 어떤 탭도
// storeHeatmapCache/menuDiagnosisCache를 읽지 않는 것을 확인했다.

// 메뉴별 인당소비량(소비가중평균)을 카테고리 단위로 합산해 대시보드 실적에 반영.
// consumptionResults는 computeMenuConsumption()의 결과(옵션) — 메뉴마다 운영패턴이 달라 손님 수 분모가
// 다르므로, 합산 전용으로는 시즌 전체 손님 수로 나눈 consumption_per_person_brand를 써야 한다
// (그냥 consumption_per_person을 더하면 주말·디너 한정 메뉴가 과대 반영되어 브랜드 실적이 부풀려진다).
async function rebuildCategoryActualRollupFromMenus(seasonId, targetPrice, totalSales, totalCustomers, consumptionResults) {
  const [{ data: designs }, { data: consumption }, { data: recipeMenus }] = await Promise.all([
    fetchAllRows('menu_designs', q => q.eq('season_id', seasonId)),
    fetchAllRows('menu_consumption', q => q.eq('season_id', seasonId)),
    fetchAllRows('recipe_items', q => q.eq('season_id', seasonId), 'menu_name, category'),
  ]);
  const consumptionByMenu = Object.fromEntries((consumption || []).map(c => [c.menu_name, c]));
  const brandByMenu = Object.fromEntries((consumptionResults || []).map(r => [r.menu_name, r]));
  const designByMenu = new Map();
  (designs || []).forEach(m => { if (m.menu_name) designByMenu.set(m.menu_name, m); });
  // 레시피(recipe_items)만 있고 목표원가(menu_designs) 등록이 아직 없는 메뉴는(설계 단계를 건너뛰고
  // 바로 레시피부터 등록한 경우) 이 합산에서 통째로 빠지는 문제가 있었다 — 실제로 계산되는 원가인데도
  // 대시보드 브랜드 실적에 조용히 반영이 안 됐음. 설계원가 목록에 없는 메뉴도 최소한 조닝 정보만
  // 레시피 쪽에서 가져와 합산 대상에 포함시킨다(설계g당원가가 없을 뿐, 실제원가/소비량이 있으면 반영됨).
  const recipeCategoryByMenu = new Map();
  (recipeMenus || []).forEach(r => { if (r.menu_name && !r.menu_name.startsWith('#') && !recipeCategoryByMenu.has(r.menu_name)) recipeCategoryByMenu.set(r.menu_name, r.category); });
  const allMenuNames = new Set([...designByMenu.keys(), ...recipeCategoryByMenu.keys()]);

  const byCat = {};
  allMenuNames.forEach(menuName => {
    const m = designByMenu.get(menuName);
    const category = m?.category ?? recipeCategoryByMenu.get(menuName);
    const c = consumptionByMenu[menuName];
    const b = brandByMenu[menuName];
    // 실제 자재사용량 기준으로 재계산한 g당원가가 있으면 그걸 쓰고, 아직 계산 전인 메뉴는 설계 단가로 대체
    const costPerGram = c?.actual_cost_per_gram ?? m?.cost_per_gram;
    // 합산용 인당소비량: 시즌 전체 손님 기준(consumption_per_person_brand)을 우선 쓰고,
    // 매장 실사용 근거가 없어 설계값으로 대체된 메뉴(design_fallback)는 그 값 그대로 둔다.
    const consumptionForRollup = b?.consumption_per_person_brand ?? c?.consumption_per_person;
    const consumptionForRollupExclWater = b?.consumption_per_person_brand_excl_water ?? c?.consumption_per_person_excl_water ?? consumptionForRollup;
    if (!category || consumptionForRollup == null || costPerGram == null) return;
    if (!byCat[category]) byCat[category] = [];
    byCat[category].push({
      cost_per_gram: costPerGram, consumption_per_person: consumptionForRollup,
      consumption_per_person_excl_water: consumptionForRollupExclWater,
    });
  });

  const categoriesWithData = new Set(Object.keys(byCat));
  const upserts = DASHBOARD_CATEGORIES.filter(cat => categoriesWithData.has(cat)).map(category => {
    const list = byCat[category];
    let totalC = 0, totalCost = 0, totalCExclWater = 0;
    list.forEach(r => {
      totalC += r.consumption_per_person;
      totalCost += r.consumption_per_person * r.cost_per_gram;
      totalCExclWater += r.consumption_per_person_excl_water;
    });
    const costPerGram = totalC ? totalCost / totalC : null;
    return {
      season_id: seasonId, category,
      actual_cost_per_gram: costPerGram, actual_consumption_per_person: totalC,
      actual_consumption_per_person_excl_water: totalCExclWater,
      actual_cost_ratio: computeCostRatio(costPerGram, totalC, targetPrice),
    };
  });
  if (upserts.length) {
    await sb.from('category_summary').upsert(upserts, { onConflict: 'season_id,category' });
  }

  // 브랜드 전체 실적원가율도 갱신된 카테고리 실적 기준으로 다시 계산
  const { data: freshCategorySummary } = await fetchAllRows('category_summary', q => q.eq('season_id', seasonId).in('category', DASHBOARD_CATEGORIES));
  const brandActual = weightedTotals(freshCategorySummary || [], 'actual');
  const brandActualRatio = computeCostRatio(brandActual.costPerGram, brandActual.consumption, targetPrice);

  // 예전 "실적 자동 반영" 버튼이 하던 객단가/매출/객수 저장도 여기서 같이 처리 (다른 탭들이 target_price_per_person에 의존함)
  const targetPayload = {
    target_price_per_person: targetPrice,
    actual_total_sales: totalSales, actual_total_customers: totalCustomers,
    actual_price_per_person: targetPrice,
    actual_cost_ratio_brand: brandActualRatio,
  };
  if (state.seasonTarget?.id) {
    await sb.from('season_targets').update(targetPayload).eq('id', state.seasonTarget.id);
  } else {
    await sb.from('season_targets').insert({ ...targetPayload, season_id: seasonId });
  }
}

$('#computeConsumptionBtn').addEventListener('click', async () => {
  const btn = $('#computeConsumptionBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  try {
    const { results, error, totalCustomers, totalSales, pricePerCustomer } = await computeMenuConsumption((i, total, storeName) => {
      btn.textContent = `계산 중... (${i}/${total} ${storeName ?? ''})`;
    });
    if (error) { flash($('#computeConsumptionMsg'), error, false); return; }
    if (!totalCustomers) { flash($('#computeConsumptionMsg'), '매출/객수 데이터가 없습니다. 매출/객수 탭에서 먼저 입력해주세요.', false); return; }

    const upserts = results.filter(r => r.consumption_per_person != null).map(r => ({
      season_id: state.currentSeasonId, menu_name: r.menu_name,
      consumption_per_person: r.consumption_per_person,
      consumption_per_person_excl_water: r.consumption_per_person_excl_water,
      consumption_per_person_brand: r.consumption_per_person_brand,
      consumption_source: r.consumption_source, confidence: r.confidence,
    }));
    if (upserts.length) {
      const { error: upErr } = await sb.from('menu_consumption').upsert(upserts, { onConflict: 'season_id,menu_name' });
      if (upErr) { flash($('#computeConsumptionMsg'), '저장 실패: ' + upErr.message, false); return; }
    }

    // 매장별 상세 결과도 별도 테이블에 저장 (매장별 조회/이상값 탐지용)
    const storeUpserts = results.flatMap(r => (r.per_store || []).map(s => ({
      season_id: state.currentSeasonId, store_code: s.store_code, store_name: s.store_name, menu_name: r.menu_name,
      consumption_per_person: s.consumption_per_person,
      consumption_per_person_excl_water: s.consumption_per_person_excl_water,
      consumption_source: s.consumption_source, confidence: s.confidence,
    })));
    if (storeUpserts.length) {
      const { error: storeUpErr } = await sb.from('menu_consumption_store').upsert(storeUpserts, { onConflict: 'season_id,store_code,menu_name' });
      if (storeUpErr) { flash($('#computeConsumptionMsg'), '매장별 저장 실패: ' + storeUpErr.message, false); return; }
    }

    // 실제 자재사용량 단가 기준으로 메뉴별 g당원가도 다시 계산
    btn.textContent = '계산 중... (실제 g당원가 계산)';
    const costResult = await computeActualCostPerGram(state.currentSeasonId);
    if (!costResult.error && costResult.results?.length) {
      // null인 결과도 그대로 올려서, 예전엔 실단가로 잡혔다가 이번엔 근거가 부족해진 메뉴의 낡은 값을 지운다.
      const costUpserts = costResult.results.map(r => ({
        season_id: state.currentSeasonId, menu_name: r.menu_name,
        actual_cost_per_gram: r.actual_cost_per_gram, cost_source: r.cost_source, cost_month: costResult.costMonth,
      }));
      if (costUpserts.length) {
        const { error: costUpErr } = await sb.from('menu_consumption').upsert(costUpserts, { onConflict: 'season_id,menu_name' });
        if (costUpErr) { flash($('#computeConsumptionMsg'), 'g당원가 저장 실패: ' + costUpErr.message, false); return; }
      }
    }

    await rebuildCategoryActualRollupFromMenus(state.currentSeasonId, pricePerCustomer, totalSales, totalCustomers, results);

    const exactCount = results.filter(r => r.consumption_source === 'exact').length;
    const allocatedCount = results.filter(r => r.consumption_source === 'allocated').length;
    const partialCount = results.filter(r => r.consumption_source === 'partial').length;
    const lowCount = results.filter(r => r.consumption_source === 'design_fallback').length;
    const unresolvedCount = results.filter(r => r.consumption_per_person == null).length;
    const costActualCount = (costResult.results || []).filter(r => r.cost_source === 'actual').length;
    const costPartialCount = (costResult.results || []).filter(r => r.cost_source === 'partial').length;
    flash($('#computeConsumptionMsg'), `계산 완료 — 확정 ${exactCount} / 추정(신뢰) ${allocatedCount} / 추정(일부매장) ${partialCount} / 추정(낮음) ${lowCount}${unresolvedCount ? ` / 미해결 ${unresolvedCount}` : ''} · g당원가(${costResult.costMonth ?? '-'}) 실단가 ${costActualCount} / 일부실단가 ${costPartialCount}`);
    await loadMenuConsumptionView();
    await loadDashboard();
    await loadTargetForm();
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

// =====================================================================
// Tab: Produce monitoring (농산 모니터링)
// =====================================================================
(() => {
  const now = new Date();
  $('#produceMonthInput').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
})();

let produceRowsCache = [];
// "고추" ↔ "생고추", "깐 양배추" ↔ "양배추" 처럼 흔한 수식어 차이만 있는 경우를 매칭.
// 단순 포함관계(substring)로 하면 "고추"가 "고추잎"(전혀 다른 품목)까지 잡아버려서,
// 알려진 수식어만 떼어내고 정확히 같아야 매칭되도록 제한한다.
const PRODUCE_NAME_MODIFIERS = ['생', '깐', '다진', '국산', '수입', '세척', '손질', '냉동', '신선', '특', '상'];
function normalizeProduceName(name) {
  let s = (name || '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const mod of PRODUCE_NAME_MODIFIERS) {
      if (s.startsWith(mod) && s.length > mod.length) {
        s = s.slice(mod.length).trim();
        changed = true;
      }
    }
  }
  return s;
}
function isFuzzyItemMatch(a, b) {
  const na = normalizeProduceName(a);
  const nb = normalizeProduceName(b);
  return na !== '' && na === nb;
}

// 품목별로 시장데이터에서 이름이 비슷한 상/특 등급 항목을 찾아 g당단가 평균을 낸다.
function computeMarketAvgByItem(items, marketRows) {
  const result = {};
  items.forEach(item => {
    const matches = (marketRows || []).filter(mr => isFuzzyItemMatch(item, mr.item_name));
    const gpgList = matches
      .map(mr => { const g = parseUnitToGrams(mr.unit); return (g && mr.avg_price != null) ? mr.avg_price / g : null; })
      .filter(v => v != null);
    if (gpgList.length) result[item] = gpgList.reduce((a, v) => a + v, 0) / gpgList.length;
  });
  return result;
}

// 타겟단가 = 이번 달 시장단가×0.9. 이번 달 시장데이터가 아직 없으면(미래월 등) 작년 동월 시장단가×0.9로 대신한다.
function deriveTargetPrice(marketPriceThisMonth, marketPriceSameMonthLastYear) {
  if (marketPriceThisMonth != null) return marketPriceThisMonth * 0.9;
  if (marketPriceSameMonthLastYear != null) return marketPriceSameMonthLastYear * 0.9;
  return null;
}

// "10kg상자", "20kg", "500g" 같은 거래단위 표기에서 g 단위 중량을 뽑아낸다
function parseUnitToGrams(unitStr) {
  if (!unitStr) return null;
  const kg = String(unitStr).match(/(\d+(?:\.\d+)?)\s*kg/i);
  if (kg) return parseFloat(kg[1]) * 1000;
  const g = String(unitStr).match(/(\d+(?:\.\d+)?)\s*g(?!\w)/i);
  if (g) return parseFloat(g[1]);
  return null;
}

async function loadProduceMonitoring() {
  if (!state.currentSeasonId) return;
  const monthValue = $('#produceMonthInput').value;
  if (!monthValue) return;
  const monitorMonth = `${monthValue}-01`;
  const [y, m] = monthValue.split('-').map(Number);
  const nextMonth = new Date(y, m, 1); // m is 1-indexed already -> gives 1st of next month
  const nextMonthStr = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;
  // 타겟단가의 "작년 동월" 대체값 계산용 — 미래월(시장데이터 아직 없음)에도 목표가 비지 않게 함
  const lastYearMonth = `${y - 1}-${String(m).padStart(2, '0')}-01`;
  const lastYearNextMonth = new Date(y - 1, m, 1);
  const lastYearNextMonthStr = `${lastYearNextMonth.getFullYear()}-${String(lastYearNextMonth.getMonth() + 1).padStart(2, '0')}-01`;

  const [{ data: usage, error: usageErr }, { data: marketRows }, { data: lastYearMarketRows }] = await Promise.all([
    fetchAllRows('material_usage',
      q => q.eq('usage_month', monitorMonth).eq('remark', '농산').eq('tax_status', '비과세')),
    fetchAllRows('market_prices', q => q.gte('record_date', monitorMonth).lt('record_date', nextMonthStr).in('grade', ['상', '특'])),
    fetchAllRows('market_prices', q => q.gte('record_date', lastYearMonth).lt('record_date', lastYearNextMonthStr).in('grade', ['상', '특'])),
  ]);
  if (usageErr) { console.error(usageErr); return; }

  // 신선 농산물이 아닌 품목(가공 김치류/냉동/건고추)은 모니터링 대상에서 제외
  const isExcludedProduceItem = (name) => {
    if (!name) return false;
    if (name.includes('김치')) return true; // 김치, 열무김치, 맛김치 등 김치류(가공)
    if (name === '깍두기') return true;
    if (name.includes('냉동')) return true; // 냉동 품목 (신선자재 아님)
    if (name === '월남고추') return true; // 건고추 (신선자재 아님)
    return false;
  };

  // 자재명에 "직송"이 포함되어 있으면 직송 매입, 아니면 구매 매입으로 나누어 각각 g당단가를 낸다
  const byItem = {};
  (usage || []).forEach(r => {
    const item = (r.item_name || r.material_name || '').trim(); // 품목 미입력 시 자재명으로 우선 표시
    if (!item || isExcludedProduceItem(item)) return;
    const grams = (Number(r.actual_usage_qty) || 0) * (Number(r.conversion_factor) || 0);
    const bucketKey = (r.material_name || '').includes('직송') ? 'direct' : 'purchase';
    if (!byItem[item]) byItem[item] = { direct: { grams: 0, amount: 0 }, purchase: { grams: 0, amount: 0 } };
    byItem[item][bucketKey].grams += grams;
    byItem[item][bucketKey].amount += Number(r.actual_usage_amount) || 0;
  });
  const items = Object.keys(byItem);

  const { data: monitorRows } = items.length
    ? await sb.from('produce_monitoring').select('*').eq('monitor_month', monitorMonth).in('item_name', items)
    : { data: [] };
  const monitorByItem = Object.fromEntries((monitorRows || []).map(r => [r.item_name, r]));

  // 시장단가 = 이번 달/작년 동월 각각 g당단가 평균. 타겟단가 = deriveTargetPrice(이번 달 평균×0.9, 없으면 작년 동월 평균×0.9)
  const computedMarketByItem = computeMarketAvgByItem(items, marketRows);
  const computedMarketByItemLastYear = computeMarketAvgByItem(items, lastYearMarketRows);
  const marketPriceUpserts = [];
  items.forEach(item => {
    const marketPrice = computedMarketByItem[item] ?? null;
    const targetPrice = deriveTargetPrice(computedMarketByItem[item], computedMarketByItemLastYear[item]);
    if (marketPrice != null || targetPrice != null) {
      marketPriceUpserts.push({ item_name: item, monitor_month: monitorMonth, market_price: marketPrice, target_price: targetPrice });
    }
  });
  if (marketPriceUpserts.length) {
    await sb.from('produce_monitoring').upsert(marketPriceUpserts, { onConflict: 'item_name,monitor_month' });
  }

  produceRowsCache = items.map(item => {
    const { direct, purchase } = byItem[item];
    const brandPriceDirect = direct.grams ? direct.amount / direct.grams : null;
    const brandPricePurchase = purchase.grams ? purchase.amount / purchase.grams : null;
    const mp = monitorByItem[item] || {};
    const marketPrice = computedMarketByItem[item] ?? mp.market_price ?? null;
    const targetPrice = deriveTargetPrice(computedMarketByItem[item], computedMarketByItemLastYear[item]) ?? mp.target_price ?? null;
    const usageAmountDirect = direct.amount;
    const usageAmountPurchase = purchase.amount;
    const usageAmountTotal = direct.amount + purchase.amount;

    // 직송/구매 각각의 사용액×단가차이를 더해서 전체 절감액을 낸다 (채널별 단가가 다르므로 합산이 하나의 평균단가보다 정확함)
    let targetSavings = null, marketSavings = null;
    [{ price: brandPriceDirect, bucket: direct }, { price: brandPricePurchase, bucket: purchase }].forEach(({ price, bucket }) => {
      if (!bucket.grams || !price) return;
      if (targetPrice != null) targetSavings = (targetSavings ?? 0) + bucket.amount * (1 - targetPrice / price);
      if (marketPrice != null) marketSavings = (marketSavings ?? 0) + bucket.amount * (1 - marketPrice / price);
    });

    return {
      item_name: item, target_price: targetPrice,
      brand_price_direct: brandPriceDirect, brand_price_purchase: brandPricePurchase,
      market_price: marketPrice,
      usage_amount_direct: usageAmountDirect, usage_amount_purchase: usageAmountPurchase, usage_amount_total: usageAmountTotal,
      target_savings: targetSavings, market_savings: marketSavings,
    };
  });

  renderProduceTable();
}

function renderProduceTable() {
  const sortMode = $('#produceSortSelect').value;
  const rows = produceRowsCache.slice().sort((a, b) => {
    if (sortMode === 'usage') return (b.usage_amount_total || 0) - (a.usage_amount_total || 0);
    if (sortMode === 'target') return (b.target_savings ?? -Infinity) - (a.target_savings ?? -Infinity);
    if (sortMode === 'market') return (b.market_savings ?? -Infinity) - (a.market_savings ?? -Infinity);
    return a.item_name.localeCompare(b.item_name, 'ko');
  });

  const body = $('#produceTableBody');
  body.innerHTML = rows.map(r => {
    const directPct = r.usage_amount_total ? r.usage_amount_direct / r.usage_amount_total * 100 : 0;
    const purchasePct = r.usage_amount_total ? r.usage_amount_purchase / r.usage_amount_total * 100 : 0;
    return `
    <tr data-item="${r.item_name}">
      <td class="cell-left produce-item-name">${r.item_name}</td>
      <td>${r.target_price != null ? fmtNum(r.target_price, 1) : '-'}</td>
      <td>${r.brand_price_direct != null ? fmtNum(r.brand_price_direct, 1) : '-'}</td>
      <td>${r.brand_price_purchase != null ? fmtNum(r.brand_price_purchase, 1) : '-'}</td>
      <td>${r.market_price != null ? fmtNum(r.market_price, 1) : '-'}</td>
      <td>${fmtNum(r.usage_amount_direct, 0)} <span class="hint">(${fmtNum(directPct, 0)}%)</span></td>
      <td>${fmtNum(r.usage_amount_purchase, 0)} <span class="hint">(${fmtNum(purchasePct, 0)}%)</span></td>
      <td>${fmtNum(r.usage_amount_total, 0)}</td>
      <td>${r.target_savings != null ? fmtNum(r.target_savings, 0) : '-'}</td>
      <td>${r.market_savings != null ? fmtNum(r.market_savings, 0) : '-'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="10" style="text-align:center;color:var(--muted)">해당 연월에 농산 자재 데이터가 없습니다.</td></tr>`;

  $$('.produce-item-name', body).forEach(td => {
    td.addEventListener('click', () => toggleProduceChartRow(td.closest('tr')));
  });
}

$('#produceMonthInput').addEventListener('change', loadProduceMonitoring);
$('#produceSortSelect').addEventListener('change', renderProduceTable);

// 클릭한 품목 행 바로 아래에 추이 그래프를 펼쳐서 보여준다 (다른 품목 클릭 시 이전 것은 접힘)
async function toggleProduceChartRow(tr) {
  const item = tr.dataset.item;
  const next = tr.nextElementSibling;
  const alreadyOpenForThisItem = next && next.classList.contains('produce-chart-row') && next.dataset.item === item;
  const openRow = $('.produce-chart-row');
  if (openRow) openRow.remove();
  if (alreadyOpenForThisItem) return; // 같은 품목을 다시 클릭하면 접기만 함

  const chartRow = document.createElement('tr');
  chartRow.className = 'produce-chart-row';
  chartRow.dataset.item = item;
  chartRow.innerHTML = `<td colspan="${tr.children.length}">
    <h4 class="produce-chart-title" id="produceChartTitle"></h4>
    <div id="produceChartWrap" class="history-chart"></div>
  </td>`;
  tr.after(chartRow);
  await loadProduceChart(item);
}

async function loadProduceChart(itemName) {
  $('#produceChartTitle').textContent = `${itemName} — 월별 단가 추이`;
  // 품목 필드가 비어 자재명으로 대체 표시된 경우와 매칭하려면 전체를 가져와 클라이언트에서 걸러야 함
  // (특수문자가 섞인 자재명을 필터 문자열에 그대로 넣으면 PostgREST 쿼리가 깨질 수 있음)
  const { data: allUsage } = await fetchAllRows('material_usage',
    q => q.eq('remark', '농산').eq('tax_status', '비과세'));
  const usageRows = (allUsage || []).filter(r => (r.item_name || r.material_name || '').trim() === itemName);

  const byMonth = {};
  (usageRows || []).forEach(r => {
    if (!r.usage_month) return;
    const key = r.usage_month.slice(0, 7);
    const grams = (Number(r.actual_usage_qty) || 0) * (Number(r.conversion_factor) || 0);
    const bucketKey = (r.material_name || '').includes('직송') ? 'direct' : 'purchase';
    if (!byMonth[key]) byMonth[key] = { direct: { grams: 0, amount: 0 }, purchase: { grams: 0, amount: 0 } };
    byMonth[key][bucketKey].grams += grams;
    byMonth[key][bucketKey].amount += Number(r.actual_usage_amount) || 0;
  });

  // 시장/목표 단가는 저장된 월별 캐시가 아니라 시장 데이터 원본에서 매월 직접 계산한다.
  // (예전 방식은 그 달을 한 번이라도 조회해야만 값이 남아, 방문한 적 없는 달은 비어보이는 문제가 있었음)
  // core 이름으로 서버 쪽에서 먼저 걸러서(ilike) 전체 시장데이터를 다 받아오지 않도록 한다.
  const core = normalizeProduceName(itemName);
  const { data: marketRows } = await fetchAllRows('market_prices',
    q => q.in('grade', ['상', '특']).ilike('item_name', `%${core}%`));
  const matches = (marketRows || []).filter(mr => isFuzzyItemMatch(itemName, mr.item_name));
  const gpgByMonth = {};
  matches.forEach(mr => {
    const key = (mr.record_date || '').slice(0, 7);
    const g = parseUnitToGrams(mr.unit);
    if (!key || !g || mr.avg_price == null) return;
    (gpgByMonth[key] = gpgByMonth[key] || []).push(mr.avg_price / g);
  });
  const marketByMonth = {};
  Object.entries(gpgByMonth).forEach(([k, list]) => { marketByMonth[k] = list.reduce((a, v) => a + v, 0) / list.length; });

  const actualMonths = [...new Set([...Object.keys(byMonth), ...Object.keys(marketByMonth)])].sort();
  // 최신 실데이터 달 다음 달부터 그 해 12월까지는 실적 없이 목표단가(작년 동월×0.9) 투사선만 이어서 보여준다
  const lastActual = actualMonths[actualMonths.length - 1];
  const futureMonths = [];
  if (lastActual) {
    const [ly, lm] = lastActual.split('-').map(Number);
    for (let mm = lm + 1; mm <= 12; mm++) futureMonths.push(`${ly}-${String(mm).padStart(2, '0')}`);
  }
  const months = [...actualMonths, ...futureMonths];
  const lastYearKeyOf = (key) => { const [ky, km] = key.split('-').map(Number); return `${ky - 1}-${String(km).padStart(2, '0')}`; };

  renderProduceChart(
    months,
    months.map(m => deriveTargetPrice(marketByMonth[m], marketByMonth[lastYearKeyOf(m)]) ?? null),
    months.map(m => byMonth[m]?.direct.grams ? (byMonth[m].direct.amount / byMonth[m].direct.grams) : null),
    months.map(m => byMonth[m]?.purchase.grams ? (byMonth[m].purchase.amount / byMonth[m].purchase.grams) : null),
    months.map(m => marketByMonth[m] ?? null),
  );
}

function renderProduceChart(months, targetSeries, directSeries, purchaseSeries, marketSeries) {
  const wrap = $('#produceChartWrap');
  if (!wrap || !months.length) { if (wrap) wrap.innerHTML = `<div class="chart-empty">데이터가 없습니다.</div>`; return; }
  const seriesDefs = [
    { label: '목표단가', color: 'var(--good)', values: targetSeries },
    { label: '로운(직송)', color: 'var(--accent)', values: directSeries },
    { label: '로운(구매)', color: 'var(--ink)', values: purchaseSeries },
    { label: '시장단가', color: 'var(--warn)', values: marketSeries },
  ];
  const width = 780, height = 200, padding = { top: 14, right: 16, bottom: 22, left: 36 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const allValues = seriesDefs.flatMap(s => s.values).filter(v => v != null);
  if (!allValues.length) { wrap.innerHTML = `<div class="chart-empty">데이터를 입력하면 그래프가 표시됩니다.</div>`; return; }
  const maxV = Math.max(...allValues) * 1.15 || 1;
  const xFor = (i) => months.length > 1 ? padding.left + (plotW * i / (months.length - 1)) : padding.left + plotW / 2;
  const yFor = (v) => padding.top + plotH - (plotH * v / maxV);

  const gridLines = Array.from({ length: 4 }, (_, i) => {
    const y = padding.top + plotH * i / 3;
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--line)" stroke-width="1" />`;
  }).join('');
  const xLabels = months.map((m, i) => `<text x="${xFor(i)}" y="${height - 4}" font-size="10" fill="var(--muted)" text-anchor="middle">${m.slice(2)}</text>`).join('');

  const seriesSvg = seriesDefs.map(s => {
    // month/value를 좌표와 같이 들고 다녀서 점에 마우스를 올리면 값이 보이는 툴팁(<title>)을 붙일 수 있게 한다
    const pts = s.values.map((v, i) => v != null ? [xFor(i), yFor(v), months[i], v] : null).filter(Boolean);
    return { s, path: buildSmoothPath(pts), pts };
  });
  const paths = seriesSvg.map(({ s, path }) => path ? `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linecap="round" />` : '').join('');
  const dots = seriesSvg.flatMap(({ s, pts }) => pts.map(([x, y, month, v]) =>
    `<circle cx="${x}" cy="${y}" r="4" fill="${s.color}"><title>${s.label} ${month}: ${fmtNum(v, 1)}원/g</title></circle>`
  )).join('');
  const legend = seriesDefs.map(s => `<span><span class="dot" style="background:${s.color}"></span>${s.label}</span>`).join('');

  wrap.innerHTML = `
    <div class="chart-legend">${legend}</div>
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-width:${width}px;">
      ${gridLines}${paths}${dots}${xLabels}
    </svg>`;
}

// ---- 농산 모니터링 엑셀 다운로드 (시즌/연월 무관, 최초 데이터부터 현재까지 전체 이력) ----
function formatMonthLabelKorean(monthKey) { // "2026-09" -> "26년9월"
  const [y, m] = monthKey.split('-');
  return `${y.slice(2)}년${Number(m)}월`;
}
function monthRangeInclusive(startKey, endKey) {
  const [sy, sm] = startKey.split('-').map(Number);
  const [ey, em] = endKey.split('-').map(Number);
  const out = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
function lastYearKeyOfMonth(key) {
  const [ky, km] = key.split('-').map(Number);
  return `${ky - 1}-${String(km).padStart(2, '0')}`;
}
function roundOrBlank(v, digits) { return v == null ? '' : Math.round(v * 10 ** digits) / 10 ** digits; }
// SheetJS 무료판은 셀 배경색 쓰기를 지원하지 않아서(실제 테스트로 확인됨), 신호등 대신 값 앞에 이모지를 붙인다.
function formatPctWithSignal(v) {
  if (v === '' || v == null) return '';
  const rounded = Math.round(v);
  const signal = rounded >= 200 ? '🔴 ' : rounded <= 100 ? '🟢 ' : '';
  return `${signal}${rounded}%`;
}

async function exportProduceExcel() {
  const btn = $('#exportProduceExcelBtn');
  btn.disabled = true;
  try {
    flash($('#produceExportMsg'), '데이터 모으는 중...');
    const [{ data: usageRows, error: usageErr }, { data: marketRows }] = await Promise.all([
      fetchAllRows('material_usage', q => q.eq('remark', '농산').eq('tax_status', '비과세')),
      fetchAllRows('market_prices', q => q.in('grade', ['상', '특'])),
    ]);
    if (usageErr) { flash($('#produceExportMsg'), '데이터를 불러오지 못했습니다: ' + usageErr.message, false); return; }

    // 품목×월별 직송/구매 grams·amount 집계
    const usageByItemMonth = {}; // item -> month -> {direct:{grams,amount}, purchase:{grams,amount}}
    (usageRows || []).forEach(r => {
      const item = (r.item_name || r.material_name || '').trim();
      if (!item || !r.usage_month) return;
      const month = r.usage_month.slice(0, 7);
      const grams = (Number(r.actual_usage_qty) || 0) * (Number(r.conversion_factor) || 0);
      const bucketKey = (r.material_name || '').includes('직송') ? 'direct' : 'purchase';
      if (!usageByItemMonth[item]) usageByItemMonth[item] = {};
      if (!usageByItemMonth[item][month]) usageByItemMonth[item][month] = { direct: { grams: 0, amount: 0 }, purchase: { grams: 0, amount: 0 } };
      usageByItemMonth[item][month][bucketKey].grams += grams;
      usageByItemMonth[item][month][bucketKey].amount += Number(r.actual_usage_amount) || 0;
    });
    const items = Object.keys(usageByItemMonth);
    if (!items.length) { flash($('#produceExportMsg'), '농산 자재 데이터가 없습니다.', false); return; }

    // 정규화 이름 기준으로 시장데이터를 한 번만 그룹핑해서(품목 수 × 시장행 수 전수비교를 피함) 품목×월별 g당단가 평균을 낸다
    const marketRowsByNormName = new Map();
    (marketRows || []).forEach(mr => {
      const norm = normalizeProduceName(mr.item_name);
      if (!norm) return;
      if (!marketRowsByNormName.has(norm)) marketRowsByNormName.set(norm, []);
      marketRowsByNormName.get(norm).push(mr);
    });
    const marketByItemMonth = {}; // item -> month -> avgGpg
    items.forEach(item => {
      const candidates = marketRowsByNormName.get(normalizeProduceName(item)) || [];
      const gpgByMonth = {};
      candidates.forEach(mr => {
        const month = (mr.record_date || '').slice(0, 7);
        const g = parseUnitToGrams(mr.unit);
        if (!month || !g || mr.avg_price == null) return;
        (gpgByMonth[month] = gpgByMonth[month] || []).push(mr.avg_price / g);
      });
      const byMonth = {};
      Object.entries(gpgByMonth).forEach(([k, list]) => { byMonth[k] = list.reduce((a, v) => a + v, 0) / list.length; });
      marketByItemMonth[item] = byMonth;
    });

    // 월 범위: 실사용+시장데이터를 통틀어 가장 이른 달(시장데이터가 사용량보다 먼저 시작하는 경우가 많음)
    // ~ 가장 최근 달을 그 해 12월까지 연장(미래월은 타겟단가 투사용)
    const allMonths = new Set();
    items.forEach(item => {
      Object.keys(usageByItemMonth[item]).forEach(m => allMonths.add(m));
      Object.keys(marketByItemMonth[item]).forEach(m => allMonths.add(m));
    });
    const sortedAllMonths = [...allMonths].sort();
    const firstMonth = sortedAllMonths[0];
    const lastActualMonth = sortedAllMonths[sortedAllMonths.length - 1];
    const [lastY] = lastActualMonth.split('-').map(Number);
    const endMonth = `${lastY}-12`;
    const monthKeys = monthRangeInclusive(firstMonth, endMonth);

    // 정렬 기준(최근월 사용액)은 실사용 데이터가 있는 가장 최근 달로 별도 계산 — 시장데이터만 있는 달로는 사용액 비교가 안 됨
    const allUsageMonths = new Set();
    items.forEach(item => Object.keys(usageByItemMonth[item]).forEach(m => allUsageMonths.add(m)));
    const sortedUsageMonths = [...allUsageMonths].sort();
    const lastUsageMonth = sortedUsageMonths[sortedUsageMonths.length - 1];

    // 품목 정렬: 가장 최근월(lastUsageMonth) 사용액(직송+구매) 많은 순
    const usageAtLastMonth = (item) => {
      const b = usageByItemMonth[item]?.[lastUsageMonth];
      return b ? b.direct.amount + b.purchase.amount : 0;
    };
    const sortedItems = items.slice().sort((a, b) => usageAtLastMonth(b) - usageAtLastMonth(a));

    const priceOf = (item, month, bucket) => {
      const b = usageByItemMonth[item]?.[month]?.[bucket];
      return b?.grams ? b.amount / b.grams : null;
    };

    const aoa = [['품목', '비고', ...monthKeys.map(formatMonthLabelKorean)]];
    sortedItems.forEach(item => {
      const targetRow = monthKeys.map(m => roundOrBlank(deriveTargetPrice(marketByItemMonth[item][m], marketByItemMonth[item][lastYearKeyOfMonth(m)]), 2));
      const marketRow = monthKeys.map(m => roundOrBlank(marketByItemMonth[item][m], 2));
      const directRow = monthKeys.map(m => roundOrBlank(priceOf(item, m, 'direct'), 2));
      const purchaseRow = monthKeys.map(m => roundOrBlank(priceOf(item, m, 'purchase'), 2));
      // 200% 이상은 🔴, 100% 이하는 🟢 (셀 배경색을 못 쓰는 대신 이모지로 신호등 표시)
      const targetVsDirectRow = monthKeys.map((m, i) => (targetRow[i] !== '' && directRow[i] !== '') ? formatPctWithSignal(directRow[i] / targetRow[i] * 100) : '');
      const marketVsPurchaseRow = monthKeys.map((m, i) => (marketRow[i] !== '' && purchaseRow[i] !== '') ? formatPctWithSignal(purchaseRow[i] / marketRow[i] * 100) : '');

      aoa.push([item, '타겟단가', ...targetRow]);
      aoa.push(['', '시장단가', ...marketRow]);
      aoa.push(['', '로운(직송)', ...directRow]);
      aoa.push(['', '로운(구매)', ...purchaseRow]);
      aoa.push(['', '타겟대비 직송(%)', ...targetVsDirectRow]);
      aoa.push(['', '시장대비 구매(%)', ...marketVsPurchaseRow]);
    });

    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, '농산모니터링');
    const today = new Date();
    const filename = `농산모니터링_${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}.xlsx`;
    XLSX.writeFile(wb, filename);
    flash($('#produceExportMsg'), `${sortedItems.length}개 품목, ${monthKeys.length}개월치 다운로드 완료`);
  } finally {
    btn.disabled = false;
  }
}
$('#exportProduceExcelBtn').addEventListener('click', exportProduceExcel);

// =====================================================================
// Tab 6: Material usage (자재 사용량)
// =====================================================================
// 비고/품목/과세여부는 더 이상 붙여넣기 대상이 아니다 — 저장 시 자재코드(별칭 그룹) 기준으로 과거 이력에서
// 자동으로 이어받는다 (classifyRowsWithMaterialLookup). 자재코드가 처음 나온 경우엔 비워두고
// "미분류 자재" 목록에 노출한다 (renderUnclassifiedMaterials).
const USAGE_GRID_FIELDS = ['store_code', 'store_name', 'material_code', 'material_name', 'stock_unit', 'spec', 'conversion_factor',
  'prev_stock_qty', 'prev_stock_amount', 'received_qty', 'received_amount',
  'current_stock_qty', 'current_stock_amount', 'actual_usage_qty', 'actual_usage_amount'];
const USAGE_CLASSIFICATION_FIELDS = ['remark', 'item_name', 'tax_status'];
const USAGE_FIELDS = [...USAGE_GRID_FIELDS, ...USAGE_CLASSIFICATION_FIELDS];
const USAGE_NUMERIC_FROM = 6; // conversion_factor onward through actual_usage_amount (index 14) are numeric
const USAGE_NUMERIC_TO = 14;

// 재고실사 주기: 매주 월요일 + 매달 말일(요일 무관). 한 주의 실사용 기간은 (직전 실사일, 이번 실사일].
// 선택한 연월에 "실사일(period_end)"이 속하는 주차들을 계산한다 — 과거 대량 백필 때 파일명으로 검증한 규칙과 동일.
function computeWeekOptionsForMonth(year, month) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const isCutoffDay = (d) => {
    if (d.getDay() === 1) return true; // 월요일
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return d.getDate() === lastDay; // 말일
  };
  const scanStart = new Date(year, month - 2, 1); // 전월 1일부터 스캔해야 이번달 첫 주의 시작일을 알 수 있음
  const scanEnd = new Date(year, month - 1, new Date(year, month, 0).getDate());
  const cutoffs = [];
  for (let d = new Date(scanStart); d <= scanEnd; d.setDate(d.getDate() + 1)) {
    if (isCutoffDay(d)) cutoffs.push(new Date(d));
  }
  const weeks = [];
  for (let i = 1; i < cutoffs.length; i++) {
    const end = cutoffs[i];
    if (end.getFullYear() !== year || end.getMonth() + 1 !== month) continue;
    const start = new Date(cutoffs[i - 1]);
    start.setDate(start.getDate() + 1);
    weeks.push({ periodStart: fmt(start), periodEnd: fmt(end) });
  }
  weeks.forEach((w, i) => {
    w.label = `${i + 1}주차 (${w.periodStart.slice(5)} ~ ${w.periodEnd.slice(5)})`;
  });
  return weeks;
}

function renderUsageWeekOptions() {
  const monthValue = $('#usageMonthInput').value; // "YYYY-MM"
  const sel = $('#usageWeekSelect');
  if (!monthValue) { sel.innerHTML = ''; return; }
  const [y, m] = monthValue.split('-').map(Number);
  const weeks = computeWeekOptionsForMonth(y, m);
  sel.innerHTML = weeks.map(w => `<option value="${w.periodStart}|${w.periodEnd}">${w.label}</option>`).join('');
  if (weeks.length) sel.value = `${weeks[weeks.length - 1].periodStart}|${weeks[weeks.length - 1].periodEnd}`;
}

// 연월 선택 시 그 달의 주차 옵션으로 갱신, 기본값은 현재월의 마지막 주차
(() => {
  const now = new Date();
  $('#usageMonthInput').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  renderUsageWeekOptions();
})();
$('#usageMonthInput').addEventListener('change', renderUsageWeekOptions);

const usageGridBody = $('#usageGridBody');
function addUsageRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = USAGE_GRID_FIELDS.map((f, i) => {
    const isNumeric = i >= USAGE_NUMERIC_FROM && i <= USAGE_NUMERIC_TO;
    return `<td><input type="${isNumeric ? 'number' : 'text'}" ${isNumeric ? 'step="0.01"' : ''} data-col="${i}"></td>`;
  }).join('') + `<td><button type="button" class="row-del-btn" title="삭제">×</button></td>`;
  tr.querySelector('.row-del-btn').addEventListener('click', () => tr.remove());
  usageGridBody.appendChild(tr);
  return tr;
}
for (let i = 0; i < 3; i++) addUsageRow();
$('#addUsageRowBtn').addEventListener('click', () => addUsageRow());
attachPasteFill(usageGridBody, addUsageRow);

$('#saveUsageGridBtn').addEventListener('click', async () => {
  if (!state.currentSeasonId) return;
  const monthValue = $('#usageMonthInput').value; // "YYYY-MM"
  if (!monthValue) { flash($('#usageSaveMsg'), '등록 연월을 선택해주세요.', false); return; }
  const weekValue = $('#usageWeekSelect').value; // "periodStart|periodEnd"
  if (!weekValue) { flash($('#usageSaveMsg'), '주차를 선택해주세요.', false); return; }
  const [periodStart, periodEnd] = weekValue.split('|');
  const usageMonth = `${periodEnd.slice(0, 7)}-01`; // 실사일(period_end)이 속한 달 기준
  const rows = [];
  $$('tr', usageGridBody).forEach(tr => {
    const values = USAGE_GRID_FIELDS.map((_, i) => tr.querySelector(`input[data-col="${i}"]`).value);
    if (!values[3] && !values[2]) return; // need at least material name or code
    const rec = { season_id: state.currentSeasonId, usage_month: usageMonth, period_start: periodStart, period_end: periodEnd };
    USAGE_GRID_FIELDS.forEach((f, i) => {
      rec[f] = (i >= USAGE_NUMERIC_FROM && i <= USAGE_NUMERIC_TO) ? numOrNull(values[i]) : (values[i] ? values[i].trim() : null);
    });
    rows.push(rec);
  });
  if (!rows.length) { flash($('#usageSaveMsg'), '입력된 행이 없습니다.', false); return; }

  const btn = $('#saveUsageGridBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '저장 중...';
  try {
    // 비고/품목/과세여부는 자재코드(별칭 그룹 포함) 기준으로 과거 이력에서 자동으로 이어받는다.
    // 이번에 저장하는 자재코드만 조회 범위로 좁혀서(전체 이력을 다 훑지 않도록) 속도를 확보한다.
    const codesOfInterest = [...new Set(rows.map(r => r.material_code).filter(Boolean))];
    const classificationByCode = await buildMaterialClassificationLookup(codesOfInterest);
    rows.forEach(r => {
      const cls = r.material_code ? classificationByCode.get(r.material_code) : null;
      r.remark = cls?.remark ?? null;
      r.item_name = cls?.item_name ?? null;
      r.tax_status = cls?.tax_status ?? null;
    });

    // 같은 주차(period_start~period_end)에 매장+자재 조합이 이미 있으면 이전 값을 지우고 새 값으로 교체
    // (다른 주차 데이터는 그대로 유지 — 한 달에 여러 주를 나눠 저장해도 서로 지우지 않는다)
    const keys = new Set(rows.map(r => `${r.store_code}||${r.material_code}`));
    const { data: existing } = await fetchAllRows('material_usage',
      q => q.eq('period_start', periodStart).eq('period_end', periodEnd), 'id, store_code, material_code');
    const toDelete = (existing || []).filter(e => keys.has(`${e.store_code}||${e.material_code}`)).map(e => e.id);
    if (toDelete.length) await deleteInChunks('material_usage', toDelete);

    const { error } = await sb.from('material_usage').insert(rows);
    if (error) { flash($('#usageSaveMsg'), '저장 실패: ' + error.message, false); return; }
    usageGridBody.innerHTML = '';
    for (let i = 0; i < 3; i++) addUsageRow();
    flash($('#usageSaveMsg'), `${rows.length}개 행이 저장되었습니다.${toDelete.length ? ` (${periodStart}~${periodEnd} 내 겹치는 ${toDelete.length}개 교체됨)` : ''}`);
    await loadUsageView();
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

let usageViewCache = [];
async function loadUsageView() {
  if (!state.currentSeasonId) return;
  const { data: raw, error } = await fetchAllRows('material_usage', q => applySeasonDateFilter(q, 'period_end'));
  if (error) { console.error(error); return; }
  usageViewCache = raw || [];
  await loadUsageAccumView();
  loadAndRenderUnclassifiedMaterials();
}

// 자재코드(별칭 그룹) 기준으로, remark가 한 번이라도 채워진 적 있는 자재의 분류를 모아 lookup을 만든다.
// 저장 시 이 lookup으로 비고/품목/과세여부를 자동으로 채운다 — 매번 다시 입력할 필요가 없어짐.
// codesOfInterest를 주면 그 자재코드(+별칭 그룹)만 조회한다 — 자재사용량이 대량으로 쌓인 뒤로는 흔한 자재
// 하나가 수백~수천 행에 걸쳐 있어서, 코드로만 좁혀도(.in) 여전히 수만 행을 읽어와 1분 넘게 걸렸다
// (저장 버튼이 멈춘 것처럼 보인 원인). 코드마다 "분류값 있는 행 1개"만 병렬로 조회하면 충분하다 —
// 같은 코드의 모든 행은 어차피 같은 분류를 쓰므로. 미분류 자재 후보 매칭처럼 전체 풀이 필요한 경우엔
// codesOfInterest를 생략해 기존처럼 전체를 스캔한다.
async function buildMaterialClassificationLookup(codesOfInterest) {
  const aliasRes = await sb.from('material_aliases').select('primary_material_code, alt_material_code').eq('status', 'confirmed');
  const parent = new Map();
  const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  (aliasRes.data || []).forEach(a => union(a.primary_material_code, a.alt_material_code));

  let usageRows;
  if (codesOfInterest && codesOfInterest.length) {
    // 별칭 그룹 멤버(같은 대표 코드로 묶인 다른 자재코드들)까지 포함해서 조회 범위를 넓힌다 —
    // 저장하려는 코드 자체엔 분류 이력이 없어도, 별칭으로 묶인 다른 코드에 이력이 있을 수 있다.
    const groupMembers = new Map(); // 대표코드 -> Set(그 그룹의 모든 코드)
    (aliasRes.data || []).forEach(a => {
      [a.primary_material_code, a.alt_material_code].forEach(code => {
        const r = find(code);
        if (!groupMembers.has(r)) groupMembers.set(r, new Set());
        groupMembers.get(r).add(code);
      });
    });
    const expanded = new Set();
    codesOfInterest.forEach(code => {
      expanded.add(code);
      (groupMembers.get(find(code)) || []).forEach(c => expanded.add(c));
    });
    const codeList = [...expanded];
    usageRows = [];
    const chunkSize = 20;
    for (let i = 0; i < codeList.length; i += chunkSize) {
      const chunk = codeList.slice(i, i + chunkSize);
      const results = await Promise.all(chunk.map(code =>
        sb.from('material_usage').select('material_code, remark, item_name, tax_status')
          .eq('material_code', code).not('remark', 'is', null).limit(1)
      ));
      results.forEach(r => { if (r.data && r.data[0]) usageRows.push(r.data[0]); });
    }
  } else {
    const res = await fetchAllRows('material_usage', q => q.not('remark', 'is', null), 'material_code, remark, item_name, tax_status');
    usageRows = res.data;
  }

  const classificationByGroup = new Map(); // 별칭그룹 대표코드 -> {remark, item_name, tax_status}
  (usageRows || []).forEach(r => {
    if (!r.material_code) return;
    const key = find(r.material_code);
    if (!classificationByGroup.has(key)) classificationByGroup.set(key, { remark: r.remark, item_name: r.item_name, tax_status: r.tax_status });
  });

  const byCode = new Map();
  const allCodes = new Set([...(usageRows || []).map(r => r.material_code), ...parent.keys()]);
  allCodes.forEach(code => {
    const cls = classificationByGroup.get(find(code));
    if (cls) byCode.set(code, cls);
  });
  return byCode;
}

// 이 시즌에 remark(비고)가 없는 자재 — 농산 모니터링 등에서 조용히 빠지는 자재를 눈에 띄게 보여주고,
// 이름이 비슷한 이미 분류된 자재가 있으면 "자재 매칭 후보"와 같은 방식으로 추천해서 한 번 클릭으로 적용할 수 있게 한다.
let unclassifiedCandidatesByCode = new Map(); // material_code -> {name, remark, item_name, tax_status, similarity} | null
async function loadAndRenderUnclassifiedMaterials() {
  const byCode = new Map(); // material_code -> { name, totalAmount }
  usageViewCache.forEach(r => {
    if (r.remark || !r.material_code) return;
    if (!byCode.has(r.material_code)) byCode.set(r.material_code, { name: r.material_name || r.material_code, totalAmount: 0 });
    byCode.get(r.material_code).totalAmount += Number(r.actual_usage_amount) || 0;
  });
  const rows = [...byCode.entries()].sort((a, b) => b[1].totalAmount - a[1].totalAmount);

  unclassifiedCandidatesByCode = new Map();
  if (rows.length) {
    // 이미 분류된 자재 풀(자재코드 단위, 시즌 무관)에서 이름이 비슷한 후보를 찾는다.
    // 품목·과세여부는 잘못 추천되면 회계상 영향이 있어서, 별칭 판별과 같은 엄격한 기준(0.9)을 쓴다.
    const { data: classifiedRows } = await fetchAllRows('material_usage', q => q.not('remark', 'is', null), 'material_code, material_name, remark, item_name, tax_status');
    const classifiedPool = new Map();
    (classifiedRows || []).forEach(r => { if (r.material_code && !classifiedPool.has(r.material_code)) classifiedPool.set(r.material_code, r); });

    rows.forEach(([code, r]) => {
      let best = null;
      classifiedPool.forEach((c, candCode) => {
        if (candCode === code) return;
        const sim = materialNameSimilarity(r.name, c.material_name);
        if (sim >= MATERIAL_ALIAS_THRESHOLD && (!best || sim > best.similarity)) {
          best = { code: candCode, name: c.material_name, remark: c.remark, item_name: c.item_name, tax_status: c.tax_status, similarity: sim };
        }
      });
      if (best) unclassifiedCandidatesByCode.set(code, best);
    });
  }

  $('#unclassifiedMaterialsBody').innerHTML = rows.map(([code, r]) => {
    const cand = unclassifiedCandidatesByCode.get(code);
    const candCell = cand
      ? `${cand.item_name || cand.name} <span class="hint">(비고:${cand.remark ?? '-'} · 과세:${cand.tax_status ?? '-'} · 유사도 ${Math.round(cand.similarity * 100)}%)</span> ` +
        `<button type="button" class="btn btn-sm btn-primary apply-classification-btn" data-code="${code}">적용</button>`
      : `<span class="hint">후보 없음</span>`;
    return `
    <tr data-code="${code}">
      <td>${code}</td>
      <td class="cell-left">${r.name}</td>
      <td>${fmtNum(r.totalAmount, 0)}</td>
      <td class="cell-left">${candCell}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4" style="text-align:center;color:var(--muted)">미분류 자재가 없습니다.</td></tr>`;

  $$('.apply-classification-btn', $('#unclassifiedMaterialsBody')).forEach(btn => {
    btn.addEventListener('click', () => applyUnclassifiedCandidate(btn.dataset.code));
  });
}

// 추천 후보의 비고/품목/과세여부를, 이 자재코드가 등장한 모든 material_usage 행(시즌 무관)에 그대로 적용한다.
async function applyUnclassifiedCandidate(code) {
  const cand = unclassifiedCandidatesByCode.get(code);
  if (!cand) return;
  const { error } = await sb.from('material_usage')
    .update({ remark: cand.remark, item_name: cand.item_name, tax_status: cand.tax_status })
    .eq('material_code', code);
  if (error) { flash($('#usageBulkMsg'), '분류 적용 실패: ' + error.message, false); return; }
  flash($('#usageBulkMsg'), `${code} 자재에 "${cand.item_name || cand.name}" 분류를 적용했습니다.`);
  await loadUsageView();
}

// "자재 누적 현황" — 시즌과 무관하게(season_id/시즌 범위 상관없이) 선택한 연월의 자재사용량 원본을 그대로 보여준다.
// 시즌 전체를 다 훑으면(27만행+) 느려서, 항상 연월로 서버에서 직접 좁혀서 조회한다.
let usageAccumCache = [];
const USAGE_ACCUM_COLS = 'id, usage_month, period_start, period_end, store_name, material_name, remark, item_name, tax_status, stock_unit, conversion_factor, actual_usage_qty, actual_usage_amount';
async function loadUsageAccumView() {
  const monthFilter = $('#usageViewMonthFilter').value; // "YYYY-MM"
  if (!monthFilter) { usageAccumCache = []; renderUsageAccumView(); return; }
  $('#usageViewBody').innerHTML = `<tr><td colspan="12" style="text-align:center;color:var(--muted)">불러오는 중...</td></tr>`;
  const { data, error } = await fetchAllRows('material_usage', q => q.eq('usage_month', `${monthFilter}-01`), USAGE_ACCUM_COLS);
  if (error) { console.error(error); return; }
  usageAccumCache = data || [];
  renderUsageAccumView();
}

function renderUsageAccumView() {
  const data = usageAccumCache.slice()
    .sort((a, b) => (Number(b.actual_usage_amount) || 0) - (Number(a.actual_usage_amount) || 0));
  const body = $('#usageViewBody');
  body.innerHTML = (data || []).map(r => `
    <tr data-id="${r.id}">
      <td class="col-check"><input type="checkbox" class="row-check"></td>
      <td>${r.usage_month ? r.usage_month.slice(0, 7) : '-'}</td>
      <td>${r.period_start && r.period_end ? `${r.period_start.slice(5)} ~ ${r.period_end.slice(5)}` : '-'}</td>
      <td>${r.store_name ?? '-'}</td>
      <td>${r.material_name ?? '-'}</td>
      <td>${r.remark ?? '-'}</td>
      <td>${r.item_name ?? '-'}</td>
      <td>${r.tax_status ?? '-'}</td>
      <td>${r.stock_unit ?? '-'}</td>
      <td>${fmtNum(r.conversion_factor, 1)}</td>
      <td>${fmtNum(r.actual_usage_qty, 2)}</td>
      <td>${fmtNum(r.actual_usage_amount, 0)}</td>
    </tr>
  `).join('') || `<tr><td colspan="12" style="text-align:center;color:var(--muted)">데이터가 없습니다.</td></tr>`;
}

// 연월 기본값은 현재 달로 맞추고, 페이지 로드 시 바로 한 번 불러온다(시즌 선택과 무관하게 동작).
(() => {
  const now = new Date();
  $('#usageViewMonthFilter').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
})();
loadUsageAccumView();
$('#usageViewMonthFilter').addEventListener('change', loadUsageAccumView);

$('#usageSelectAll').addEventListener('change', (e) => {
  $$('#usageViewBody .row-check').forEach(cb => { cb.checked = e.target.checked; });
});

$('#bulkDeleteUsageBtn').addEventListener('click', async () => {
  const ids = $$('#usageViewBody tr').filter(tr => tr.querySelector('.row-check')?.checked).map(tr => Number(tr.dataset.id));
  if (!ids.length) { flash($('#usageBulkMsg'), '선택된 항목이 없습니다.', false); return; }
  if (!confirm(`${ids.length}개 행을 삭제할까요?`)) return;
  const { error } = await deleteInChunks('material_usage', ids);
  if (error) { flash($('#usageBulkMsg'), '삭제 실패: ' + error.message, false); return; }
  $('#usageSelectAll').checked = false;
  flash($('#usageBulkMsg'), `${ids.length}개 삭제되었습니다.`);
  await loadUsageAccumView();
});

// =====================================================================
// Tab 7: Store sales / customers (매출/객수)
// =====================================================================
const SALES_FIELDS = ['store_code', 'store_name', 'sales_date', 'weekday', 'is_holiday',
  'sales_lunch', 'sales_dinner', 'sales_total', 'customers_lunch', 'customers_dinner', 'customers_total'];
const SALES_NUMERIC_FROM = 5;

const salesGridBody = $('#salesGridBody');
function addSalesRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = SALES_FIELDS.map((f, i) => {
    const isNumeric = i >= SALES_NUMERIC_FROM;
    return `<td><input type="text" ${isNumeric ? 'inputmode="decimal"' : ''} data-col="${i}"></td>`;
  }).join('') + `<td><button type="button" class="row-del-btn" title="삭제">×</button></td>`;
  tr.querySelector('.row-del-btn').addEventListener('click', () => tr.remove());
  salesGridBody.appendChild(tr);
  return tr;
}
for (let i = 0; i < 3; i++) addSalesRow();
$('#addSalesRowBtn').addEventListener('click', () => addSalesRow());
attachPasteFill(salesGridBody, addSalesRow);

$('#saveSalesGridBtn').addEventListener('click', async () => {
  if (!state.currentSeasonId) return;
  const rows = [];
  $$('tr', salesGridBody).forEach(tr => {
    const values = SALES_FIELDS.map((_, i) => tr.querySelector(`input[data-col="${i}"]`).value);
    if (!values[2]) return; // need a date
    const rec = { season_id: state.currentSeasonId };
    SALES_FIELDS.forEach((f, i) => {
      rec[f] = (i >= SALES_NUMERIC_FROM) ? numOrNull(values[i]) : (values[i] ? values[i].trim() : null);
    });
    rows.push(rec);
  });
  if (!rows.length) { flash($('#salesSaveMsg'), '입력된 행이 없습니다.', false); return; }

  // 같은 시즌에 매장+날짜 조합이 이미 있으면(재업로드로 겹치는 기간) 이전 값을 지우고 새 값으로 교체
  const keys = new Set(rows.map(r => `${r.store_code}||${r.sales_date}`));
  const { data: existing } = await fetchAllRows('store_sales', q => applySeasonDateFilter(q, 'sales_date'), 'id, store_code, sales_date');
  const toDelete = (existing || []).filter(e => keys.has(`${e.store_code}||${e.sales_date}`)).map(e => e.id);
  if (toDelete.length) await deleteInChunks('store_sales', toDelete);

  const { error } = await sb.from('store_sales').insert(rows);
  if (error) { flash($('#salesSaveMsg'), '저장 실패: ' + error.message, false); return; }
  salesGridBody.innerHTML = '';
  for (let i = 0; i < 3; i++) addSalesRow();
  flash($('#salesSaveMsg'), `${rows.length}개 행이 저장되었습니다.${toDelete.length ? ` (겹치는 ${toDelete.length}개 교체됨)` : ''}`);
  await loadSalesView();
});

let salesViewCache = [];
async function loadSalesView() {
  if (!state.currentSeasonId) return;
  const { data: raw, error } = await fetchAllRows('store_sales', q => applySeasonDateFilter(q, 'sales_date'));
  if (error) { console.error(error); return; }
  salesViewCache = raw || [];
  renderSalesView();
}

function renderSalesView() {
  const monthFilter = $('#salesViewMonthFilter').value; // "YYYY-MM"
  const data = salesViewCache
    .filter(r => !monthFilter || (r.sales_date || '').slice(0, 7) === monthFilter)
    .slice()
    .sort((a, b) => (b.sales_date || '').localeCompare(a.sales_date || ''));
  const body = $('#salesViewBody');
  body.innerHTML = (data || []).map(r => `
    <tr data-id="${r.id}">
      <td class="col-check"><input type="checkbox" class="row-check"></td>
      <td>${r.store_name ?? '-'}</td>
      <td>${r.sales_date ?? '-'}</td>
      <td>${r.is_holiday ?? '-'}</td>
      <td>${fmtNum(r.sales_total, 0)}</td>
      <td>${fmtNum(r.customers_total, 0)}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--muted)">데이터가 없습니다.</td></tr>`;
}

$('#salesViewMonthFilter').addEventListener('change', renderSalesView);

$('#salesSelectAll').addEventListener('change', (e) => {
  $$('#salesViewBody .row-check').forEach(cb => { cb.checked = e.target.checked; });
});

$('#bulkDeleteSalesBtn').addEventListener('click', async () => {
  const ids = $$('#salesViewBody tr').filter(tr => tr.querySelector('.row-check')?.checked).map(tr => Number(tr.dataset.id));
  if (!ids.length) { flash($('#salesBulkMsg'), '선택된 항목이 없습니다.', false); return; }
  if (!confirm(`${ids.length}개 행을 삭제할까요?`)) return;
  const { error } = await deleteInChunks('store_sales', ids);
  if (error) { flash($('#salesBulkMsg'), '삭제 실패: ' + error.message, false); return; }
  $('#salesSelectAll').checked = false;
  flash($('#salesBulkMsg'), `${ids.length}개 삭제되었습니다.`);
  await loadSalesView();
});

// =====================================================================
// Tab: Market prices (시장 데이터) — Excel file upload
// =====================================================================
function excelCellToDateStr(val) {
  if (val instanceof Date) {
    return `${val.getFullYear()}-${String(val.getMonth() + 1).padStart(2, '0')}-${String(val.getDate()).padStart(2, '0')}`;
  }
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(/[./]/g, '-').replace(/-+$/, '');
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(cleaned)) {
      const [y, m, d] = cleaned.split('-');
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }
  return null;
}

function excelCellToNumber(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/,/g, '').trim();
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

$('#marketFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msgEl = $('#marketUploadMsg');
  flash(msgEl, '파일 읽는 중...', true);
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
    if (rows.length < 2) { flash(msgEl, '데이터가 없습니다.', false); return; }

    const market_name = $('#marketNameSelect').value;
    // 같은 배치에 (날짜+품목+품종+등급+시장)이 중복되면 upsert가 "같은 행을 두 번 갱신"하며 에러가 나므로
    // Map으로 걸러서 마지막 값만 남긴다 (원본 파일에 중복행이 있는 경우 대비).
    const recordMap = new Map();
    rows.slice(1).forEach(r => {
      if (!r || !r.length) return;
      const record_date = excelCellToDateStr(r[0]);
      const item_name = (r[1] ?? '').toString().trim();
      if (!record_date || !item_name) return;
      const variety = (r[2] ?? '').toString().trim() || null;
      const grade = (r[3] ?? '').toString().trim() || null;
      const key = `${record_date}||${item_name}||${variety}||${grade}||${market_name}`;
      recordMap.set(key, {
        record_date, item_name, variety, grade, market_name,
        unit: (r[4] ?? '').toString().trim() || null,
        min_price: excelCellToNumber(r[5]),
        max_price: excelCellToNumber(r[6]),
        avg_price: excelCellToNumber(r[7]),
        change_prev_day: excelCellToNumber(r[8]),
        change_prev_avg: r[9] != null ? String(r[9]) : null,
        change_7day_avg: r[10] != null ? String(r[10]) : null,
        change_prev_year_avg: r[11] != null ? String(r[11]) : null,
      });
    });
    const records = [...recordMap.values()];
    if (!records.length) { flash(msgEl, '읽을 수 있는 행이 없습니다.', false); return; }

    // 같은 날짜+품목+품종+등급+시장이면 upsert로 자동 교체 (재업로드 대비), 대량 데이터는 나눠서 전송
    const chunkSize = 500;
    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      const { error } = await sb.from('market_prices').upsert(chunk, { onConflict: 'record_date,item_name,variety,grade,market_name' });
      if (error) { flash(msgEl, '저장 실패: ' + error.message, false); return; }
    }
    flash(msgEl, `${records.length}건 저장되었습니다.${records.length < rows.length - 1 ? ` (원본에 중복행 ${rows.length - 1 - records.length}건 있어 병합됨)` : ''}`);
    e.target.value = '';
    await loadMarketView();
  } catch (err) {
    flash(msgEl, '파일 처리 실패: ' + err.message, false);
  }
});

let marketRowsCache = [];
async function loadMarketView() {
  const { data, error } = await fetchAllRows('market_prices', q => q.order('record_date', { ascending: false }));
  if (error) { console.error(error); return; }
  marketRowsCache = data || [];
  renderMarketView();
}

function renderMarketView() {
  const search = $('#marketSearch').value.trim();
  const monthFilter = $('#marketMonthFilter').value;
  const marketFilter = $('#marketNameFilter').value;
  const rows = marketRowsCache.filter(r =>
    (!search || (r.item_name || '').includes(search)) &&
    (!monthFilter || (r.record_date || '').slice(0, 7) === monthFilter) &&
    (!marketFilter || r.market_name === marketFilter)
  );
  const body = $('#marketViewBody');
  body.innerHTML = rows.slice(0, 2000).map(r => `
    <tr data-id="${r.id}">
      <td class="col-check"><input type="checkbox" class="row-check"></td>
      <td>${r.market_name ?? '-'}</td>
      <td>${r.record_date ?? '-'}</td>
      <td>${r.item_name ?? '-'}</td>
      <td>${r.variety ?? '-'}</td>
      <td>${r.grade ?? '-'}</td>
      <td>${r.unit ?? '-'}</td>
      <td>${fmtNum(r.min_price, 0)}</td>
      <td>${fmtNum(r.max_price, 0)}</td>
      <td>${fmtNum(r.avg_price, 0)}</td>
    </tr>
  `).join('') || `<tr><td colspan="10" style="text-align:center;color:var(--muted)">데이터가 없습니다.</td></tr>`;
}

['marketSearch', 'marketMonthFilter', 'marketNameFilter'].forEach(id => {
  $(`#${id}`).addEventListener('input', renderMarketView);
  $(`#${id}`).addEventListener('change', renderMarketView);
});

$('#marketSelectAll').addEventListener('change', (e) => {
  $$('#marketViewBody .row-check').forEach(cb => { cb.checked = e.target.checked; });
});

$('#bulkDeleteMarketBtn').addEventListener('click', async () => {
  const ids = $$('#marketViewBody tr').filter(tr => tr.querySelector('.row-check')?.checked).map(tr => Number(tr.dataset.id));
  if (!ids.length) { flash($('#marketBulkMsg'), '선택된 항목이 없습니다.', false); return; }
  if (!confirm(`${ids.length}개 행을 삭제할까요?`)) return;
  const { error } = await deleteInChunks('market_prices', ids);
  if (error) { flash($('#marketBulkMsg'), '삭제 실패: ' + error.message, false); return; }
  $('#marketSelectAll').checked = false;
  flash($('#marketBulkMsg'), `${ids.length}개 삭제되었습니다.`);
  await loadMarketView();
});

// =====================================================================
// Generic Excel-paste-fill for editable grids
// =====================================================================
function attachPasteFill(tbody, addRowFn) {
  tbody.addEventListener('paste', (e) => {
    const target = e.target;
    if (target.tagName !== 'INPUT') return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text.includes('\t') && !text.includes('\n')) return;
    e.preventDefault();
    const rows = text.replace(/\r/g, '').split('\n').filter((line, i, arr) => !(i === arr.length - 1 && line === ''));
    const startRow = Array.from(tbody.rows).indexOf(target.closest('tr'));
    const startCol = Number(target.dataset.col);
    rows.forEach((rowText, ri) => {
      let rowEl = tbody.rows[startRow + ri];
      if (!rowEl) rowEl = addRowFn();
      const cells = rowText.split('\t');
      cells.forEach((val, ci) => {
        const col = startCol + ci;
        const inp = rowEl.querySelector(`input[data-col="${col}"]`);
        if (inp) inp.value = cleanPastedValue(val, inp.type);
      });
    });
  });
}

// Excel often pastes thousand-separated numbers ("543,200") or error strings ("#DIV/0!").
// Number inputs silently discard any value that doesn't parse, so sanitize before assigning.
function cleanPastedValue(raw, inputType) {
  const trimmed = raw.trim();
  if (inputType !== 'number') return trimmed;
  if (!/^-?[\d,]*\.?\d*$/.test(trimmed)) return ''; // rejects Excel error strings like #DIV/0!
  const cleaned = trimmed.replace(/,/g, '');
  return cleaned !== '' && !Number.isNaN(Number(cleaned)) ? cleaned : '';
}

// =====================================================================
// Tab: 피벗 (조닝→메뉴→자재 3축) — 시즌과 무관하게 전체 기간을 다룬다.
// 사장님이 주신 참고 피벗 도구(로컬 HTML)의 UI/UX를 이식하되, 데이터는 그 도구의 오프라인
// 배치 파이프라인이 아니라 우리 앱의 실시간 계산 엔진(computeMenuConsumption 등)을 재사용한다.
// 1단계(뼈대): 안쪽 탭 전환 + 기간 컨트롤 기본값만 — 실제 표 렌더는 다음 단계에서 연결한다.
// =====================================================================
let pivotTab = 'T';
// 탭 전환/필터 변경마다 늘어나는 토큰 — 계산이 오래 걸리는 동안(①②③ 전부 수 초~수 분) 사용자가 다른 탭으로
// 넘어가면, 나중에 끝난 이전 요청이 지금 보고 있는 탭의 결과를 덮어쓰는 경쟁 상태를 막기 위함.
// 매 로드 시작 시 증가시키고, await 이후 값이 바뀌었으면(그 사이 다른 로드가 시작됐으면) 렌더링을 건너뛴다.
let pivotLoadToken = 0;
function setPivotTab(t) {
  pivotTab = t;
  $$('.pivot-tab-btn[data-pivot-tab]').forEach(b => b.classList.toggle('is-on', b.dataset.pivotTab === t));
  $('#pivotPanelTarget').style.display = t === 'T' ? '' : 'none';
  $('#pivotPanelMain').style.display = t === 'T' ? 'none' : '';
  $('#pivotCtlAB').style.display = (t === 'A' || t === 'B') ? '' : 'none';
  $('#pivotCtlC').style.display = t === 'C' ? '' : 'none';
  $('#pivotCtlD').style.display = t === 'D' ? '' : 'none';
  $('#pivotVeSummary').style.display = t === 'D' ? '' : 'none';
  $('#pivotStoreSelectBox').style.display = t === 'A' ? '' : 'none';
  $('#pivotResetOrderBtn').style.display = t === 'B' ? '' : 'none';
  if (t === 'T') loadDashboard();
  if (t === 'A' || t === 'B') loadPivotCompareView();
  if (t === 'C') loadPivotTimeSeriesView();
  if (t === 'D') loadPivotVEView();
}
$$('.pivot-tab-btn[data-pivot-tab]').forEach(btn => {
  btn.addEventListener('click', () => setPivotTab(btn.dataset.pivotTab));
});

// 시즌설계·데이터 그룹처럼, 피벗과 같은 서브탭 디자인(.pivot-tabs/.pivot-tab-btn)을 재사용하되
// 피벗 전용 로직(setPivotTab)과는 무관하게 그냥 보이기/숨기기만 하면 되는 탭들의 공용 처리.
$$('.pivot-tab-btn[data-subtab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = btn.closest('.tab-panel');
    $$('.pivot-tab-btn[data-subtab]', panel).forEach(b => b.classList.toggle('is-on', b === btn));
    $$('.subtab-panel', panel).forEach(p => p.classList.toggle('is-active', p.id === 'subtab-' + btn.dataset.subtab));
    if (btn.dataset.subtab === 'market' && !marketViewLoaded) { marketViewLoaded = true; loadMarketView(); }
    if (btn.dataset.subtab === 'season-pilot') loadSeasonPilotView();
  });
});

function renderPivotWeekOptions() {
  const monthValue = $('#pivotMonthInput').value;
  const sel = $('#pivotWeekSelect');
  if (!monthValue) { sel.innerHTML = ''; return; }
  const [y, m] = monthValue.split('-').map(Number);
  const weeks = computeWeekOptionsForMonth(y, m);
  sel.innerHTML = weeks.map(w => `<option value="${w.periodStart}|${w.periodEnd}">${w.label}</option>`).join('');
  if (weeks.length) sel.value = `${weeks[weeks.length - 1].periodStart}|${weeks[weeks.length - 1].periodEnd}`;
}
function renderPivotSeasonOptions() {
  const sel = $('#pivotSeasonSelect');
  const cur = sel.value;
  const withRange = state.seasons.filter(s => s.start_month && s.end_month);
  sel.innerHTML = withRange.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  if (withRange.some(s => String(s.id) === cur)) sel.value = cur;
  else if (state.currentSeasonId && withRange.some(s => s.id === state.currentSeasonId)) sel.value = state.currentSeasonId;
}
function updatePivotUnitVisibility() {
  const unit = $('#pivotUnitSelect').value;
  $('#pivotMonthInput').style.display = unit === 's' ? 'none' : '';
  $('#pivotWeekSelect').style.display = unit === 'w' ? '' : 'none';
  $('#pivotSeasonSelect').style.display = unit === 's' ? '' : 'none';
  if (unit === 's') renderPivotSeasonOptions();
}
(() => {
  const now = new Date();
  $('#pivotMonthInput').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  renderPivotWeekOptions();
  updatePivotUnitVisibility();
})();
$('#pivotMonthInput').addEventListener('change', renderPivotWeekOptions);
$('#pivotUnitSelect').addEventListener('change', updatePivotUnitVisibility);
$('#pivotSeasonSelect').addEventListener('change', loadPivotCompareView);

// ---- ①비교 ②전매장 공용 엔진 ----
// 매장군: storeType()의 value/regular/premium을 그대로 재사용.
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function pivotShortName(n) { return (n || '').replace('로운샤브 프리미엄 ', '[프] ').replace('로운 ', ''); }
// ③전매장처럼 매장이 다닥다닥 나열될 때, 등급(프리미엄/일반/199-229) 라벨을 열 위에 따로 붙여주므로
// 매장명 자체에서는 브랜드/체인 접두어를 다 떼고 "OO점"만 남긴다.
const PIVOT_CHAIN_PREFIXES = ['로운샤브 프리미엄 ', '로운 ', 'NC ', '뉴코아 ', '이마트 ', '롯데몰 ', '롯데백화점 ', '스타필드마켓 '];
function pivotVeryShortName(n) {
  let s = n || '';
  PIVOT_CHAIN_PREFIXES.forEach(p => { s = s.replace(p, ''); });
  return s;
}
const PIVOT_TIER_LABEL = { premium: '프리미엄', regular: '일반', value: '199-229' };
function pivotDateRangeFromControls() {
  const unit = $('#pivotUnitSelect').value;
  if (unit === 's') {
    const seasonId = Number($('#pivotSeasonSelect').value);
    const season = state.seasons.find(s => s.id === seasonId);
    if (!season) return null;
    // 시즌 단위는 그 시즌의 시작~끝을 그대로 쓴다 — 월별처럼 달력 경계로 자르면 다른 시즌의
    // 레시피가 섞여 들어가는 문제(예: 7월 조회가 26년초여름/26년여름 레시피를 뒤섞음)가 생기지 않는다.
    return { start: season.start_month, end: season.end_month, seasonId };
  }
  const monthValue = $('#pivotMonthInput').value;
  if (!monthValue) return null;
  if (unit === 'w') {
    const weekVal = $('#pivotWeekSelect').value;
    if (!weekVal) return null;
    const [ps, pe] = weekVal.split('|');
    return { start: ps, end: pe };
  }
  const [y, m] = monthValue.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${monthValue}-01`, end: `${monthValue}-${String(lastDay).padStart(2, '0')}` };
}

let pivotCompareCache = null;
let pivotCollapsed = {};
let pivotOpenIng = {};
let pivotTsCollapsed = {};

// ---- 종료된 시즌 결과 캐싱 (pivot_snapshot 테이블) ----
// ①②③ 탭 전부 "매장별 실사용 근거로 그램수 추정"(computeMenuConsumption의 매장별 IPF)이 제일 오래 걸리는데,
// 이미 끝난 시즌은 원본 데이터가 더 안 바뀌니 한 번 계산한 결과(매장×메뉴별 그램·손님수)를 저장해두고
// 재사용한다. 진행 중인 시즌은 계속 그때그때 새로 계산한다.
function isSeasonClosed(season) {
  if (!season?.end_month) return false;
  const todayStr = new Date().toISOString().slice(0, 10);
  return season.end_month < todayStr;
}
async function fetchPivotSnapshot(seasonId, periodUnit, periodStart, periodEnd) {
  const { data, error } = await fetchAllRows('pivot_snapshot', q => q
    .eq('season_id', seasonId).eq('period_unit', periodUnit)
    .eq('period_start', periodStart).eq('period_end', periodEnd));
  if (error || !data || !data.length) return null;
  return data;
}
// 저장된 스냅샷 행들을 computeMenuConsumption의 results 배열과 같은 모양(메뉴별 per_store)으로 복원한다 —
// pivotGroupValue는 store_code/grams/store_customers만 보므로 이 세 필드만 있으면 충분하다.
function reconstructResultsFromSnapshot(rows) {
  const byMenu = new Map();
  rows.forEach(r => {
    if (!byMenu.has(r.menu_name)) byMenu.set(r.menu_name, { menu_name: r.menu_name, per_store: [] });
    byMenu.get(r.menu_name).per_store.push({ store_code: r.store_code, grams: r.grams, store_customers: r.store_customers });
  });
  return [...byMenu.values()];
}
async function savePivotSnapshotFromResults(seasonId, periodUnit, periodStart, periodEnd, results) {
  const rows = [];
  (results || []).forEach(r => {
    (r.per_store || []).forEach(s => {
      rows.push({
        season_id: seasonId, period_unit: periodUnit, period_start: periodStart, period_end: periodEnd,
        store_code: s.store_code, menu_name: r.menu_name,
        grams: s.grams ?? null, store_customers: s.store_customers ?? null,
      });
    });
  });
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    await sb.from('pivot_snapshot').upsert(batch, { onConflict: 'season_id,period_unit,period_start,period_end,store_code,menu_name' });
  }
}

// designByMenu(menu_designs)에 없어도 recipe_items에 레시피가 등록된 메뉴는 존/합계 계산에서 빠지면 안 된다
// ("메뉴별 소비액"과 같은 원칙 — 레시피 등록이 실제 메뉴 목록의 기준. 설계원가는 최초 계획일 뿐).
// 안 그러면 그 메뉴의 실사용량이 피벗 총액/존 합계에서 조용히 빠져 원가율이 실제보다 낮게 나온다.
function unionDesignByMenu(designByMenu, categoryByMenu) {
  const out = new Map(designByMenu);
  (categoryByMenu || new Map()).forEach((category, menu) => {
    if (!menu || menu.startsWith('#') || out.has(menu)) return;
    out.set(menu, { menu_name: menu, category, cost_per_gram: null });
  });
  return out;
}

async function loadPivotCompareData() {
  const dateRange = pivotDateRangeFromControls();
  if (!dateRange) return { error: '기간을 선택해주세요.' };
  const seasonId = findSeasonIdForDate(dateRange.end);
  if (!seasonId) return { error: '해당 기간을 포함하는 시즌이 없습니다.' };
  const season = state.seasons.find(s => s.id === seasonId);
  const unit = $('#pivotUnitSelect').value;
  const periodUnit = unit === 's' ? 'season' : unit === 'w' ? 'week' : 'month';
  const closed = isSeasonClosed(season);

  // 캐시 확인은 가벼운 단건 조회라 먼저 해보고, 없을 때만 느린 계산(computeMenuConsumption)을
  // 나머지 조회들과 "같이" 병렬로 돌린다 — 순서대로(직렬로) 돌리면 원래 하나로 끝나던 대기시간이
  // 두 배 가까이 늘어난다(실측: 이 실수로 5~6분짜리가 20분 넘게 걸림).
  let cachedRows = null;
  if (closed) cachedRows = await fetchPivotSnapshot(seasonId, periodUnit, dateRange.start, dateRange.end);

  const basePromises = [
    getActualCostPerGram(seasonId),
    fetchAllRows('menu_designs', q => q.eq('season_id', seasonId)),
    fetchAllRows('store_sales', q => q.gte('sales_date', dateRange.start).lt('sales_date', nextDay(dateRange.end)),
      'store_code, store_name, sales_total, customers_total'),
    getFlatForSeason(seasonId),
    fetchAllRows('category_summary', q => q.eq('season_id', seasonId)),
    getTargetPrice(seasonId),
    getActualCostPerGramByStore(seasonId),
  ];
  if (!cachedRows) basePromises.push(computeMenuConsumption(null, dateRange));
  const settled = await Promise.all(basePromises);
  const [costResult, designsRes, salesRes, flat, categorySummaryRes, targetPrice, costByStoreResult] = settled;
  if (costResult.error) return { error: costResult.error };
  const costByMenuStore = costByStoreResult.error ? new Map() : costByStoreResult.byMenu;
  if (designsRes.error) return { error: designsRes.error.message || String(designsRes.error) };
  if (salesRes.error) return { error: salesRes.error.message || String(salesRes.error) };
  if (categorySummaryRes.error) return { error: categorySummaryRes.error.message || String(categorySummaryRes.error) };

  let results = null, fromCache = false;
  if (cachedRows) { results = reconstructResultsFromSnapshot(cachedRows); fromCache = true; }
  if (!results) {
    const consumption = settled[7];
    if (consumption.error) return { error: consumption.error };
    results = consumption.results;
    if (closed) savePivotSnapshotFromResults(seasonId, periodUnit, dateRange.start, dateRange.end, results);
  }

  const rawDesignByMenu = new Map();
  (designsRes.data || []).forEach(d => { if (d.menu_name) rawDesignByMenu.set(d.menu_name, d); });
  const designByMenu = unionDesignByMenu(rawDesignByMenu, flat.categoryByMenu);
  const costByMenu = new Map((costResult.results || []).map(r => [r.menu_name, r.actual_cost_per_gram]));
  const targetByCategory = new Map();
  // 통합조닝 시절의 낡은 category_summary 행("월남쌈/죽", "음료/디저트" 등)이 남아있을 수 있어,
  // 대시보드/목표원가 탭과 똑같이 현재 조닝 목록(DASHBOARD_CATEGORIES)만 골라 쓴다.
  (categorySummaryRes.data || []).forEach(r => { if (r.category && DASHBOARD_CATEGORIES.includes(r.category)) targetByCategory.set(r.category, r); });

  const storeAgg = new Map();
  (salesRes.data || []).forEach(r => {
    if (!r.store_code) return;
    if (!storeAgg.has(r.store_code)) {
      storeAgg.set(r.store_code, { code: r.store_code, name: r.store_name || r.store_code, sales: 0, guests: 0, type: storeType(r.store_code, r.store_name) });
    }
    const e = storeAgg.get(r.store_code);
    e.sales += Number(r.sales_total) || 0;
    e.guests += Number(r.customers_total) || 0;
  });
  const stores = [...storeAgg.values()].sort((a, b) => b.guests - a.guests);

  return {
    dateRange, seasonId, results, designByMenu, costByMenu, costByMenuStore, stores, flat, targetByCategory, targetPrice, fromCache,
    rawCodePricePerGram: costResult.rawCodePricePerGram, clusterMembers: costResult.clusterMembers,
    aliasNameByCode: costResult.aliasNameByCode, findMaterial: costResult.find,
    usageByStoreRawCode: costByStoreResult.usageByStoreRawCode,
  };
}

// storeCodes에 속한 매장들의 실제 그램·손님수를 합산 (데이터 있는 매장만 그램에 반영, 손님수는 항상 반영).
// storeCodes 중 일부 매장에만 실사용 데이터가 있으면(예: 신규 자재라 몇 매장만 보고), 그 매장들만의
// 인당소비율(rate)을 그룹 전체 손님수로 확장해서 추정한다 — 데이터 있는 매장 grams만 그대로 더하고
// 데이터 유무와 무관한 그룹 전체 손님수로 나누면 분자가 과소해져 값이 실제보다 크게 깎인다
// (이번 세션에 브랜드 실적 원가율에서 발견해 고쳤던 것과 같은 문제, 피벗 탭에도 동일하게 적용).
function pivotGroupValue(menuResult, storeCodes) {
  let measuredGrams = 0, measuredCustomers = 0, totalCustomers = 0, any = false;
  (menuResult?.per_store || []).forEach(s => {
    if (!storeCodes.includes(s.store_code)) return;
    totalCustomers += s.store_customers || 0;
    if (s.grams != null) { measuredGrams += s.grams; measuredCustomers += s.store_customers || 0; any = true; }
  });
  if (!any || measuredCustomers <= 0) return { grams: null, customers: totalCustomers };
  // 예전엔 측정된 매장의 비율(rate)을 그룹 전체 손님수(totalCustomers)에 곱해 확대했는데,
  // 이러면 "와규/부채살"처럼 매장군 안의 특정 매장 1곳에서만 파는 메뉴가(운영패턴은
  // 매장군 단위로만 등록 가능해 "프리미엄=상시"로 되어 있어도) 매장군 전체·브랜드 전체에
  // 그 한 매장 비율 그대로 반영되는 문제가 있었다(희석이 전혀 안 됨). 실측된 그램만 그대로
  // 쓰면, 전체 매장에 데이터가 있는 메뉴는 결과가 똑같고(measuredCustomers===totalCustomers),
  // 일부 매장만 있는 메뉴는 그 매장 몫만큼만 반영되어 나머지 매장/그룹 비중만큼 자연히 희석된다.
  return { grams: measuredGrams, customers: totalCustomers };
}
// pivotGroupValue와 같은 그룹(매장군/매장)에 대해 금액을 계산하되, 브랜드 전체 평균 단가 하나를
// 곱하는 대신 매장마다 그 매장이 실제로 산 단가를 곱한다(수도권 직송 저가 vs 지방 구매팀 고가처럼
// 매장별로 실제 단가가 다름 — 2026-08-27). costByStoreForMenu에 그 매장 단가가 없으면(그 기간에
// 그 자재를 안 샀거나 다른 자재로 바뀌었다는 신호) 폴백으로 덮어쓰지 않고 그 매장 몫을 그냥 뺀다 —
// 자재 매칭이 안 된 매장은 원가가 작게 나와서 오히려 눈에 띄어야 찾기 쉽다.
function pivotGroupAmount(menuResult, storeCodes, costByStoreForMenu) {
  let amt = 0, grams = 0, any = false;
  (menuResult?.per_store || []).forEach(s => {
    if (!storeCodes.includes(s.store_code) || s.grams == null) return;
    const cost = costByStoreForMenu?.get(s.store_code)?.actual_cost_per_gram;
    if (cost == null) return;
    amt += s.grams * cost;
    grams += s.grams;
    any = true;
  });
  return { amt, grams: any ? grams : null };
}
// 인당소비량(g)/인당소비액(원) 모드에서는 브랜드 대비 %배지 대신, 같은 셀에 그램·금액을
// "주값(부값)" 형태로 함께 보여준다 — 그램 모드에서 뜬금없이 %가 섞여 보이는 걸 없애고
// 대신 같은 인당 실적을 두 단위로 바로 대조할 수 있게 한다.
function pivotValueTxt(mode, amt, grams, customers, netSales) {
  let raw, main, secondary = '';
  if (mode === 'g') {
    raw = (customers && grams != null) ? grams / customers : null;
    main = raw == null ? '—' : fmtNum(raw, 1);
    const moneyPerCustomer = customers ? amt / customers : null;
    secondary = moneyPerCustomer != null ? ` <span class="pivot-d">(${fmtNum(moneyPerCustomer, 0)}원)</span>` : '';
  } else if (mode === 'pg') {
    raw = customers ? amt / customers : null;
    main = raw == null ? '—' : fmtNum(raw, 0);
    const gramPerCustomer = (customers && grams != null) ? grams / customers : null;
    secondary = gramPerCustomer != null ? ` <span class="pivot-d">(${fmtNum(gramPerCustomer, 1)}g)</span>` : '';
  } else if (mode === 'pp') { raw = netSales ? amt / netSales * 100 : null; main = raw == null ? '—' : raw.toFixed(1) + '%'; }
  else { raw = amt / 1e6; main = fmtNum(raw, 1); }
  return { raw, main, secondary };
}
// 목표 열 전용 — category_summary의 target_cost_per_gram/target_consumption_per_person을
// 매장군 구분 없이(목표는 시즌 전체 단일값이라) 현재 선택된 구분(mode)에 맞게 표시한다.
function pivotTargetTxt(mode, gramPerG, consumptionPerPerson, targetPrice) {
  if (mode === 'g') return consumptionPerPerson != null ? fmtNum(consumptionPerPerson, 1) : '—';
  if (mode === 'pg') return (gramPerG != null && consumptionPerPerson != null) ? fmtNum(gramPerG * consumptionPerPerson, 0) : '—';
  if (mode === 'pp') { const r = computeCostRatio(gramPerG, consumptionPerPerson, targetPrice); return r != null ? r.toFixed(1) + '%' : '—'; }
  return '—';
}
function renderPivotCompare() {
  const data = pivotCompareCache;
  const tbl = $('#pivotTable');
  tbl.classList.remove('pivot-table-compact'); // 시계열에서만 쓰는 좁은 폭 모드 — 다른 탭으로 오면 해제
  const cacheHint = $('#pivotCacheHint');
  if (!data) { tbl.innerHTML = '<tbody><tr><td style="padding:24px;color:var(--muted)">불러오는 중...</td></tr></tbody>'; if (cacheHint) cacheHint.textContent = ''; return; }
  if (data.error) { tbl.innerHTML = `<tbody><tr><td style="padding:24px;color:var(--crit)">${esc(data.error)}</td></tr></tbody>`; return; }
  if (cacheHint) cacheHint.textContent = data.fromCache ? '· 저장된 값(즉시 로드)' : '';

  const mode = $('#pivotModeSelect').value;
  const allCodes = data.stores.map(s => s.code);
  const premiumCodes = data.stores.filter(s => s.type === 'premium').map(s => s.code);
  const regularCodes = data.stores.filter(s => s.type === 'regular').map(s => s.code);
  const valueCodes = data.stores.filter(s => s.type === 'value').map(s => s.code);

  let columns;
  if (pivotTab === 'A') {
    const selCode = $('#pivotStoreSelect').value;
    const selStore = data.stores.find(s => s.code === selCode);
    columns = [
      { key: 'brand', label: '브랜드', codes: allCodes, brand: true },
      { key: 'premium', label: '프리미엄', codes: premiumCodes },
      { key: 'regular', label: '일반', codes: regularCodes },
      { key: 'value', label: '199-229', codes: valueCodes },
    ];
    if (selStore) columns.push({ key: 'store', label: pivotShortName(selStore.name), codes: [selCode] });
  } else {
    if (!pivotStoreOrder) {
      const saved = JSON.parse(localStorage.getItem('pivotStoreOrder') || 'null');
      // 저장된(드래그로 직접 조정한) 순서가 없으면, 손님수 순서 그대로는 등급이 뒤섞여 보이므로
      // 기본값은 등급(프리미엄→일반→199-229)으로 먼저 묶고 그 안에서 손님수 순으로 정렬한다.
      const PIVOT_TIER_RANK = { premium: 0, regular: 1, value: 2 };
      pivotStoreOrder = saved
        ? saved.filter(c => allCodes.includes(c))
        : [...data.stores].sort((a, b) => (PIVOT_TIER_RANK[a.type] ?? 3) - (PIVOT_TIER_RANK[b.type] ?? 3) || b.guests - a.guests).map(s => s.code);
    }
    data.stores.forEach(s => { if (!pivotStoreOrder.includes(s.code)) pivotStoreOrder.push(s.code); });
    pivotStoreOrder = pivotStoreOrder.filter(c => allCodes.includes(c));
    columns = [{ key: 'brand', label: '브랜드', codes: allCodes, brand: true }]
      .concat(pivotStoreOrder.map((c, i) => {
        const s = data.stores.find(x => x.code === c);
        return { key: c, label: pivotVeryShortName(s.name), codes: [c], ord: i, tier: s.type };
      }));
  }
  columns.forEach(c => {
    const cs = data.stores.filter(s => c.codes.includes(s.code));
    c.sales = cs.reduce((a, s) => a + s.sales, 0);
    c.guests = cs.reduce((a, s) => a + s.guests, 0);
    c.count = c.codes.length;
    c.netSales = c.sales / 1.1;
    c.perCustomer = c.guests > 0 ? c.sales / c.guests : null;
  });

  const resultByMenu = new Map(data.results.map(r => [r.menu_name, r]));
  const zonesPresent = [...new Set([...data.designByMenu.values()].map(d => d.category).filter(Boolean))]
    .sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));

  // 모든 메뉴의 통계를 한 번만 계산해서, 전체 합계 행과 존별 행이 같은 값을 공유한다.
  const allMenuStats = [...data.designByMenu.values()].map(d => {
    const r = resultByMenu.get(d.menu_name);
    const costPerGram = data.costByMenu.get(d.menu_name) ?? d.cost_per_gram;
    const brandVal = pivotGroupValue(r, allCodes);
    const brandAmt = (brandVal.grams || 0) * (costPerGram || 0);
    return { design: d, result: r, costPerGram, brandAmt };
  });

  // 인당소비량(g)/인당소비액(원) 모드는 같은 셀에 "주값(부값)"을 같이 보여줘 글자수가 길어지므로
  // 열 폭을 더 넓게 준다 — 좁은 채로 두면 매장이 여러 개일 때 옆 열 값과 겹쳐 보인다.
  const colWidth = (mode === 'g' || mode === 'pg') ? 122 : 92;
  // table-layout:fixed + min-width:100%인 상태에서 <th> 인라인 width만 주면, 열 폭 합이 컨테이너보다
  // 좁을 때 브라우저가 남는 공간을 열마다 제각각 늘려버려 매장이 많을 때(③전매장) 폭이 들쭉날쭉해
  // 보인다. <colgroup>으로 폭을 못박으면 항상 지정한 폭 그대로 고정된다.
  let H = '<colgroup><col style="width:250px"><col style="width:62px">' +
    columns.map(() => `<col style="width:${colWidth}px">`).join('') + '</colgroup>';
  H += '<thead>';
  // ③전매장은 매장이 다닥다닥 나열되어 있어 등급을 매번 눈으로 구분하기 어려우므로, 연속된
  // 같은 등급 매장을 colspan으로 묶어 "프리미엄/일반/199-229" 그룹 라벨을 한 줄 더 얹는다.
  if (pivotTab === 'B') {
    H += '<tr class="pivot-tier-row"><th></th><th class="pivot-target-col"></th>';
    let i = 0;
    while (i < columns.length) {
      const tier = columns[i].tier;
      if (!tier) { H += '<th></th>'; i++; continue; }
      let span = 1;
      while (i + span < columns.length && columns[i + span].tier === tier) span++;
      H += `<th colspan="${span}" class="pivot-tier-head">${esc(PIVOT_TIER_LABEL[tier] || tier)}</th>`;
      i += span;
    }
    H += '</tr>';
  }
  H += '<tr><th>존 / 메뉴·자재</th><th class="pivot-target-col">목표</th>';
  columns.forEach(c => {
    const dnd = (pivotTab === 'B' && c.ord != null)
      ? ` draggable="true" ondragstart="pivotDragStore(event,${c.ord})" ondragover="event.preventDefault()" ondrop="pivotDropStore(event,${c.ord})" style="cursor:grab;width:${colWidth}px"`
      : ` style="width:${colWidth}px"`;
    // 브랜드/매장군처럼 여러 매장을 묶은 열은 "개점" 수가 의미 있어 그대로 두고, ③전매장의 개별
    // 매장 열(위에 등급 라벨이 이미 붙음)은 매장당 항상 1개점이라 굳이 안 보여줘도 되므로 뺀다.
    // 손님수·객단가를 한 줄로 합치면 좁은 열 폭에서 줄바꿈이 지저분해 보여, 개별 매장 열은 두 줄로
    // 나누고 글자도 한 단계 작게 줄인다.
    const statLine = c.tier
      ? `<span class="pivot-th-stat">${(c.guests / 1000).toFixed(1)}천명</span><br><span class="pivot-th-stat">${fmtNum(c.perCustomer, 0)}원</span>`
      : `<span class="pivot-d">${c.count}개점 · ${(c.guests / 1000).toFixed(1)}천명 · ${fmtNum(c.perCustomer, 0)}원</span>`;
    H += `<th${dnd}>${esc(c.label)}<br>${statLine}</th>`;
  });
  H += '</tr></thead><tbody>';

  // 전체 조닝 합계 행 — 존 합계와 같은 원리로 손님수는 매장군 전체 손님수 하나로 통일한다.
  {
    const brandTarget = weightedTotals([...data.targetByCategory.values()], 'target');
    H += '<tr class="pivot-zone pivot-met"><td>【로운 전체】</td>' +
      `<td class="pivot-target-col">${pivotTargetTxt(mode, brandTarget.costPerGram, brandTarget.consumption, data.targetPrice)}</td>`;
    columns.forEach(c => {
      let amt = 0, grams = 0;
      allMenuStats.forEach(m => { if (!m.result) return; const g = pivotGroupValue(m.result, c.codes); if (g.grams != null) grams += g.grams; amt += pivotGroupAmount(m.result, c.codes, data.costByMenuStore.get(m.design.menu_name)).amt; });
      const t = pivotValueTxt(mode, amt, grams, c.guests, c.netSales);
      H += `<td>${t.main}${t.secondary}</td>`;
    });
    H += '</tr>';
  }

  zonesPresent.forEach(zone => {
    const menuStats = allMenuStats.filter(m => m.design.category === zone).sort((a, b) => b.brandAmt - a.brandAmt);

    const withCost = menuStats.filter(m => m.costPerGram != null);
    const avgCostPerGram = withCost.length ? withCost.reduce((a, m) => a + m.costPerGram, 0) / withCost.length : null;
    const catRow = data.targetByCategory.get(zone);

    const zid = zone;
    H += `<tr class="pivot-zone" onclick="pivotToggle('${esc(zid)}')"><td>${pivotCollapsed[zid] ? '▸' : '▾'} 【${esc(zone)}】` +
      ` <span class="pivot-badge">평균 g당${avgCostPerGram != null ? fmtNum(avgCostPerGram, 1) : '-'}원</span></td>` +
      `<td class="pivot-target-col">${pivotTargetTxt(mode, catRow?.target_cost_per_gram, catRow?.target_consumption_per_person, data.targetPrice)}</td>`;
    columns.forEach(c => {
      // 존 합계는 메뉴마다 분모(패턴별 손님수)가 달라 그냥 더하면 안 된다 — 그램/금액만 메뉴 합산하고,
      // 손님수는 그 매장군의 전체 손님수(c.guests) 하나로 통일해서 나눈다(이번 세션 인당소비액 합산 버그와 동일 원리).
      let amt = 0, grams = 0;
      menuStats.forEach(m => { if (!m.result) return; const g = pivotGroupValue(m.result, c.codes); if (g.grams != null) grams += g.grams; amt += pivotGroupAmount(m.result, c.codes, data.costByMenuStore.get(m.design.menu_name)).amt; });
      const t = pivotValueTxt(mode, amt, grams, c.guests, c.netSales);
      H += `<td>${t.main}${t.secondary}</td>`;
    });
    H += '</tr>';
    if (pivotCollapsed[zid]) return;

    menuStats.forEach(m => {
      const menuName = m.design.menu_name;
      const ings = (data.flat.flatByMenu.get(menuName) || new Map());
      const cookedWeight = data.flat.cookedWeightByMenu.get(menuName);
      // 축산/야채는 대부분 메뉴 자체가 자재 하나짜리라(예: 차돌양지, 청경채) 레시피 배합비를 펼쳐볼 게
      // 없다. 대신 "이 자재에 다른 공급처 코드가 몇 개나 연결돼 있고 각각 단가가 얼마인지"를 펼쳐 보여준다.
      const isRawZone = zone === '축산' || zone === '야채';
      const soleCode = ings.size === 1 ? [...ings.keys()][0] : null;
      const aliasMembers = (isRawZone && soleCode) ? [...(data.clusterMembers.get(data.findMaterial(soleCode)) || [soleCode])] : null;
      const hasAliasExpand = aliasMembers && aliasMembers.length > 1;
      const hasParts = (ings.size > 1 && cookedWeight > 0) || hasAliasExpand;
      const mid = zone + '|' + menuName;
      H += `<tr class="pivot-menu"${hasParts ? ` onclick="pivotToggleIng('${esc(mid)}')"` : ''}><td title="${esc(menuName)}">` +
        (hasParts ? (pivotOpenIng[mid] ? '▾ ' : '▸ ') : '　') + esc(menuName) +
        ` <span class="pivot-badge">g당${m.costPerGram != null ? fmtNum(m.costPerGram, 1) : '-'}원 · ${cookedWeight ? fmtNum(cookedWeight, 0) : '-'}g(레시피)</span>` +
        '</td><td class="pivot-na pivot-target-col">—</td>';
      columns.forEach(c => {
        const g = pivotGroupValue(m.result, c.codes);
        if (g.grams == null) { H += '<td class="pivot-na">—</td>'; return; }
        const amt = pivotGroupAmount(m.result, c.codes, data.costByMenuStore.get(menuName)).amt;
        const t = pivotValueTxt(mode, amt, g.grams, g.customers, c.netSales);
        H += `<td>${t.main}${t.secondary}</td>`;
      });
      H += '</tr>';
      if (hasAliasExpand && pivotOpenIng[mid]) {
        // 배합비가 아니라 "이 코드에 연결된 자재들과 각각의 실제 g당단가"만 참고용으로 보여준다
        // (매장/그램 열은 이 메뉴 하나에 다 반영되어 있어 여기서 또 나눌 근거가 없으므로 비워둠).
        aliasMembers.forEach(code => {
          const name = data.flat.rawMaterialNameByCode.get(code) || data.aliasNameByCode.get(code) || code;
          const price = data.rawCodePricePerGram.get(code);
          H += `<tr class="pivot-ing"><td title="${esc(name)}">└ ${esc(name)} <span class="pivot-badge">g당${price != null ? fmtNum(price, 1) : '-'}원</span></td><td class="pivot-na pivot-target-col">—</td>`;
          columns.forEach(c => {
            let grams = 0, amt = 0, any = false;
            c.codes.forEach(storeCode => {
              const u = data.usageByStoreRawCode.get(storeCode)?.get(code);
              if (u) { grams += u.grams; amt += u.amount; any = true; }
            });
            if (!any || grams <= 0) { H += '<td class="pivot-na">—</td>'; return; }
            const t = pivotValueTxt(mode, amt, grams, c.guests, c.netSales);
            H += `<td class="pivot-d">${t.main}</td>`;
          });
          H += '</tr>';
        });
      } else if (hasParts && pivotOpenIng[mid]) {
        [...ings.entries()].sort((a, b) => b[1] - a[1]).forEach(([code, g]) => {
          const share = g / cookedWeight;
          const ingName = data.flat.rawMaterialNameByCode.get(code) || code;
          H += `<tr class="pivot-ing"><td title="${esc(ingName)}">└ ${esc(ingName)} <span class="pivot-badge">${fmtNum(g, 1)}g/${fmtNum(cookedWeight, 0)}g</span></td><td class="pivot-na pivot-target-col">—</td>`;
          columns.forEach(c => {
            const gv = pivotGroupValue(m.result, c.codes);
            if (gv.grams == null) { H += '<td class="pivot-na">—</td>'; return; }
            const amt = gv.grams * share * (m.costPerGram || 0);
            const t = pivotValueTxt(mode, amt, gv.grams * share, gv.customers, c.netSales);
            H += `<td class="pivot-d">${t.main}</td>`;
          });
          H += '</tr>';
        });
      }
    });
  });
  H += '</tbody>';
  tbl.innerHTML = H;
}

function pivotToggle(zoneId) { pivotCollapsed[zoneId] = !pivotCollapsed[zoneId]; renderPivotCompare(); }
function pivotTsToggle(zoneId) { pivotTsCollapsed[zoneId] = !pivotTsCollapsed[zoneId]; renderPivotTimeSeries(); }
function pivotToggleIng(menuId) { pivotOpenIng[menuId] = !pivotOpenIng[menuId]; renderPivotCompare(); }
let pivotStoreOrder = null;
let pivotDragIdx = null;
function pivotDragStore(ev, i) { pivotDragIdx = i; }
function pivotDropStore(ev, i) {
  ev.preventDefault();
  if (pivotDragIdx == null || pivotDragIdx === i) return;
  const moved = pivotStoreOrder.splice(pivotDragIdx, 1)[0];
  pivotStoreOrder.splice(i, 0, moved);
  pivotDragIdx = null;
  localStorage.setItem('pivotStoreOrder', JSON.stringify(pivotStoreOrder));
  renderPivotCompare();
}
$('#pivotResetOrderBtn').addEventListener('click', () => {
  pivotStoreOrder = null;
  localStorage.removeItem('pivotStoreOrder');
  renderPivotCompare();
});

// "메뉴별 소비액"에서 레시피/자재를 고쳐도 종료 시즌 피벗은 저장된 캐시(pivot_snapshot)를 계속 보여주고,
// 진행 중 시즌도 세션 내 캐시(flatCache/costCache) 때문에 최대 2분은 예전 값을 보여줄 수 있다 —
// 매번 콘솔로 캐시를 지우지 않아도, 버튼 하나로 지금 보고 있는 탭을 강제로 다시 계산하게 한다.
async function refreshPivotFromLatest(ev) {
  const btn = ev.currentTarget;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '최신화 중...';
  try {
    await invalidateSeasonCalcCaches();
    if (pivotTab === 'A' || pivotTab === 'B') await loadPivotCompareView();
    else if (pivotTab === 'C') await loadPivotTimeSeriesView();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}
$('#pivotRefreshBtnAB')?.addEventListener('click', refreshPivotFromLatest);
$('#pivotRefreshBtnC')?.addEventListener('click', refreshPivotFromLatest);

async function loadPivotCompareView() {
  const myToken = ++pivotLoadToken;
  const tbl = $('#pivotTable');
  tbl.innerHTML = '<tbody><tr><td style="padding:24px;color:var(--muted)">불러오는 중...</td></tr></tbody>';
  const data = await loadPivotCompareData();
  if (myToken !== pivotLoadToken) return; // 그 사이 다른 탭/필터로 넘어감 — 이 결과는 버린다
  pivotCompareCache = data;
  if (!data.error && pivotTab === 'A') {
    const sel = $('#pivotStoreSelect');
    const prev = sel.value;
    sel.innerHTML = data.stores.map(s => `<option value="${s.code}">${esc(pivotShortName(s.name))}</option>`).join('');
    sel.value = data.stores.some(s => s.code === prev) ? prev : (data.stores[0]?.code || '');
  }
  renderPivotCompare();
}
$('#pivotUnitSelect').addEventListener('change', loadPivotCompareView);
$('#pivotMonthInput').addEventListener('change', loadPivotCompareView);
$('#pivotWeekSelect').addEventListener('change', loadPivotCompareView);
$('#pivotModeSelect').addEventListener('change', renderPivotCompare);
$('#pivotStoreSelect').addEventListener('change', renderPivotCompare);

// ---- ③ 시계열 ----
// 매장별 IPF는 기간마다 반복하기엔 너무 느려서(매장당 반복계산), computeMenuConsumption의
// brandOnly 경로(전 매장 실사용량을 한 번에 합쳐 계산)로 기간마다 빠르게 돌린다.
// 매장을 선택하면 존별 분해 없이(레퍼런스도 존별 분해는 브랜드 전용) 그 매장 원가율/원객/축산만 직접 합산한다.
function pivotMonthRange(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
function pivotAllWeekPeriods(fromMonth, toMonth) {
  const out = [];
  pivotMonthRange(fromMonth, toMonth).forEach(mo => {
    const [y, m] = mo.split('-').map(Number);
    computeWeekOptionsForMonth(y, m).forEach(w => out.push(w));
  });
  return out;
}
function pivotTsSeasonRange() {
  const withRange = state.seasons.filter(s => s.start_month && s.end_month);
  if (!withRange.length) return null;
  const earliest = withRange.reduce((a, b) => (a.start_month < b.start_month ? a : b));
  const latest = withRange.reduce((a, b) => (a.end_month > b.end_month ? a : b));
  return { from: earliest.start_month.slice(0, 7), to: latest.end_month.slice(0, 7) };
}

let pivotTsCache = null;
let pivotTsStoresLoaded = false;
async function ensurePivotTsStoreOptions() {
  if (pivotTsStoresLoaded) return;
  pivotTsStoresLoaded = true;
  const { data } = await fetchAllRows('store_sales', null, 'store_code, store_name');
  const map = new Map();
  (data || []).forEach(r => { if (r.store_code && !map.has(r.store_code)) map.set(r.store_code, r.store_name || r.store_code); });
  const sel = $('#pivotTsTargetSelect');
  [...map.entries()].forEach(([code, name]) => {
    const opt = document.createElement('option');
    opt.value = code; opt.textContent = pivotShortName(name);
    sel.appendChild(opt);
  });
}
function pivotTsSeasonsSorted() {
  return state.seasons.filter(s => s.start_month && s.end_month).sort((a, b) => a.start_month.localeCompare(b.start_month));
}
function populatePivotTsFromSelect() {
  const unit = $('#pivotTsUnitSelect').value;
  const range = pivotTsSeasonRange();
  const sel = $('#pivotTsFromSelect');
  const cur = sel.value;
  if (!range) { sel.innerHTML = ''; return; }
  const opts = unit === 'w'
    ? pivotAllWeekPeriods(range.from, range.to).map(w => ({ value: `${w.periodStart}|${w.periodEnd}`, label: w.periodEnd.slice(2) }))
    : unit === 's'
    ? pivotTsSeasonsSorted().map(s => ({ value: String(s.id), label: s.name }))
    : pivotMonthRange(range.from, range.to).map(m => ({ value: m, label: m.slice(2) }));
  sel.innerHTML = opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
  if (opts.some(o => o.value === cur)) { sel.value = cur; return; }
  // 기본으로 저장된 기간 전체(가장 이른 시점부터 오늘까지)를 보여준다 — 표가 넓어지는 만큼은
  // .pivot-wrap을 옆으로 드래그해서 보고, 필요하면 이 "시작" 선택으로 직접 좁혀서 볼 수 있다.
  sel.value = opts[0]?.value || '';
}

async function loadPivotTimeSeriesData() {
  const unit = $('#pivotTsUnitSelect').value;
  const range = pivotTsSeasonRange();
  if (!range) return { error: '시즌 데이터가 없습니다.' };
  const fromVal = $('#pivotTsFromSelect').value;
  if (!fromVal) return { error: '시작 시점을 선택해주세요.' };

  // 아직 시작하지 않은 미래 기간은 항상 데이터가 없으므로(다음 시즌 미리 등록 등) 오늘까지만 조회한다.
  const todayStr = new Date().toISOString().slice(0, 10);
  let periods;
  if (unit === 'w') {
    const all = pivotAllWeekPeriods(range.from, range.to).filter(w => w.periodStart <= todayStr);
    const idx = all.findIndex(w => `${w.periodStart}|${w.periodEnd}` === fromVal);
    periods = (idx >= 0 ? all.slice(idx) : all).map(w => ({ start: w.periodStart, end: w.periodEnd, label: w.periodEnd.slice(2) }));
  } else if (unit === 's') {
    const all = pivotTsSeasonsSorted().filter(s => s.start_month <= todayStr);
    const idx = all.findIndex(s => String(s.id) === fromVal);
    periods = (idx >= 0 ? all.slice(idx) : all).map(s => ({ start: s.start_month, end: s.end_month, label: s.name, seasonName: s.name }));
  } else {
    const all = pivotMonthRange(range.from, range.to).filter(m => m + '-01' <= todayStr);
    const idx = all.findIndex(m => m === fromVal);
    periods = (idx >= 0 ? all.slice(idx) : all).map(m => {
      const [y, mm] = m.split('-').map(Number);
      const last = new Date(y, mm, 0).getDate();
      return { start: `${m}-01`, end: `${m}-${String(last).padStart(2, '0')}`, label: m.slice(2) };
    });
  }

  const targetCode = $('#pivotTsTargetSelect').value;
  const designsBySeasonId = new Map();
  const periodUnit = unit === 's' ? 'season' : unit === 'w' ? 'week' : 'month';
  const out = [];
  for (const p of periods) {
    const seasonId = findSeasonIdForDate(p.end);
    const season = state.seasons.find(s => s.id === seasonId);
    if (targetCode === 'brand') {
      if (!designsBySeasonId.has(seasonId)) {
        const [{ data }, seasonFlat] = await Promise.all([
          fetchAllRows('menu_designs', q => q.eq('season_id', seasonId)),
          getFlatForSeason(seasonId),
        ]);
        const m = new Map();
        (data || []).forEach(d => { if (d.menu_name) m.set(d.menu_name, d); });
        designsBySeasonId.set(seasonId, unionDesignByMenu(m, seasonFlat?.categoryByMenu));
      }
      const designByMenu = designsBySeasonId.get(seasonId);
      const closed = isSeasonClosed(season);
      // 캐시 확인은 가벼운 단건 조회라 먼저 해보고, 없을 때만 느린 계산을 나머지 조회들과 "같이"
      // 병렬로 돌린다 — 순서대로 돌리면 대기시간이 그냥 다 더해져서 훨씬 오래 걸린다.
      const cachedRows = closed ? await fetchPivotSnapshot(seasonId, periodUnit, p.start, p.end) : null;

      const costPromise = getActualCostPerGram(seasonId);
      const salesPromise = fetchAllRows('store_sales',
        q => q.gte('sales_date', p.start).lt('sales_date', nextDay(p.end)), 'sales_total, customers_total');
      // 종료된 시즌은 저장된 정확 계산 결과가 있으면 그대로 읽고(재계산 안 함), 없으면 정확 계산 후 저장해둔다
      // (다음부터는 즉시 조회됨). 진행 중인 시즌은 계속 빠른 근사(brandOnly)를 쓴다 — 매번 5~6분 걸리는
      // 정확 계산을 월/주차 단위로 반복하기엔 너무 느리고, 데이터도 계속 바뀌어 캐싱할 수 없다.
      const consumptionPromise = cachedRows ? Promise.resolve(null)
        : closed ? computeMenuConsumption(null, { start: p.start, end: p.end })
        : computeMenuConsumption(null, { start: p.start, end: p.end }, true);

      const [costResult, salesRes, consumption] = await Promise.all([costPromise, salesPromise, consumptionPromise]);
      const costByMenu = new Map((costResult.results || []).map(r => [r.menu_name, r.actual_cost_per_gram]));
      const periodSales = salesRes.data;
      const totalCustomers = (periodSales || []).reduce((a, r) => a + (Number(r.customers_total) || 0), 0);
      const totalSales = (periodSales || []).reduce((a, r) => a + (Number(r.sales_total) || 0), 0);

      let gramsByMenu = null;
      if (cachedRows) {
        gramsByMenu = new Map();
        cachedRows.forEach(r => gramsByMenu.set(r.menu_name, (gramsByMenu.get(r.menu_name) || 0) + (Number(r.grams) || 0)));
      } else if (closed) {
        if (consumption.error) { out.push({ ...p, seasonName: season?.name }); continue; }
        savePivotSnapshotFromResults(seasonId, periodUnit, p.start, p.end, consumption.results);
        gramsByMenu = new Map();
        consumption.results.forEach(r => {
          gramsByMenu.set(r.menu_name, (r.per_store || []).reduce((a, s) => a + (s.grams || 0), 0));
        });
      } else {
        if (consumption.error || !consumption.brandOnly) { out.push({ ...p, seasonName: season?.name }); continue; }
        gramsByMenu = consumption.gramsProducedByMenu;
      }

      let totalAmt = 0, meatAmt = 0;
      const zoneAmt = {}, zoneGrams = {}, menuAmt = {}, menuGrams = {}, menuCategory = {};
      designByMenu.forEach((d, menu) => {
        const grams = gramsByMenu.get(menu);
        if (grams == null || !d.category) return;
        const costPerGram = costByMenu.get(menu) ?? d.cost_per_gram;
        const amt = grams * (costPerGram || 0);
        totalAmt += amt;
        zoneAmt[d.category] = (zoneAmt[d.category] || 0) + amt;
        zoneGrams[d.category] = (zoneGrams[d.category] || 0) + grams;
        menuAmt[menu] = amt; menuGrams[menu] = grams; menuCategory[menu] = d.category;
        if (d.category === '축산') meatAmt += amt;
      });
      out.push({ ...p, seasonName: season?.name, totalAmt, meatAmt, zoneAmt, zoneGrams, menuAmt, menuGrams, menuCategory,
        totalCustomers, netSales: totalSales / 1.1 });
    } else {
      const [{ data: usage }, { data: sales }] = await Promise.all([
        fetchAllRows('material_usage', q => q.eq('store_code', targetCode).gte('period_end', p.start).lt('period_end', nextDay(p.end)), 'remark, actual_usage_amount'),
        fetchAllRows('store_sales', q => q.eq('store_code', targetCode).gte('sales_date', p.start).lt('sales_date', nextDay(p.end)), 'sales_total, customers_total'),
      ]);
      const totalAmt = (usage || []).reduce((a, r) => a + (Number(r.actual_usage_amount) || 0), 0);
      const meatAmt = (usage || []).filter(r => r.remark === '축산').reduce((a, r) => a + (Number(r.actual_usage_amount) || 0), 0);
      const totalCustomers = (sales || []).reduce((a, r) => a + (Number(r.customers_total) || 0), 0);
      const totalSales = (sales || []).reduce((a, r) => a + (Number(r.sales_total) || 0), 0);
      out.push({ ...p, seasonName: season?.name, totalAmt, meatAmt, totalCustomers, netSales: totalSales / 1.1 });
    }
  }
  return { periods: out, targetCode };
}

function renderPivotTimeSeries() {
  const data = pivotTsCache;
  const tbl = $('#pivotTable');
  if (!data) { tbl.innerHTML = '<tbody><tr><td style="padding:24px;color:var(--muted)">불러오는 중...</td></tr></tbody>'; return; }
  if (data.error) { tbl.innerHTML = `<tbody><tr><td style="padding:24px;color:var(--crit)">${esc(data.error)}</td></tr></tbody>`; return; }
  const mode = $('#pivotTsModeSelect').value;
  // 기간이 몇 개 안 될 땐 표를 화면폭까지 억지로 안 늘려도 된다고 확인받음 — 이 표만 min-width:100%를 뺀다.
  tbl.classList.add('pivot-table-compact');

  // 기간이 많아질수록(전체 이력 기본 표시) 열 폭이 좁아지지 않고 최소폭을 지키게 해서, 넘치는 만큼
  // .pivot-wrap을 옆으로 드래그해서 보게 한다(예전엔 width:100%라 기간이 몇 개든 억지로 욱여넣어졌음).
  // 시계열의 행 이름("원가율 %", "【축산】", 짧은 존/메뉴명)은 ①②탭의 존/메뉴·자재 이름보다 훨씬 짧아서
  // 공용 CSS의 250px는 과하게 넓다 — 이 표에서만 첫 열을 좁게 덮어쓴다(표 하나에서 첫 행 폭이 전체
  // 열 폭을 정하는 table-layout:fixed 특성상, 헤더 셀 하나에만 줘도 표 전체에 적용됨).
  let H = `<thead><tr><th style="width:150px;max-width:150px">지표 / 기간</th>`;
  let prevSeason = null;
  data.periods.forEach(p => {
    const tag = p.seasonName && p.seasonName !== prevSeason ? `<br><span class="pivot-seas">▼${esc(p.seasonName)}</span>` : '';
    prevSeason = p.seasonName || prevSeason;
    H += `<th style="width:88px">${esc(p.label)}${tag}</th>`;
  });
  H += '</tr></thead><tbody>';

  const row = (label, fn, cls) => {
    let h = `<tr class="${cls || ''}"><td>${esc(label)}</td>`;
    data.periods.forEach(p => { h += `<td>${fn(p)}</td>`; });
    return h + '</tr>';
  };
  H += row('원가율 %', p => (p.totalAmt != null && p.netSales) ? (p.totalAmt / p.netSales * 100).toFixed(1) + '%' : '—', 'pivot-met');
  H += row('원/객 (총)', p => (p.totalAmt != null && p.totalCustomers) ? fmtNum(p.totalAmt / p.totalCustomers, 0) : '—', 'pivot-met');
  H += row('축산 원/객', p => (p.meatAmt != null && p.totalCustomers) ? fmtNum(p.meatAmt / p.totalCustomers, 0) : '—', 'pivot-met');
  H += row('축산 %', p => (p.meatAmt != null && p.netSales) ? (p.meatAmt / p.netSales * 100).toFixed(1) + '%' : '—', 'pivot-met');

  const tsCellVal = (amt, grams, p) => {
    if (amt == null) return '—';
    if (mode === 'g') return (grams != null && p.totalCustomers) ? fmtNum(grams / p.totalCustomers, 1) : '—';
    if (mode === 'pp') return p.netSales ? (amt / p.netSales * 100).toFixed(1) + '%' : '—';
    return p.totalCustomers ? fmtNum(amt / p.totalCustomers, 0) : '—';
  };

  if (data.targetCode === 'brand') {
    // 존별로 등장하는 모든 메뉴 이름을 기간 전체에서 모아, 존을 펼치면 그 메뉴들을 총액 큰 순으로 보여준다.
    const menusByZone = {};
    data.periods.forEach(p => {
      Object.entries(p.menuCategory || {}).forEach(([menu, cat]) => {
        (menusByZone[cat] = menusByZone[cat] || new Set()).add(menu);
      });
    });
    CATEGORY_ORDER.filter(z => z !== '드랍').forEach(zone => {
      const zid = 'ts|' + zone;
      H += `<tr class="pivot-zone" onclick="pivotTsToggle('${esc(zid)}')"><td>${pivotTsCollapsed[zid] ? '▸' : '▾'} 【${esc(zone)}】</td>`;
      data.periods.forEach(p => { H += `<td>${tsCellVal(p.zoneAmt?.[zone], p.zoneGrams?.[zone], p)}</td>`; });
      H += '</tr>';
      if (pivotTsCollapsed[zid]) return;
      const menus = [...(menusByZone[zone] || [])].sort((a, b) => {
        const sum = m => data.periods.reduce((s, p) => s + (p.menuAmt?.[m] || 0), 0);
        return sum(b) - sum(a);
      });
      menus.forEach(menu => {
        H += `<tr class="pivot-menu"><td title="${esc(menu)}">　${esc(menu)}</td>`;
        data.periods.forEach(p => { H += `<td>${tsCellVal(p.menuAmt?.[menu], p.menuGrams?.[menu], p)}</td>`; });
        H += '</tr>';
      });
    });
  } else {
    H += `<tr><td colspan="${data.periods.length + 1}" class="pivot-note" style="position:static">존별 분해는 "브랜드 전체" 대상에서만 제공됩니다(매장별 존 배분 근거 부족).</td></tr>`;
  }
  H += '</tbody>';
  tbl.innerHTML = H;
}

async function loadPivotTimeSeriesView() {
  const myToken = ++pivotLoadToken;
  const tbl = $('#pivotTable');
  tbl.innerHTML = '<tbody><tr><td style="padding:24px;color:var(--muted)">불러오는 중... (기간이 많으면 시간이 걸릴 수 있어요)</td></tr></tbody>';
  await ensurePivotTsStoreOptions();
  if (myToken !== pivotLoadToken) return;
  populatePivotTsFromSelect();
  const result = await loadPivotTimeSeriesData();
  if (myToken !== pivotLoadToken) return; // 그 사이 다른 탭/필터로 넘어감 — 이 결과는 버린다
  pivotTsCache = result;
  renderPivotTimeSeries();
}
$('#pivotTsTargetSelect').addEventListener('change', loadPivotTimeSeriesView);
$('#pivotTsUnitSelect').addEventListener('change', loadPivotTimeSeriesView);
$('#pivotTsFromSelect').addEventListener('change', loadPivotTimeSeriesView);
$('#pivotTsModeSelect').addEventListener('change', renderPivotTimeSeries);

// ---------- ④ VE (AS-IS→TO-BE) ----------
// 대상: 메뉴 진단 탭의 "즉시" 긴급도 메뉴(computeUrgencyTiers, 상위 10%) — 그대로 재사용.
// AS-IS 취식g/객은 menu_consumption.consumption_per_person_brand를 쓴다(시즌 전체 손님수 기준으로
// 통일한 값) — 메뉴별 원래 consumption_per_person을 쓰면 디너/주말 한정 메뉴가 브랜드 원가율 영향력을
// 과대평가받는다(이번 세션 초반 브랜드 실적 원가율 31%→37% 오류의 원인과 동일한 함정).
const VE_PHASES = ['즉시', '자재 소진 후', '가을 시즌', '확인 중'];
let veFactsCache = null;
let vePlanCache = [];

async function buildVeFacts() {
  // menuDiagnosisCache는 "메뉴 진단" 탭이나 시즌 로드가 먼저 끝나야 채워지는 다른 탭의 캐시라 —
  // 피벗④를 그보다 먼저 열면(시즌 갓 전환한 직후 등) 비어있을 수 있다. 여기서 직접 최신으로 다시 계산해서
  // 로드 순서에 의존하지 않게 한다.
  await loadMenuConsumptionView();
  const { diagRows } = computeMenuDiagnosisQuadrants(menuConsumptionRowsCache);
  computeUrgencyTiers(diagRows);
  const urgentRows = diagRows.filter(r => r.tier === '즉시');
  if (!urgentRows.length) return null;
  const urgentNames = urgentRows.map(r => r.menu_name);
  const { data: consRows } = await fetchAllRows(
    'menu_consumption',
    q => q.eq('season_id', state.currentSeasonId).in('menu_name', urgentNames),
    'menu_name, consumption_per_person_brand, actual_cost_per_gram'
  );
  const consByMenu = new Map((consRows || []).map(r => [r.menu_name, r]));
  const designByMenu = new Map(menuConsumptionRowsCache.map(r => [r.menu_name, r]));

  const items = urgentRows.map(u => {
    const cons = consByMenu.get(u.menu_name);
    const design = designByMenu.get(u.menu_name);
    const wpg = cons?.actual_cost_per_gram ?? design?.cost_per_gram ?? null;
    const g = cons?.consumption_per_person_brand ?? null;
    return { menu_name: u.menu_name, zone: u.category, wpg, g, won: (wpg != null && g != null) ? wpg * g : null };
  });

  const t = state.seasonTarget;
  const targetPrice = t?.target_price_per_person ?? null;
  const targetTotals = weightedTotals(state.categorySummary, 'target');
  const targetRatio = computeCostRatio(targetTotals.costPerGram, targetTotals.consumption, targetPrice);
  const rate = t?.actual_cost_ratio_brand ?? null;
  const netPricePerPerson = t?.actual_price_per_person ? t.actual_price_per_person / 1.1 : null;

  const byCategory = Object.fromEntries(state.categorySummary.map(r => [r.category, r]));
  const zones = DASHBOARD_CATEGORIES.map(cat => {
    const r = byCategory[cat] || {};
    const actual = (r.actual_cost_per_gram != null && r.actual_consumption_per_person != null)
      ? r.actual_cost_per_gram * r.actual_consumption_per_person : null;
    const target = (r.target_cost_per_gram != null && r.target_consumption_per_person != null)
      ? r.target_cost_per_gram * r.target_consumption_per_person : null;
    return { zone: cat, actual, target, gap: (actual != null && target != null) ? actual - target : null };
  });

  return { items, rate, targetRatio, netPricePerPerson, zones };
}

function computeVE() {
  const F = veFactsCache;
  if (!F) return null;
  const planByMenu = new Map(vePlanCache.map(p => [p.menu_name, p]));

  const rows = F.items.map(it => {
    const p = planByMenu.get(it.menu_name) || {};
    if (it.wpg == null || it.g == null) {
      return {
        menu_name: it.menu_name, zone: it.zone, asis_wpg: it.wpg, asis_g: it.g, asis_won: it.won,
        in_wpg: null, in_g: null, tobe_wpg: null, tobe_g: null, tobe_won: null, d_won: null, d_pp: null,
        phase: p.phase || '확인 중', action_plan: p.action_plan || '', note: 'AS-IS 산출불가 — 자재사용량 데이터 부족',
      };
    }
    const inWpg = (p.tb_cost_per_gram != null && p.tb_cost_per_gram !== '') ? Number(p.tb_cost_per_gram) : null;
    const inG = (p.tb_consumption != null && p.tb_consumption !== '') ? Number(p.tb_consumption) : null;
    const tobeWpg = inWpg ?? it.wpg;
    const tobeG = inG ?? it.g;
    const tobeWon = tobeWpg * tobeG;
    const dWon = tobeWon - it.won;
    const dPp = F.netPricePerPerson ? dWon / F.netPricePerPerson * 100 : null;
    return {
      menu_name: it.menu_name, zone: it.zone, asis_wpg: it.wpg, asis_g: it.g, asis_won: it.won,
      in_wpg: inWpg, in_g: inG, tobe_wpg: tobeWpg, tobe_g: tobeG, tobe_won: tobeWon, d_won: dWon, d_pp: dPp,
      phase: p.phase || '확인 중', action_plan: p.action_plan || '',
      note: '', // TO-BE 미입력은 기본 상태라 매 행마다 표시하면 오히려 어수선함 — AS-IS 산출불가만 note로 표시
    };
  });
  rows.sort((a, b) => (a.d_won ?? 0) - (b.d_won ?? 0));

  const eff = rows.filter(r => r.d_won != null);
  const totWon = eff.reduce((s, r) => s + r.d_won, 0);
  const totPp = F.netPricePerPerson ? totWon / F.netPricePerPerson * 100 : null;

  const phaseAgg = {};
  eff.forEach(r => { const k = VE_PHASES.includes(r.phase) ? r.phase : '확인 중'; phaseAgg[k] = (phaseAgg[k] || 0) + r.d_won; });
  let acc = 0;
  const phases = VE_PHASES.map(ph => {
    acc += (phaseAgg[ph] || 0);
    const cumPp = F.netPricePerPerson ? acc / F.netPricePerPerson * 100 : null;
    return { phase: ph, d: phaseAgg[ph] || 0, cum: acc, rate: (F.rate != null && cumPp != null) ? F.rate + cumPp : null };
  });

  const zoneDelta = {};
  eff.forEach(r => { zoneDelta[r.zone] = (zoneDelta[r.zone] || 0) + r.d_won; });
  const zones = F.zones.map(z => ({
    ...z, d: zoneDelta[z.zone] || 0,
    gap2: z.gap != null ? z.gap + (zoneDelta[z.zone] || 0) : null,
  }));

  return {
    rows, zones, phases,
    total: { d_won: totWon, d_pp: totPp, rate_after: (F.rate != null && totPp != null) ? F.rate + totPp : null },
    rate: F.rate, targetRatio: F.targetRatio,
  };
}

function renderVE() {
  const tbl = $('#pivotTable');
  tbl.classList.remove('pivot-table-compact'); // 시계열에서만 쓰는 좁은 폭 모드 — 다른 탭으로 오면 해제
  const F = veFactsCache;
  if (!F) {
    tbl.innerHTML = '<tbody><tr><td style="padding:24px;color:var(--muted)">"즉시" 긴급도 메뉴가 없습니다 (메뉴 진단 탭 기준).</td></tr></tbody>';
    $('#pivotVeSummary').innerHTML = '';
    return;
  }
  const V = computeVE();
  const won = v => v == null ? '—' : Math.round(v).toLocaleString();
  const f1v = v => v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString();
  const f2v = v => v == null ? '—' : (Math.round(v * 100) / 100).toLocaleString();
  const sgn = (v, n) => v == null ? '—' : (v > 0 ? '+' : '') + (Math.round(v * Math.pow(10, n)) / Math.pow(10, n)).toLocaleString(undefined, { minimumFractionDigits: n, maximumFractionDigits: n });
  const cl = v => v == null ? '' : (v < 0 ? 'pivot-ve-good' : (v > 0 ? 'pivot-ve-bad' : ''));
  // onchange="veSet('...')" 안에 그대로 들어가는 문자열 — HTML 속성 경계(", &)와 JS 문자열 리터럴 경계(')를
  // 각각 올바른 방식으로 이스케이프해야 한다(HTML 엔티티로 '를 escape해도 브라우저가 속성을 디코딩한 뒤
  // JS로 넘기므로 소용없음 — 반드시 백슬래시 JS escape를 써야 함).
  const qesc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const num = (menu, field, v) => `<input class="pivot-ve-in" type="number" step="0.01" value="${v == null ? '' : v}" onchange="veSet('${qesc(menu)}','${field}',this.value)">`;
  const sel = (menu, v) => `<select class="pivot-ve-in" onchange="veSet('${qesc(menu)}','phase',this.value)">` +
    VE_PHASES.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('') + `</select>`;
  const txt = (menu, v) => `<input class="pivot-ve-in pivot-ve-wide" value="${esc(v || '').replace(/"/g, '&quot;')}" onchange="veSet('${qesc(menu)}','action_plan',this.value)">`;

  // VE 합계 요약은 표 밖(#pivotVeSummary)에 따로 그린다 — colspan짜리 헤더 행을 표 안에 넣으면
  // table-layout:fixed가 열 폭(특히 첫 열)을 제대로 못 읽어와서 레이아웃이 깨졌었음.
  $('#pivotVeSummary').innerHTML =
    `<span class="pivot-vek">VE 합계 <b class="${cl(V.total.d_won)}">${sgn(V.total.d_won, 0)}원/객</b></span>` +
    `<span class="pivot-vek">원가율 <b class="${cl(V.total.d_pp)}">${sgn(V.total.d_pp, 2)}%p</b></span>` +
    `<span class="pivot-vek">현재 <b>${V.rate != null ? V.rate.toFixed(2) : '—'}%</b> → VE 후 <b>${V.total.rate_after != null ? V.total.rate_after.toFixed(2) : '—'}%</b></span>` +
    (V.targetRatio != null && V.total.rate_after != null ? `<span class="pivot-vek">타겟 ${V.targetRatio.toFixed(1)}%까지 <b class="pivot-ve-bad">${sgn(V.total.rate_after - V.targetRatio, 2)}%p</b></span>` : '');

  let H = `<thead><tr><th>대상</th><th>존</th><th>AS-IS 원/g</th><th>취식 g/객</th><th>AS-IS 원/객</th>` +
    `<th>TO-BE 원/g</th><th>TO-BE 취식g</th><th>TO-BE 원/객</th><th>Δ원/객</th><th>Δ%p</th><th>시점</th><th style="text-align:left">해결 방안</th></tr></thead><tbody>`;

  V.rows.forEach(r => {
    H += `<tr class="pivot-menu"><td style="text-align:left">${esc(r.menu_name)}${r.note ? `<br><span class="pivot-ref">${esc(r.note)}</span>` : ''}</td>` +
      `<td style="text-align:left">${esc(r.zone)}</td>` +
      `<td>${f2v(r.asis_wpg)}</td><td>${f1v(r.asis_g)}</td><td>${won(r.asis_won)}</td>` +
      `<td>${num(r.menu_name, 'tb_cost_per_gram', r.in_wpg)}</td>` +
      `<td>${num(r.menu_name, 'tb_consumption', r.in_g)}</td>` +
      `<td>${won(r.tobe_won)}</td>` +
      `<td class="${cl(r.d_won)}">${sgn(r.d_won, 0)}</td><td class="${cl(r.d_pp)}">${sgn(r.d_pp, 3)}</td>` +
      `<td>${sel(r.menu_name, r.phase)}</td>` +
      `<td style="text-align:left">${txt(r.menu_name, r.action_plan)}</td></tr>`;
  });

  H += `<tr class="pivot-zone"><td colspan="12" style="text-align:left">【시점별 누적 — 언제 얼마가 떨어지나】</td></tr>`;
  V.phases.forEach(c => {
    H += `<tr class="pivot-item"><td style="text-align:left">${esc(c.phase)}</td>` +
      `<td colspan="7" style="text-align:left" class="pivot-ref">그 시점 효과</td>` +
      `<td class="${cl(c.d)}">${sgn(c.d, 0)}</td>` +
      `<td colspan="3" style="text-align:left">누적 <b class="${cl(c.cum)}">${sgn(c.cum, 0)}원/객</b> → 원가율 <b>${c.rate != null ? c.rate.toFixed(2) : '—'}%</b></td></tr>`;
  });
  H += `<tr class="pivot-zone"><td colspan="12" style="text-align:left">【존별 — 타겟 갭이 얼마나 좁혀지나】</td></tr>`;
  V.zones.forEach(z => {
    H += `<tr class="pivot-item"><td style="text-align:left">${esc(z.zone)}</td>` +
      `<td colspan="3" style="text-align:left" class="pivot-ref">실적 ${won(z.actual)} / 타겟 ${won(z.target)} 원/객</td>` +
      `<td class="${cl(z.gap)}">${sgn(z.gap, 0)}</td>` +
      `<td colspan="2" style="text-align:left" class="pivot-ref">현재 갭</td>` +
      `<td class="${cl(z.d)}">${sgn(z.d, 0)}</td>` +
      `<td colspan="4" style="text-align:left">VE 후 갭 <b class="${cl(z.gap2)}">${sgn(z.gap2, 0)}원/객</b></td></tr>`;
  });
  H += '</tbody>';
  tbl.innerHTML = H;
}

async function veSet(menuName, field, value) {
  const numericFields = field === 'tb_cost_per_gram' || field === 'tb_consumption';
  const payloadValue = numericFields ? (value === '' ? null : Number(value)) : value;
  const existing = vePlanCache.find(p => p.menu_name === menuName);
  if (existing) existing[field] = payloadValue;
  else vePlanCache.push({ menu_name: menuName, phase: '확인 중', action_plan: '', [field]: payloadValue });
  renderVE(); // 저장 기다리지 않고 화면부터 즉시 재계산
  const row = vePlanCache.find(p => p.menu_name === menuName);
  const { error } = await sb.from('ve_plan').upsert(
    { menu_name: row.menu_name, tb_cost_per_gram: row.tb_cost_per_gram ?? null, tb_consumption: row.tb_consumption ?? null,
      phase: row.phase || '확인 중', action_plan: row.action_plan || null },
    { onConflict: 'menu_name' }
  );
  if (error) alert('저장 실패: ' + error.message);
}

async function loadPivotVEView() {
  const myToken = ++pivotLoadToken;
  const tbl = $('#pivotTable');
  tbl.innerHTML = '<tbody><tr><td style="padding:24px;color:var(--muted)">불러오는 중...</td></tr></tbody>';
  veFactsCache = await buildVeFacts();
  const { data, error } = await sb.from('ve_plan').select('*');
  if (myToken !== pivotLoadToken) return; // 그 사이 다른 탭/필터로 넘어감 — 이 결과는 버린다
  if (error) { tbl.innerHTML = `<tbody><tr><td style="padding:24px;color:var(--crit)">${esc(error.message)}</td></tr></tbody>`; return; }
  vePlanCache = data || [];
  renderVE();
}

// ---------- Start ----------
initAuth();
