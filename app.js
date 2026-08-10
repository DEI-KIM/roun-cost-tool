// ---------- Supabase setup ----------
const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

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
    const { data, error } = await q.range(from, from + pageSize - 1);
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

// 매장 타입 (저가형/일반) — 메뉴 운영패턴을 매장 타입별로 다르게 적용하기 위한 고정 매핑.
// 목록에 없는 매장(신규 오픈 포함)은 전부 "일반"으로 간주한다.
const VALUE_STORE_CODES = new Set([
  'RU030', // 수원터미널
  'RU031', // 중앙로역
  'RU033', // 일산
  'RU035', // 순천
  'RU039', // 광주역
  'RU037', // 괴정
  'RU041', // 부산대
]);
function storeType(storeCode) {
  return VALUE_STORE_CODES.has(storeCode) ? 'value' : 'regular';
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
  await loadMarketView(); // 시장 데이터는 시즌과 무관하므로 한 번만 로드
  await loadBomView(); // 레시피도 시즌과 무관하므로 한 번만 로드
}

function setupDatalist() {
  if ($('#categoryList')) return;
  const dl = document.createElement('datalist');
  dl.id = 'categoryList';
  dl.innerHTML = CATEGORY_ORDER.map(c => `<option value="${c}">`).join('');
  document.body.appendChild(dl);
}

// ---------- Seasons ----------
// 시즌의 실제 데이터 매칭은 season_id가 아니라 start_month~end_month 범위로 이루어진다.
// (자재사용량/매출·객수는 등록 연월이 이 범위 안에 들어오는 데이터를 가져와 연동한다)
function monthToDate(monthStr) { return monthStr ? `${monthStr}-01` : null; }
function dateToMonth(dateStr) { return dateStr ? String(dateStr).slice(0, 7) : ''; }
function nextMonthDate(dateStr) {
  if (!dateStr) return null;
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(y, m, 1); // m은 1-indexed이므로 그대로 넘기면 다음달 1일이 됨
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function currentSeason() {
  return state.seasons.find(s => s.id === state.currentSeasonId) || null;
}
// 시즌에 범위가 지정되어 있으면 범위로 필터링하고, 아직 범위가 없으면 기존 방식(season_id)으로 대체
function applySeasonDateFilter(query, dateField) {
  const season = currentSeason();
  if (season?.start_month && season?.end_month) {
    return query.gte(dateField, season.start_month).lt(dateField, nextMonthDate(season.end_month));
  }
  return query.eq('season_id', state.currentSeasonId);
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
  $('#seasonStartMonth').value = season ? dateToMonth(season.start_month) : '';
  $('#seasonEndMonth').value = season ? dateToMonth(season.end_month) : '';
}

function setupSeasonControls() {
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
      alert('시작월이 종료월보다 늦을 수 없습니다.');
      renderSeasonRangeInputs();
      return;
    }
    const { error } = await sb.from('seasons')
      .update({ start_month: monthToDate(startVal), end_month: monthToDate(endVal) })
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
  ]);
  await loadRecipeLog();
}

// ---------- Tab navigation ----------
function setupTabNav() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('is-active'));
      $$('.tab-panel').forEach(p => p.classList.remove('is-active'));
      btn.classList.add('is-active');
      $(`#tab-${btn.dataset.tab}`).classList.add('is-active');
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
async function loadCostTrend() {
  const [{ data: usage }, { data: sales }] = await Promise.all([
    fetchAllRows('material_usage', null, 'usage_month, actual_usage_amount'),
    fetchAllRows('store_sales', null, 'sales_date, sales_total'),
  ]);
  const costByMonth = {}, salesByMonth = {};
  (usage || []).forEach(r => {
    const m = (r.usage_month || '').slice(0, 7);
    if (!m) return;
    costByMonth[m] = (costByMonth[m] || 0) + (Number(r.actual_usage_amount) || 0);
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
  const lastPt = pts[pts.length - 1];
  const lastVal = valid[valid.length - 1];

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
      ${lastPt ? `<text x="${lastPt[0]}" y="${lastPt[1] - 10}" font-size="12" font-weight="700" fill="var(--accent-deep)" text-anchor="end">${lastVal.toFixed(1)}%</text>` : ''}
      ${xLabels}
    </svg>`;
}

function renderFeedback() {
  const list = $('#feedbackList');
  const targetPrice = state.seasonTarget?.target_price_per_person ?? null;
  const items = [];
  state.categorySummary.forEach(r => {
    const designRatio = computeCostRatio(r.design_cost_per_gram, r.design_consumption_per_person, targetPrice);
    const actualRatioCalc = computeCostRatio(r.actual_cost_per_gram, r.actual_consumption_per_person, targetPrice);
    if (designRatio == null || actualRatioCalc == null) return;
    const gap = actualRatioCalc - designRatio;
    if (gap <= 0) return;
    const sev = gap >= 1 ? 'crit' : gap >= 0.3 ? 'warn' : 'good';
    if (sev === 'good') return;
    const gramGap = (r.actual_cost_per_gram != null && r.design_cost_per_gram != null)
      ? (Number(r.actual_cost_per_gram) - Number(r.design_cost_per_gram)) : null;
    const suggestion = gramGap
      ? `g당원가를 약 ${gramGap.toFixed(2)}g 낮추거나, 인당소비량 조정을 검토하세요.`
      : `자재단가 또는 레시피 투입량 조정을 검토하세요.`;
    items.push({ sev, text: `${r.category} 실적원가율이 설계 대비 +${gap.toFixed(1)}%p 높습니다 → ${suggestion}` });
  });
  items.sort((a, b) => (b.sev === 'crit') - (a.sev === 'crit'));
  list.innerHTML = items.length
    ? items.map(i => `<li class="sev-${i.sev}">${i.text}</li>`).join('')
    : `<li class="sev-good">모든 카테고리가 설계원가 범위 안에 있습니다.</li>`;
}

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
// data-col: 0=카테고리 1=메뉴명 2=g당원가 3=인당소비량 (원가율은 자동계산이라 붙여넣기 대상이 아님)
const menuGridBody = $('#menuGridBody');
function recomputeMenuRowRatio(tr) {
  const gram = tr.querySelector('input[data-col="2"]').value;
  const cons = tr.querySelector('input[data-col="3"]').value;
  const ratio = computeCostRatio(numOrNull(gram), numOrNull(cons), state.seasonTarget?.target_price_per_person);
  tr.querySelector('.computed-ratio-cell').textContent = ratio != null ? ratio.toFixed(1) + '%' : '-';
}
function addMenuRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" data-col="0" list="categoryList"></td>
    <td><input type="text" data-col="1"></td>
    <td class="cell-left computed-ratio-cell">-</td>
    <td><input type="number" step="0.01" data-col="2"></td>
    <td><input type="number" step="1" data-col="3"></td>
    <td><input type="text" data-col="4" list="patternList"></td>
    <td><input type="text" data-col="5" list="patternList"></td>
    <td><button type="button" class="row-del-btn" title="삭제">×</button></td>
  `;
  tr.querySelector('.row-del-btn').addEventListener('click', () => tr.remove());
  tr.querySelector('input[data-col="2"]').addEventListener('input', () => recomputeMenuRowRatio(tr));
  tr.querySelector('input[data-col="3"]').addEventListener('input', () => recomputeMenuRowRatio(tr));
  menuGridBody.appendChild(tr);
  return tr;
}
for (let i = 0; i < 5; i++) addMenuRow();
$('#addMenuRowBtn').addEventListener('click', () => addMenuRow());
attachPasteFill(menuGridBody, addMenuRow);
menuGridBody.addEventListener('paste', () => setTimeout(() => $$('tr', menuGridBody).forEach(recomputeMenuRowRatio), 0));

$('#saveMenuGridBtn').addEventListener('click', async () => {
  if (!state.currentSeasonId) return;
  const targetPrice = state.seasonTarget?.target_price_per_person ?? null;
  const rows = [];
  $$('tr', menuGridBody).forEach(tr => {
    const category = tr.querySelector('input[data-col="0"]').value;
    const menu_name = tr.querySelector('input[data-col="1"]').value;
    const cost_per_gram = tr.querySelector('input[data-col="2"]').value;
    const consumption_per_person = tr.querySelector('input[data-col="3"]').value;
    const availability_pattern_value = tr.querySelector('input[data-col="4"]').value;
    const availability_pattern_regular = tr.querySelector('input[data-col="5"]').value;
    if (!category || !menu_name) return;
    rows.push({
      season_id: state.currentSeasonId, category: normalizeCategory(category), menu_name: menu_name.trim(),
      cost_per_gram: numOrNull(cost_per_gram), consumption_per_person: numOrNull(consumption_per_person),
      cost_ratio: computeCostRatio(numOrNull(cost_per_gram), numOrNull(consumption_per_person), targetPrice),
      availability_pattern_value: availability_pattern_value ? availability_pattern_value.trim() : null,
      availability_pattern_regular: availability_pattern_regular ? availability_pattern_regular.trim() : null,
    });
  });
  if (!rows.length) { flash($('#menuSaveMsg'), '입력된 행이 없습니다.', false); return; }
  const { error } = await sb.from('menu_designs').insert(rows);
  if (error) { flash($('#menuSaveMsg'), '저장 실패: ' + error.message, false); return; }

  // recompute category_summary design_* rollup
  await rebuildCategoryDesignRollup(state.currentSeasonId);

  menuGridBody.innerHTML = '';
  for (let i = 0; i < 5; i++) addMenuRow();
  flash($('#menuSaveMsg'), `${rows.length}개 메뉴가 저장되었습니다.`);
  await loadDashboard();
  await loadRecipeLog();
});

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
//           6=환산계수 7=자재단가 8=전처리수율 9=투입중량 10=자재사용량 11=운영패턴(저가형) 12=운영패턴(일반)
const BOM_FIELDS = ['season_name', 'menu_name', 'category', 'cooked_weight', 'material_code', 'material_name',
  'conversion_factor', 'material_price', 'prep_yield', 'input_weight', 'usage_amount', 'availability_pattern_value', 'availability_pattern_regular'];
const BOM_NUMERIC_COLS = [3, 6, 7, 8, 9, 10];

const bomGridBody = $('#bomGridBody');
function addBomRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = BOM_FIELDS.map((f, i) => {
    const isNumeric = BOM_NUMERIC_COLS.includes(i);
    const listAttr = f === 'category' ? 'list="categoryList"' : f === 'season_name' ? 'list="seasonNameList"' : (f === 'availability_pattern_value' || f === 'availability_pattern_regular') ? 'list="patternList"' : '';
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
    </tr>
  `).join('') || `<tr><td colspan="14" style="text-align:center;color:var(--muted)">등록된 레시피가 없습니다.</td></tr>`;
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
      <td class="col-check"><button type="button" class="row-del-btn" title="삭제">×</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="10" style="text-align:center;color:var(--muted)">데이터가 없습니다.</td></tr>`;

  $$('input.cell-input', body).forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const tr = e.target.closest('tr');
      const id = Number(tr.dataset.id);
      const seasonId = Number(tr.dataset.seasonId);
      const field = e.target.dataset.field;
      const isText = field === 'category' || field === 'menu_name' || field === 'availability_pattern_value' || field === 'availability_pattern_regular';
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
  const [{ data: designs, error: designErr }, { data: consumption, error: consErr }] = await Promise.all([
    fetchAllRows('menu_designs', q => q.eq('season_id', state.currentSeasonId).order('created_at', { ascending: true })),
    fetchAllRows('menu_consumption', q => q.eq('season_id', state.currentSeasonId)),
  ]);
  if (designErr || consErr) { console.error(designErr || consErr); return; }

  // 같은 메뉴명이 여러 번 저장됐으면 가장 최근 값을 그 메뉴의 현재 설계원가로 사용
  const byMenu = new Map();
  (designs || []).forEach(m => { if (m.menu_name) byMenu.set(m.menu_name, m); });
  const consumptionByMenu = Object.fromEntries((consumption || []).map(c => [c.menu_name, c]));
  const seasonName = state.seasons.find(s => s.id === state.currentSeasonId)?.name ?? '-';

  menuConsumptionRowsCache = [...byMenu.values()].map(m => {
    const c = consumptionByMenu[m.menu_name];
    const consumptionPerPerson = c?.consumption_per_person ?? null;
    const actualCostPerGram = c?.actual_cost_per_gram ?? null;
    const effectiveCostPerGram = actualCostPerGram ?? m.cost_per_gram;
    const value = (effectiveCostPerGram != null && consumptionPerPerson != null) ? effectiveCostPerGram * consumptionPerPerson : null;
    return {
      menu_name: m.menu_name, category: m.category, cost_per_gram: m.cost_per_gram,
      actual_cost_per_gram: actualCostPerGram, cost_source: c?.cost_source ?? null, cost_month: c?.cost_month ?? null,
      consumption_per_person: consumptionPerPerson,
      consumption_per_person_excl_water: c?.consumption_per_person_excl_water ?? null,
      value, seasonName,
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
    const costBadge = costSrc
      ? `<span class="${costSrc.cls}">${fmtNum(m.actual_cost_per_gram, 2)}</span>${m.cost_month ? ` <span class="hint">${m.cost_month.slice(0, 7)}</span>` : ''}`
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
    </tr>`;
  }).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--muted)">설계원가 탭에 저장된 메뉴가 없습니다.</td></tr>`;
}

$('#menuConsumptionSortSelect').addEventListener('change', renderMenuConsumptionView);

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
  // 시간대의 객수로 좁히는 데 쓰인다. 저가형/일반 매장이 서로 다른 패턴을 가질 수 있어 매장타입별로 따로 저장.
  // 안 정해져 있으면 상시로 간주(기존 동작과 동일).
  const availabilityPatternByMenu = new Map();
  byMenu.forEach((rows, name) => availabilityPatternByMenu.set(name, {
    value: rows[0]?.availability_pattern_value || '상시',
    regular: rows[0]?.availability_pattern_regular || '상시',
  }));

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
  return { flatByMenu, cookedWeightByMenu, finalMenus, rawMaterialNameByCode, availabilityPatternByMenu };
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
function longestCommonSubstringLength(a, b) {
  let maxLen = 0;
  let prevRow = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const curRow = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        curRow[j] = prevRow[j - 1] + 1;
        if (curRow[j] > maxLen) maxLen = curRow[j];
      }
    }
    prevRow = curRow;
  }
  return maxLen;
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
      const lcsLen = longestCommonSubstringLength(cleanA, cleanB);
      // 2글자 이하로만 겹치면 "기름/소스/육수" 같은 흔한 종류어일 뿐인 경우가 많아 제외
      if (lcsLen < 3) return;
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

  const { data: usageRows } = await fetchAllRows('material_usage', q => applySeasonDateFilter(q, 'usage_month'));
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
function estimateGramsProduced({ flatByMenu, cookedWeightByMenu, finalMenus, find, materialToMenus, clusterGramsInMenu, designByMenu }, actualByMaterial, onNoEvidence) {
  const gramsProducedByMenu = new Map();
  const sourceByMenu = new Map();
  const confidenceByMenu = new Map();

  // ---- 1단계: 전용자재 메뉴 ----
  const unknownMenus = [];
  finalMenus.forEach(menu => {
    const flatBOM = flatByMenu.get(menu);
    const cookedWeight = cookedWeightByMenu.get(menu);
    if (!flatBOM.size || !cookedWeight) { unknownMenus.push(menu); return; }
    const exclusiveKeys = [...new Set([...flatBOM.keys()].map(find))].filter(key => materialToMenus.get(key)?.size === 1);
    const estimates = [];
    exclusiveKeys.forEach(key => {
      const U = actualByMaterial.get(key);
      const gramsPerBatch = clusterGramsInMenu(menu, key);
      if (U != null && gramsPerBatch > 0) estimates.push(U * cookedWeight / gramsPerBatch);
    });
    if (estimates.length) {
      gramsProducedByMenu.set(menu, estimates.reduce((a, v) => a + v, 0) / estimates.length);
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
      gramsProducedByMenu.set(menu, Math.max(0, x[menu] || 0));
      sourceByMenu.set(menu, confidence >= 0.6 ? 'allocated' : 'design_fallback');
      confidenceByMenu.set(menu, Math.round(confidence * 100));
    });
  });

  return { gramsProducedByMenu, sourceByMenu, confidenceByMenu };
}

// 메뉴별 인당소비량을 "매장별로 먼저 취합한 뒤 브랜드로 합산"하는 방식으로 계산한다.
// (예전에는 전 매장 실사용량을 하나로 합쳐서 한 번에 배분했는데, 그러면 디너/주말 메뉴가 덜 들어가는 일부
//  매장의 편차가 브랜드 평균에 왜곡되어 반영되고, 매장별 이상값도 구분할 수 없었음)
async function computeMenuConsumption(onProgress) {
  const seasonId = state.currentSeasonId;
  if (!seasonId) return { error: '시즌이 선택되지 않았습니다.' };

  const flat = await flattenRecipesForSeason(seasonId);
  if (!flat) return { error: '레시피 데이터를 불러오지 못했습니다.' };
  const { flatByMenu, cookedWeightByMenu, finalMenus, availabilityPatternByMenu } = flat;

  const [{ data: usageRows, error: usageErr }, { data: salesRows, error: salesErr }, { data: designRows }, aliasRes] = await Promise.all([
    fetchAllRows('material_usage', q => applySeasonDateFilter(q, 'usage_month')),
    fetchAllRows('store_sales', q => applySeasonDateFilter(q, 'sales_date')),
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

  const WATER_CODES = ['음용수', '정제수'];
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

  // ---- 매장별로 각각 1단계(전용자재)+2단계(IPF) 계산. 그 매장에 근거가 전혀 없는 메뉴는 "데이터없음"으로 남겨둔다 ----
  // 매장 수만큼 IPF를 반복 계산하느라 시간이 걸려서, 매장 사이마다 한 틱씩 양보해 브라우저가 멈춘 것처럼 보이지 않게 하고
  // 진행 상황을 onProgress로 알려준다.
  const perStore = [];
  for (let i = 0; i < storeCodes.length; i++) {
    const storeCode = storeCodes[i];
    if (onProgress) onProgress(i + 1, storeCodes.length, storeMap.get(storeCode));
    await new Promise(r => setTimeout(r, 0));
    const actualByMaterial = buildActualByMaterial(usageByStore.get(storeCode) || []);
    const { gramsProducedByMenu, sourceByMenu, confidenceByMenu } = estimateGramsProduced(recipeCtx, actualByMaterial, () => {});
    perStore.push({
      store_code: storeCode, store_name: storeMap.get(storeCode), store_type: storeType(storeCode),
      customersByPattern: customersByStorePattern.get(storeCode) || emptyPatternBucket(),
      gramsProducedByMenu, sourceByMenu, confidenceByMenu,
    });
  }

  // ---- 브랜드 전체(전 매장 실사용량 합)는 안전망 용도로만 계산 — 모든 매장에서 데이터없음인 메뉴에 한해 설계값 대체 ----
  const totalCustomers = (salesRows || []).reduce((a, r) => a + (Number(r.customers_total) || 0), 0);
  const totalSales = (salesRows || []).reduce((a, r) => a + (Number(r.sales_total) || 0), 0);
  const pricePerCustomer = totalCustomers ? totalSales / totalCustomers : null;

  const consumptionOverrideByMenu = new Map();
  estimateGramsProduced(recipeCtx, buildActualByMaterial(usageRows || []), (menu) => {
    const d = designByMenu.get(menu);
    if (d?.consumption_per_person > 0) consumptionOverrideByMenu.set(menu, d.consumption_per_person);
  });

  // ---- 메뉴별로 매장 결과를 취합해 브랜드값을 만든다 (실사용 근거가 있는 매장만 분자/분모에 반영) ----
  // 분모(객수)는 메뉴의 운영패턴에 맞는 객수를 쓴다 — 자재사용량은 월 단위라 그램(분자)은 못 쪼개지만,
  // "이 메뉴를 살 수 있었던 손님 수"로 나누면 상시가 아닌 메뉴의 인당소비량이 실제에 가깝게 잡힌다.
  const results = finalMenus.map(menu => {
    const wr = waterRatio(menu);
    const patternsForMenu = availabilityPatternByMenu.get(menu) || { value: '상시', regular: '상시' };
    const patternFor = (type) => {
      const p = type === 'value' ? patternsForMenu.value : patternsForMenu.regular;
      return PATTERNS.includes(p) ? p : '상시';
    };
    let sumGrams = 0, sumCustomers = 0, storesWithData = 0, anyAllocated = false;
    const perStoreOut = perStore.map(s => {
      const grams = s.gramsProducedByMenu.get(menu);
      const hasData = grams != null;
      const storeCustomers = s.customersByPattern[patternFor(s.store_type)] || 0;
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

    return {
      menu_name: menu,
      consumption_per_person,
      consumption_per_person_excl_water: consumption_per_person != null ? consumption_per_person * (1 - wr) : null,
      consumption_source,
      confidence,
      availability_pattern_value: patternsForMenu.value,
      availability_pattern_regular: patternsForMenu.regular,
      stores_with_data: storesWithData,
      stores_total: storeCodes.length,
      per_store: perStoreOut,
    };
  });

  return { results, totalCustomers, totalSales, pricePerCustomer };
}

// 메뉴별 "실제 g당원가"를 계산한다. 레시피 등록 시점에 넣어둔 자재단가(material_price)는 최초 1회성 값이라
// 지금 실제로 쓰이는 단가와 다를 수 있어서, 시즌 내 자재사용량 데이터가 있는 가장 최근 달의 브랜드 전체
// 가중평균 단가(실사용금액 ÷ 실사용량)로 다시 계산한다. 그 달에 실사용 근거가 없는 자재는 레시피 등록
// 단가로 대체하되, 대체 비중이 너무 크면(전체 그램의 5% 초과) 신뢰할 수 없다고 보고 비워둔다.
async function computeActualCostPerGram(seasonId) {
  const flat = await flattenRecipesForSeason(seasonId);
  if (!flat) return { error: '레시피 데이터를 불러오지 못했습니다.' };
  const { flatByMenu, cookedWeightByMenu, finalMenus } = flat;

  const { data: monthRows } = await fetchAllRows('material_usage', q => applySeasonDateFilter(q, 'usage_month'), 'usage_month');
  const months = [...new Set((monthRows || []).map(r => r.usage_month).filter(Boolean))].sort();
  const latestMonth = months[months.length - 1];
  if (!latestMonth) return { error: '자재사용량 데이터가 없습니다.' };

  const [{ data: usageRows }, { data: recipeRows }, aliasRes] = await Promise.all([
    fetchAllRows('material_usage', q => q.eq('usage_month', latestMonth), 'material_code, actual_usage_qty, actual_usage_amount, conversion_factor'),
    fetchAllRows('recipe_items', q => q.eq('season_id', seasonId), 'material_code, material_price'),
    sb.from('material_aliases').select('primary_material_code, alt_material_code').eq('status', 'confirmed'),
  ]);
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

  // 별칭그룹(대표코드) 단위로 그 달 총 사용금액/총 그램을 모아 가중평균 g당단가를 만든다.
  const costByCluster = new Map(), gramsByCluster = new Map();
  (usageRows || []).forEach(r => {
    if (!r.material_code || !r.actual_usage_qty) return;
    const grams = Number(r.actual_usage_qty) * (Number(r.conversion_factor) || 0);
    if (!grams) return;
    const key = find(r.material_code);
    gramsByCluster.set(key, (gramsByCluster.get(key) || 0) + grams);
    costByCluster.set(key, (costByCluster.get(key) || 0) + (Number(r.actual_usage_amount) || 0));
  });
  const realPricePerGram = new Map(); // 대표코드 -> 원/g (그 달 브랜드 전체 가중평균)
  gramsByCluster.forEach((grams, key) => { if (grams > 0) realPricePerGram.set(key, costByCluster.get(key) / grams); });

  // 레시피 등록 단가(원/kg 기준으로 입력돼있어 1000으로 나눠 원/g로 맞춤)는 실단가 없는 자재의 대체값으로만 사용.
  const fallbackPriceByCode = new Map();
  (recipeRows || []).forEach(r => {
    if (r.material_code && r.material_price != null && !fallbackPriceByCode.has(r.material_code)) {
      fallbackPriceByCode.set(r.material_code, Number(r.material_price) / 1000);
    }
  });

  function priceForCode(code) {
    const real = realPricePerGram.get(find(code));
    if (real != null) return { price: real, isReal: true };
    const fb = fallbackPriceByCode.get(code);
    if (fb != null) return { price: fb, isReal: false };
    return null;
  }

  const results = finalMenus.map(menu => {
    const bom = flatByMenu.get(menu);
    const cookedWeight = cookedWeightByMenu.get(menu);
    if (!bom?.size || !cookedWeight) return { menu_name: menu, actual_cost_per_gram: null, cost_source: null };

    let totalCost = 0, totalGrams = 0, realGrams = 0;
    bom.forEach((grams, code) => {
      totalGrams += grams;
      const p = priceForCode(code);
      if (!p) return;
      totalCost += grams * p.price;
      if (p.isReal) realGrams += grams;
    });

    // "실단가로 확보된" 비중이 95% 미만이면(레시피 등록 단가로 대체된 부분이 5%를 넘으면) 신뢰할 수 없다고 보고 비워둔다.
    // (레시피 등록 단가는 최초 1회성 수기입력이라 검증된 적이 없어서, 대체 비중이 크면 엉뚱한 값을 그대로 실적에 반영하게 됨)
    const realRatio = totalGrams > 0 ? realGrams / totalGrams : 0;
    if (totalGrams <= 0 || realRatio < 0.95) {
      return { menu_name: menu, actual_cost_per_gram: null, cost_source: null };
    }
    return {
      menu_name: menu,
      actual_cost_per_gram: totalCost / cookedWeight,
      cost_source: realRatio >= 0.999 ? 'actual' : 'partial',
    };
  });

  return { results, costMonth: latestMonth };
}

// 메뉴별 인당소비량(소비가중평균)을 카테고리 단위로 합산해 대시보드 실적에 반영
async function rebuildCategoryActualRollupFromMenus(seasonId, targetPrice, totalSales, totalCustomers) {
  const [{ data: designs }, { data: consumption }] = await Promise.all([
    fetchAllRows('menu_designs', q => q.eq('season_id', seasonId)),
    fetchAllRows('menu_consumption', q => q.eq('season_id', seasonId)),
  ]);
  const consumptionByMenu = Object.fromEntries((consumption || []).map(c => [c.menu_name, c]));
  const byCat = {};
  (designs || []).forEach(m => {
    const c = consumptionByMenu[m.menu_name];
    // 실제 자재사용량 기준으로 재계산한 g당원가가 있으면 그걸 쓰고, 아직 계산 전인 메뉴는 설계 단가로 대체
    const costPerGram = c?.actual_cost_per_gram ?? m.cost_per_gram;
    if (!m.category || c?.consumption_per_person == null || costPerGram == null) return;
    if (!byCat[m.category]) byCat[m.category] = [];
    byCat[m.category].push({
      cost_per_gram: costPerGram, consumption_per_person: c.consumption_per_person,
      consumption_per_person_excl_water: c.consumption_per_person_excl_water ?? c.consumption_per_person,
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

    await rebuildCategoryActualRollupFromMenus(state.currentSeasonId, pricePerCustomer, totalSales, totalCustomers);

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

  const [{ data: usage, error: usageErr }, { data: marketRows }] = await Promise.all([
    fetchAllRows('material_usage',
      q => q.eq('usage_month', monitorMonth).eq('remark', '농산').eq('tax_status', '비과세')),
    fetchAllRows('market_prices', q => q.gte('record_date', monitorMonth).lt('record_date', nextMonthStr).in('grade', ['상', '특'])),
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

  // 품목별로 시장데이터에서 이름이 비슷한 상/특 등급 항목을 찾아, 시장단가=g당단가 평균, 타겟단가=그 중 가장 낮은 g당단가(강서/가락 통틀어 최저가 1건)로 산출
  const marketPriceUpserts = [];
  const computedMarketByItem = {};
  const computedTargetByItem = {};
  items.forEach(item => {
    const matches = (marketRows || []).filter(mr => isFuzzyItemMatch(item, mr.item_name));
    const gpgList = matches
      .map(mr => { const g = parseUnitToGrams(mr.unit); return (g && mr.avg_price != null) ? mr.avg_price / g : null; })
      .filter(v => v != null);
    if (gpgList.length) {
      const avg = gpgList.reduce((a, v) => a + v, 0) / gpgList.length;
      const min = Math.min(...gpgList);
      computedMarketByItem[item] = avg;
      computedTargetByItem[item] = min;
      marketPriceUpserts.push({ item_name: item, monitor_month: monitorMonth, market_price: avg, target_price: min });
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
    const targetPrice = computedTargetByItem[item] ?? mp.target_price ?? null;
    const usageAmount = direct.amount + purchase.amount;

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
      market_price: marketPrice, usage_amount: usageAmount,
      target_savings: targetSavings, market_savings: marketSavings,
    };
  });

  renderProduceTable();
}

function renderProduceTable() {
  const sortMode = $('#produceSortSelect').value;
  const rows = produceRowsCache.slice().sort((a, b) => {
    if (sortMode === 'usage') return (b.usage_amount || 0) - (a.usage_amount || 0);
    if (sortMode === 'target') return (b.target_savings ?? -Infinity) - (a.target_savings ?? -Infinity);
    if (sortMode === 'market') return (b.market_savings ?? -Infinity) - (a.market_savings ?? -Infinity);
    return a.item_name.localeCompare(b.item_name, 'ko');
  });

  const body = $('#produceTableBody');
  body.innerHTML = rows.map(r => `
    <tr data-item="${r.item_name}">
      <td class="cell-left produce-item-name">${r.item_name}</td>
      <td>${r.target_price != null ? fmtNum(r.target_price, 1) : '-'}</td>
      <td>${r.brand_price_direct != null ? fmtNum(r.brand_price_direct, 1) : '-'}</td>
      <td>${r.brand_price_purchase != null ? fmtNum(r.brand_price_purchase, 1) : '-'}</td>
      <td>${r.market_price != null ? fmtNum(r.market_price, 1) : '-'}</td>
      <td>${fmtNum(r.usage_amount, 0)}</td>
      <td>${r.target_savings != null ? fmtNum(r.target_savings, 0) : '-'}</td>
      <td>${r.market_savings != null ? fmtNum(r.market_savings, 0) : '-'}</td>
    </tr>
  `).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--muted)">해당 연월에 농산 자재 데이터가 없습니다.</td></tr>`;

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
  const marketByMonth = {}, targetByMonth = {};
  Object.entries(gpgByMonth).forEach(([k, list]) => {
    marketByMonth[k] = list.reduce((a, v) => a + v, 0) / list.length;
    targetByMonth[k] = Math.min(...list);
  });

  const months = [...new Set([...Object.keys(byMonth), ...Object.keys(marketByMonth)])].sort();
  renderProduceChart(
    months,
    months.map(m => targetByMonth[m] ?? null),
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
    { label: '로운(직송)', color: 'var(--chart-2)', values: directSeries },
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
    const pts = s.values.map((v, i) => v != null ? [xFor(i), yFor(v)] : null).filter(Boolean);
    return { s, path: buildSmoothPath(pts), pts };
  });
  const paths = seriesSvg.map(({ s, path }) => path ? `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linecap="round" />` : '').join('');
  const dots = seriesSvg.flatMap(({ s, pts }) => pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="${s.color}" />`)).join('');
  const legend = seriesDefs.map(s => `<span><span class="dot" style="background:${s.color}"></span>${s.label}</span>`).join('');

  wrap.innerHTML = `
    <div class="chart-legend">${legend}</div>
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-width:${width}px;">
      ${gridLines}${paths}${dots}${xLabels}
    </svg>`;
}

// =====================================================================
// Tab 6: Material usage (자재 사용량)
// =====================================================================
const USAGE_FIELDS = ['store_code', 'store_name', 'material_code', 'material_name', 'stock_unit', 'spec', 'conversion_factor',
  'prev_stock_qty', 'prev_stock_amount', 'received_qty', 'received_amount',
  'current_stock_qty', 'current_stock_amount', 'actual_usage_qty', 'actual_usage_amount', 'remark', 'item_name', 'tax_status'];
const USAGE_NUMERIC_FROM = 6; // conversion_factor onward through actual_usage_amount (index 14) are numeric
const USAGE_NUMERIC_TO = 14;

// default the month picker to the current month
(() => {
  const now = new Date();
  $('#usageMonthInput').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
})();

const usageGridBody = $('#usageGridBody');
function addUsageRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = USAGE_FIELDS.map((f, i) => {
    const isNumeric = i >= USAGE_NUMERIC_FROM && i <= USAGE_NUMERIC_TO;
    const listAttr = f === 'tax_status' ? 'list="taxStatusList"' : '';
    return `<td><input type="${isNumeric ? 'number' : 'text'}" ${isNumeric ? 'step="0.01"' : ''} data-col="${i}" ${listAttr}></td>`;
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
  const usageMonth = `${monthValue}-01`;
  const rows = [];
  $$('tr', usageGridBody).forEach(tr => {
    const values = USAGE_FIELDS.map((_, i) => tr.querySelector(`input[data-col="${i}"]`).value);
    if (!values[3] && !values[2]) return; // need at least material name or code
    const rec = { season_id: state.currentSeasonId, usage_month: usageMonth };
    USAGE_FIELDS.forEach((f, i) => {
      rec[f] = (i >= USAGE_NUMERIC_FROM && i <= USAGE_NUMERIC_TO) ? numOrNull(values[i]) : (values[i] ? values[i].trim() : null);
    });
    rows.push(rec);
  });
  if (!rows.length) { flash($('#usageSaveMsg'), '입력된 행이 없습니다.', false); return; }

  // 같은 시즌+연월에 매장+자재 조합이 이미 있으면 이전 값을 지우고 새 값으로 교체 (다른 연월 데이터는 그대로 유지)
  const keys = new Set(rows.map(r => `${r.store_code}||${r.material_code}`));
  const { data: existing } = await fetchAllRows('material_usage',
    q => q.eq('usage_month', usageMonth), 'id, store_code, material_code');
  const toDelete = (existing || []).filter(e => keys.has(`${e.store_code}||${e.material_code}`)).map(e => e.id);
  if (toDelete.length) await deleteInChunks('material_usage', toDelete);

  const { error } = await sb.from('material_usage').insert(rows);
  if (error) { flash($('#usageSaveMsg'), '저장 실패: ' + error.message, false); return; }
  usageGridBody.innerHTML = '';
  for (let i = 0; i < 3; i++) addUsageRow();
  flash($('#usageSaveMsg'), `${rows.length}개 행이 저장되었습니다.${toDelete.length ? ` (${monthValue} 내 겹치는 ${toDelete.length}개 교체됨)` : ''}`);
  await loadUsageView();
});

let usageViewCache = [];
async function loadUsageView() {
  if (!state.currentSeasonId) return;
  const { data: raw, error } = await fetchAllRows('material_usage', q => applySeasonDateFilter(q, 'usage_month'));
  if (error) { console.error(error); return; }
  usageViewCache = raw || [];
  renderUsageView();
}

function renderUsageView() {
  const monthFilter = $('#usageViewMonthFilter').value; // "YYYY-MM"
  const data = usageViewCache
    .filter(r => !monthFilter || (r.usage_month || '').slice(0, 7) === monthFilter)
    .slice()
    .sort((a, b) => (Number(b.actual_usage_amount) || 0) - (Number(a.actual_usage_amount) || 0));
  const body = $('#usageViewBody');
  body.innerHTML = (data || []).map(r => `
    <tr data-id="${r.id}">
      <td class="col-check"><input type="checkbox" class="row-check"></td>
      <td>${r.usage_month ? r.usage_month.slice(0, 7) : '-'}</td>
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

$('#usageViewMonthFilter').addEventListener('change', renderUsageView);

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
  await loadUsageView();
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

// ---------- Start ----------
initAuth();
