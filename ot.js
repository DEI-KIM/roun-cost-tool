// 로운 OT — M1: 계획 시뮬레이션(엔진 v8 이관) + 전사 대시보드(8월 실측) + 기준정보
// PRD v1.1 기준. 엔진 산출은 표준 사용 계획표(F4) 수령 전까지의 임시 기준.

// ---------- Supabase (원가설계판과 동일 프로젝트·계정) ----------
const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = id => document.getElementById(id);
const won = n => Math.round(n).toLocaleString('ko-KR');

// ---------- 상수 (PRD §5.1 — 기준정보로 오버라이드 예정) ----------
const TARGET = 72000, PREP = 2, MINP = 2;
const HOURS = ["10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00"];
const WD = ["월","화","수","목","금","토","일"];
const PARTS = ["카운터","프리버싱","프랩","콜파트","핫파트","육절기","DMO"];
const GRADE_ORDER = ["선임점장","점장","부점장","GM","매니저","캡틴","헤드","ST","TM","HIT"];
const ENGINE_VERSION = 'ot-m1-v8';

// 직급 단가: 시드 → (로그인 후 DB grades 있으면 교체)
let gradeCost = { ...OT_GRADES };
// 매장별 직급 구성 상태 (시뮬레이션 입력)
let staffCnt = {};

// ---------- 인증 ----------
let currentUser = null, currentRole = 'planner';

async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) enterApp(session.user); else showLogin();
}
// 로그인은 랜딩(../)에서 통합 처리 — 세션 없으면 랜딩으로
function showLogin() { location.replace('../'); }
async function enterApp(user) {
  currentUser = user;
  $('loginView').hidden = true; $('appView').hidden = false;
  $('whoEmail').textContent = user.email;
  // profiles가 있으면 role 반영 (없으면 planner로 동작 — M1은 기획자 계정만)
  try {
    const { data } = await sb.from('ot_profiles').select('role,store_code').eq('user_id', user.id).maybeSingle();
    if (data && data.role) currentRole = data.role;
  } catch (e) { /* 테이블 미생성 시 무시 */ }
  $('roleChip').textContent = currentRole === 'manager' ? '매장 관리자' : '기획자';
  // DB grades가 있으면 시드 대신 사용
  try {
    const { data } = await sb.from('ot_grades').select('grade,std_monthly_cost');
    if (data && data.length) for (const g of data) if (g.grade in gradeCost) gradeCost[g.grade] = g.std_monthly_cost;
  } catch (e) { /* 미생성 시 시드 유지 */ }
  renderDash(); renderRef(); buildPlanInputs(); render();
  showView(currentRole === 'manager' ? 'plan' : 'dash'); // PRD §7: manager 홈 = S2
}
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginError').hidden = true;
  const { data, error } = await sb.auth.signInWithPassword({
    email: $('loginEmail').value.trim(), password: $('loginPassword').value });
  if (error) { $('loginError').textContent = '로그인 실패: ' + error.message; $('loginError').hidden = false; return; }
  enterApp(data.user);
});
$('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.reload(); };

// ---------- 내비게이션 (PRD §7 순서) ----------
function showView(v) {
  document.querySelectorAll('#otNav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  for (const k of ['dash','plan','feedback','actual','ref']) $('view-' + k).hidden = (k !== v);
}
document.querySelectorAll('#otNav button').forEach(b => {
  if (!b.disabled) b.onclick = () => showView(b.dataset.view);
});

// ---------- S1 전사 대시보드 (2026-08 실측) ----------
function prodBand(p) { return p >= TARGET ? 'g' : p >= 60000 ? 'w' : 'c'; }
function renderDash() {
  const rows = Object.entries(OT_DATA).map(([code, s]) => ({
    code, name: s.name, sales: s.augM, mh: s.aug.mh, mmh: s.aug.mmh,
    prod: s.aug.prod, need: s.aug.need, over: s.aug.mh - s.aug.need
  })).sort((a, b) => b.prod - a.prod);
  const tSales = rows.reduce((t, r) => t + r.sales, 0);
  const tMH = rows.reduce((t, r) => t + r.mh, 0);
  const tOver = rows.reduce((t, r) => t + Math.max(0, r.over), 0);
  const nOk = rows.filter(r => r.prod >= TARGET).length;
  $('dashKpis').innerHTML =
    `<div><div class="k">전사 매출 (8월)</div><div class="v">${(tSales/1e8).toFixed(1)}억</div><div class="s">17개 매장</div></div>` +
    `<div><div class="k">전사 생산성</div><div class="v">${won(tSales/tMH)}</div><div class="s">원/MH · 목표 72,000</div></div>` +
    `<div><div class="k">목표 달성 매장</div><div class="v">${nOk} / ${rows.length}</div><div class="s">생산성 ≥ 72,000</div></div>` +
    `<div><div class="k">과잉 투입 합계</div><div class="v" style="color:var(--crit)">+${won(tOver)}</div><div class="s">MH/월 · 절감 여지</div></div>`;
  const maxOver = Math.max(...rows.map(r => Math.abs(r.over)));
  let html = '<table><colgroup><col style="width:150px"><col style="width:80px"><col style="width:80px"><col style="width:90px"><col style="width:80px"><col style="width:170px"><col style="width:90px"></colgroup>' +
    '<thead><tr><th>매장</th><th>매출(억)</th><th>총 MH</th><th>생산성(원/MH)</th><th>필요 MH</th><th>과잉 MH</th><th>밴드</th></tr></thead><tbody>';
  for (const r of rows) {
    const b = prodBand(r.prod);
    const w = Math.round(Math.abs(r.over) / maxOver * 90);
    html += `<tr class="rowlink" data-code="${r.code}"><td>${r.name}</td><td>${(r.sales/1e8).toFixed(2)}</td>` +
      `<td>${won(r.mh)}</td><td><b>${won(r.prod)}</b></td><td>${won(r.need)}</td>` +
      `<td>${r.over > 0 ? '+' + won(r.over) : won(r.over)} <span class="mini" style="width:${w}px;${r.over<=0?'background:var(--dark)':''}"></span></td>` +
      `<td><span class="band ${b}">${b==='g'?'목표권':b==='w'?'관리':'미달'}</span></td></tr>`;
  }
  $('dashTable').innerHTML = html + '</tbody></table>';
  $('dashTable').querySelectorAll('tr.rowlink').forEach(tr => {
    tr.onclick = () => { sel.value = tr.dataset.code; onStoreChange(); showView('plan'); };
  });
}

// ---------- S5 기준정보 ----------
function renderRef() {
  let gh = '<table><colgroup><col><col style="width:130px"></colgroup><thead><tr><th>직급</th><th>월 표준 인건비(원)</th></tr></thead><tbody>';
  for (const g of GRADE_ORDER)
    gh += `<tr><td>${g}</td><td><input type="number" step="10000" data-grade="${g}" value="${gradeCost[g]}"></td></tr>`;
  $('gradeTable').innerHTML = gh + '</tbody></table>';
  $('gradeTable').querySelectorAll('input').forEach(inp => {
    inp.oninput = () => { gradeCost[inp.dataset.grade] = +inp.value || 0; updateStaffSum(); render(); };
  });
  let ch = '<table><colgroup><col style="width:110px"><col style="width:90px"><col style="width:80px"><col></colgroup>' +
    '<thead><tr><th>매장</th><th>실질시급</th><th>공휴일지수</th><th>정직원 구성(8월)</th></tr></thead><tbody>';
  for (const [code, s] of Object.entries(OT_DATA)) {
    const st = OT_STAFF0[code] || {};
    const txt = GRADE_ORDER.filter(g => st[g]).map(g => `${g}${st[g] > 1 ? '×' + st[g] : ''}`).join(' · ');
    ch += `<tr><td>${s.name}</td><td>${won(s.effBase)}</td><td>×${s.hol.toFixed(2)}</td><td style="text-align:left;white-space:normal">${txt}</td></tr>`;
  }
  $('coeffTable').innerHTML = ch + '</tbody></table>';
}
$('saveGradesBtn').onclick = async () => {
  const msg = $('gradeMsg'); msg.className = 'plan-msg'; msg.textContent = '저장 중…';
  const rows = GRADE_ORDER.map((g, i) => ({ grade: g, std_monthly_cost: gradeCost[g], sort: i }));
  const { error } = await sb.from('ot_grades').upsert(rows);
  if (error) { msg.className = 'plan-msg err'; msg.textContent = 'DB 저장 실패(' + error.message + ') — 이 세션에는 반영됨'; }
  else { msg.className = 'plan-msg ok'; msg.textContent = '저장됨'; }
};

// ---------- S2 계획: 입력 구성 ----------
const sel = $('store'), msel = $('month');
function buildPlanInputs() {
  sel.innerHTML = '';
  for (const [code, s] of Object.entries(OT_DATA)) {
    const o = document.createElement('option'); o.value = code; o.textContent = '로운 ' + s.name + '점'; sel.appendChild(o);
  }
  msel.innerHTML = '';
  for (let y = 2026, m = 9;;) {
    const v = `${y}-${String(m).padStart(2, '0')}`;
    const o = document.createElement('option'); o.value = v; o.textContent = `${y}년 ${m}월`; msel.appendChild(o);
    m++; if (m > 12) { m = 1; y++; } if (y === 2028) break;
  }
  sel.value = 'RU019'; msel.value = defaultYm();
  loadStaff('RU019');
  $('msales').value = OT_DATA.RU019.augM;
}
function defaultYm() { // 다음 달
  const d = new Date(); const y = d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear();
  const m = d.getMonth() === 11 ? 1 : d.getMonth() + 2;
  const v = `${y}-${String(m).padStart(2, '0')}`;
  return [...msel.options].some(o => o.value === v) ? v : msel.options[0].value;
}
function loadStaff(code) {
  staffCnt = { ...(OT_STAFF0[code] || {}) };
  const grid = $('staffGrid'); grid.innerHTML = '';
  for (const g of GRADE_ORDER) {
    const v = staffCnt[g] || 0;
    const d = document.createElement('div');
    d.className = 'sg' + (v ? ' nz' : '');
    d.innerHTML = `<div class="g">${g}</div><input type="number" min="0" max="9" step="1" value="${v}" data-g="${g}">`;
    d.querySelector('input').oninput = e => {
      staffCnt[g] = Math.max(0, Math.round(+e.target.value || 0));
      d.classList.toggle('nz', staffCnt[g] > 0);
      updateStaffSum(); render();
    };
    grid.appendChild(d);
  }
  updateStaffSum();
}
function staffTotals(code) {
  const nf = GRADE_ORDER.reduce((t, g) => t + (staffCnt[g] || 0), 0);
  const base = GRADE_ORDER.reduce((t, g) => t + (staffCnt[g] || 0) * gradeCost[g], 0);
  return { nf: Math.max(1, nf), fullpay: Math.max(0, base + (OT_DATA[code].payOff || 0)) };
}
function updateStaffSum() {
  const { nf, fullpay } = staffTotals(sel.value);
  $('staffSum').innerHTML = `합계 <b>${nf}명</b> · 정직원 월급여 <b>${won(fullpay)}원</b> (직급 단가 합 + 매장 보정, 8월 실제 급여 기준)`;
}
function onStoreChange() {
  $('msales').value = OT_DATA[sel.value].augM;
  loadStaff(sel.value); render();
}
sel.onchange = onStoreChange;
msel.onchange = () => render();
$('msales').oninput = () => render();

// ---------- 엔진 (프로토타입 v8 이관 — PRD §5) ----------
let selDay = "5", sfDay = "5", expDay = "5";

function attendance(s) {
  const slots = s.nfull * 5, w = s.wd, sum = w.reduce((a, b) => a + b, 0);
  const raw = w.map(x => x / sum * slots);
  const base = raw.map(x => Math.min(s.nfull, Math.max(1, Math.floor(x))));
  let rem = slots - base.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (rem <= 0) break; if (base[i] < s.nfull) { base[i]++; rem--; } }
  return base;
}
const fmtH = h => `${Math.floor(h)}:${h % 1 ? "30" : "00"}`;
function shiftsFor(s, d) {
  const src = (s.ft && s.ft.length) ? s.ft : [[10, 19]];
  const list = src.slice(0, d);
  while (list.length < d) list.push(src[list.length % src.length]);
  const g = {};
  for (const [a, b] of list) { const k = a + "-" + b; g[k] = g[k] || [a, b, 0]; g[k][2]++; }
  return Object.values(g).sort((x, y) => x[0] - y[0]).map(([a, b, c]) => [`${fmtH(a)}~${fmtH(b)}`, a, b, c]);
}
const coverAt = (sh, h) => sh.reduce((t, [, a, b, c]) => t + c * Math.max(0, Math.min(b, h + 1) - Math.max(a, h)), 0);

function partSplit(need, h) {
  const p = { 카운터: 0, 프리버싱: 0, 프랩: 0, 콜파트: 0, 핫파트: 0, 육절기: 0, DMO: 0 };
  let rem = need;
  const fixed = [];
  if (h >= 9 && h < 12) fixed.push("육절기");
  if (h >= 9 && h < 14) fixed.push("프랩");
  if (h >= 10) fixed.push("카운터");
  if (h >= 11 && h < 20) fixed.push("DMO");
  for (const f of fixed) { if (rem >= 1) { p[f] = 1; rem -= 1; } }
  if (rem > 0) {
    const fb = Math.round(rem * 0.4 * 2) / 2, cl = Math.round(rem * 0.3 * 2) / 2;
    p["프리버싱"] += fb; p["콜파트"] += cl; p["핫파트"] += rem - fb - cl;
  }
  return p;
}
function pctFor(s, dow) {
  if (dow == null || dow === "H" || !s.din || !s.dinBase) return s.pct;
  const tgt = s.din[+dow], base = s.dinBase;
  const fD = tgt / base, fL = (1 - tgt) / (1 - base);
  const p = s.pct.map((v, i) => v * (i >= 7 ? fD : fL));
  const t = p.reduce((a, b) => a + b, 0) || 1;
  return p.map(v => v / t);
}
function dayCalc(s, A, shifts, dow) {
  let totMH = 0, mateMH = 0, rows = [];
  const pct = pctFor(s, dow);
  const hrs = [["09:00", 9, null]].concat(HOURS.map((h, i) => [h, 10 + i, pct[i]]));
  for (const [label, h, p] of hrs) {
    const need = p === null ? PREP : Math.max(MINP, Math.round(A * p / TARGET * 2) / 2);
    const cov = Math.min(need, coverAt(shifts, h));
    const mate = need - cov;
    totMH += need; mateMH += mate;
    rows.push({ label, need, cov, mate, prep: p === null, p });
  }
  return { rows, totMH, mateMH };
}
function monthDates(ym, s) {
  const [y, m] = ym.split("-").map(Number);
  const n = new Date(y, m, 0).getDate(), out = [];
  for (let d = 1; d <= n; d++) {
    const dt = new Date(y, m - 1, d), wd = (dt.getDay() + 6) % 7;
    const iso = `${ym}-${String(d).padStart(2, "0")}`;
    let closed = OT_CLOSED_DATES.has(iso);
    if (!closed && s && s.closed && wd === s.closed.wd) {
      const nth = Math.ceil(d / 7), isLast = d + 7 > n;
      closed = s.closed.nth.includes(nth) || (s.closed.nth.includes(9) && isLast);
    }
    out.push({ d, wd, hol: OT_HOLIDAYS.has(iso) && wd < 5 && !closed, closed, iso });
  }
  return out;
}

let lastResult = null; // 계획 확정 저장용 최근 산출

function render() {
  if (!sel.value) return;
  const s0 = OT_DATA[sel.value], M = +$('msales').value || s0.augM, ym = msel.value;
  const { nf, fullpay } = staffTotals(sel.value);
  const s = { ...s0, nfull: nf };
  const att = attendance(s);
  const holAtt = Math.max(...att);
  const dates = monthDates(ym, s);
  const open = dates.filter(x => !x.closed);
  const wsum = open.reduce((t, x) => t + (x.hol ? s.hol : s.wd[x.wd]), 0);
  const dailyOf = idx => M * idx / wsum;

  let mMH = 0, mMHhol = 0;
  const cache = {};
  for (const x of open) {
    const key = x.hol ? "H" : x.wd;
    if (!(key in cache)) {
      const sh = shiftsFor(s, x.hol ? holAtt : att[x.wd]);
      cache[key] = dayCalc(s, dailyOf(x.hol ? s.hol : s.wd[x.wd]), sh, key).mateMH;
    }
    if (x.hol) mMHhol += cache[key]; else mMH += cache[key];
  }
  const totMateMH = mMH + mMHhol;
  const leaveMH = s.nfull * 8;
  const mateCost = (mMH + mMHhol * 1.5 + leaveMH) * s.effBase;
  const cost = mateCost + fullpay + s.nfull * 100000 + M / 1.1 * 0.006;
  const ratio = cost / (M / 1.1) * 100;
  $('ratio').textContent = ratio.toFixed(1) + "%";
  const t = $('ratioTile'); t.classList.remove("g", "w", "c");
  let note;
  if (ratio <= 24) { t.classList.add("g"); note = "목표권 (24% 이하)"; }
  else if (ratio <= 28) { t.classList.add("w"); note = "관리 필요 (24~28%)"; }
  else { t.classList.add("c"); note = "목표 초과 (28% 이상)"; }
  $('ratioNote').textContent = note;
  $('mateMH').textContent = won(totMateMH + s.nfull * 8);
  $('mateWon').textContent = "약 " + won(mateCost / 10000) + "만원";
  $('totCost').textContent = won(cost / 10000) + "만";

  lastResult = {
    store_code: sel.value, ym, forecast_sales: M,
    staffing: { ...staffCnt }, nfull: s.nfull, fullpay: Math.round(fullpay),
    ratio: +ratio.toFixed(2), mate_mh: Math.round(totMateMH + leaveMH),
    mate_cost: Math.round(mateCost), total_cost: Math.round(cost),
    daily_idx_sum: +wsum.toFixed(3)
  };
  $('planMsg').textContent = '';

  const hols = dates.filter(x => x.hol), closedD = dates.filter(x => x.closed);
  const hl = $('holLine');
  let hlHtml = "";
  if (hols.length) hlHtml += `<div class="holline">이달 공휴일 ${hols.length}일 — ${hols.map(x => x.d + "일(" + WD[x.wd] + ")").join(", ")} · 공휴일지수 ×${s.hol.toFixed(2)} 적용</div>`;
  if (closedD.length) hlHtml += `<div class="holline">휴점일 ${closedD.length}일 — ${closedD.map(x => x.d + "일(" + WD[x.wd] + ")").join(", ")} · 정기 휴점·명절 당일, 매출·인원 산정에서 제외</div>`;
  if (s.aug) hlHtml += `<div class="holline">8월 실측 — 총투입 ${won(s.aug.mh)}MH·생산성 ${won(s.aug.prod)}원/MH, 목표(72,000원/MH) 필요 ${won(s.aug.need)}MH 대비 <b>${s.aug.mh > s.aug.need ? "+" + won(s.aug.mh - s.aug.need) + "MH 과잉" : won(s.aug.need - s.aug.mh) + "MH 여유"}</b></div>`;
  hl.hidden = !hlHtml; hl.innerHTML = hlHtml;

  const box = $('days'); box.innerHTML = "";
  const types = WD.map((w, i) => ({ key: String(i), label: w, idx: s.wd[i], hd: false }));
  if (hols.length) types.push({ key: "H", label: "공휴일", idx: s.hol, hd: true });
  if (selDay === "H" && !hols.length) selDay = "5";
  for (const ty of types) {
    const b = document.createElement("button");
    b.setAttribute("role", "tab");
    if (String(selDay) === ty.key) b.classList.add("on");
    if (ty.hd) b.classList.add("hd");
    b.innerHTML = `<span class="d">${ty.label}</span><span class="m">${won(dailyOf(ty.idx) / 10000)}만</span>`;
    b.onclick = () => { selDay = ty.key; render(); };
    box.appendChild(b);
  }

  const cur = types.find(ty => String(selDay) === ty.key) || types[5];
  const A = dailyOf(cur.idx);
  const curAtt = cur.key === "H" ? holAtt : att[+cur.key];
  const shifts = shiftsFor(s, curAtt);
  const dc = dayCalc(s, A, shifts, cur.key);
  $('daysum').innerHTML = `<b>${cur.label === "공휴일" ? "공휴일" : cur.label + "요일"}</b> · 예상 일매출 <b>${won(A / 10000)}만원</b> · 총 ${dc.totMH.toFixed(1)}인시 (메이트 ${dc.mateMH.toFixed(1)}인시)`;
  const maxNeed = Math.max(...dc.rows.map(r => r.need));
  const peakP = Math.max(...pctFor(s, cur.key));
  const tb = $('rows'); tb.innerHTML = "";
  for (const r of dc.rows) {
    const tr = document.createElement("tr");
    if (r.p === peakP) tr.className = "peak";
    tr.innerHTML = `<td class="hour">${r.label}${r.prep ? " 준비" : ""}</td>` +
      `<td>${r.need.toFixed(1)}</td><td>${r.cov.toFixed(1)}</td><td class="mate">${r.mate.toFixed(1)}</td>` +
      `<td class="barcell"><div class="bar"><span class="f" style="width:${r.cov / maxNeed * 100}%"></span><span class="m" style="width:${r.mate / maxNeed * 100}%"></span></div></td>`;
    tb.appendChild(tr);
  }
  const attTxt = WD.map((w, i) => `${w}${att[i]}`).join(" ");
  $('shiftNote').textContent = `정직원 ${s.nfull}명 중 이날 출근 ${curAtt}명 — ${shifts.map(x => `${x[0]} ×${x[3]}`).join(" · ")} (8월 실제 출퇴근대) · 주5일 기준 요일별 출근 [${attTxt}]`;

  renderDetail(s, types, att, holAtt, dailyOf, fullpay);
  renderShiftTab(s, types, att, holAtt, dailyOf, fullpay);
}

// ----- 시프트 자동 생성 -----
function smoothCurve(a) {
  const n = a.length, out = a.slice();
  for (let i = 0; i < n; i++) {
    let s = a[i] * 0.5, w = 0.5;
    if (i > 0) { s += a[i - 1] * 0.25; w += 0.25; }
    if (i < n - 1) { s += a[i + 1] * 0.25; w += 0.25; }
    out[i] = s / w;
  }
  const f = a.reduce((x, y) => x + y, 0) / (out.reduce((x, y) => x + y, 0) || 1);
  return out.map(v => v * f);
}
function mateCurve(dc) {
  const sm = smoothCurve(smoothCurve(dc.rows.map(r => r.need)));
  return sm.map((v, i) => Math.max(0, Math.round((v - dc.rows[i].cov) * 2) / 2));
}
function genShifts(mateNeed) {
  const rem = mateNeed.slice(), out = [];
  const types = [{ w: 8, slots: 9, maxS0: 4 }, { w: 7, slots: 8, maxS0: 5 }, { w: 6, slots: 6, maxS0: 7 }, { w: 5, slots: 5, maxS0: 8 }, { w: 4, slots: 4, maxS0: 9 }];
  let guard = 0;
  const tot = () => rem.reduce((a, b) => a + Math.max(0, b), 0);
  while (tot() > 1.5 && Math.max(...rem) > 0.5 && guard++ < 60) {
    let best = null;
    for (const t of types) {
      for (let s0 = 0; s0 <= t.maxS0; s0++) {
        let bi = -1;
        if (t.w >= 7) { bi = s0 + 1; for (let i = s0 + 1; i < s0 + t.slots - 1; i++) if (rem[i] < rem[bi]) bi = i; }
        let cov = 0, waste = 0;
        for (let i = s0; i < s0 + t.slots; i++) {
          if (i === bi) continue;
          const c = Math.min(1, Math.max(0, rem[i])); cov += c; waste += 1 - c;
        }
        const score = (cov - 0.45 * waste) / t.w;
        if (cov >= 1.5 && (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && t.w > best.t.w))) best = { t, s0, bi, score };
      }
    }
    if (!best) break;
    out.push({ w: best.t.w, slots: best.t.slots, s0: best.s0, bi: best.bi });
    for (let i = best.s0; i < best.s0 + best.t.slots; i++) if (i !== best.bi) rem[i] -= 1;
  }
  return out;
}
function shiftLabel(sh) {
  const st = 9 + sh.s0;
  if (sh.w === 8) return `${st}:00~${st + 9}:00 (8h+휴게1h)`;
  if (sh.w === 7) return `${st}:00~${st + 8}:00 (7h+휴게1h)`;
  if (sh.w === 6) return `${st}:00~${st + 6}:30 (6h+휴게30분)`;
  if (sh.w === 5) return `${st}:00~${st + 5}:30 (5h+휴게30분)`;
  return `${st}:00~${st + 4}:00 (4h)`;
}
function renderShiftTab(s, types, att, holAtt, dailyOf, fullpay) {
  if (!types.some(t => t.key === sfDay)) sfDay = "5";
  const box = $('sfDays'); box.innerHTML = "";
  for (const ty of types) {
    const b = document.createElement("button");
    b.textContent = ty.label;
    if (ty.key === sfDay) b.classList.add("on");
    b.onclick = () => { sfDay = ty.key; render(); };
    box.appendChild(b);
  }
  const cur = types.find(t => t.key === sfDay) || types[5];
  const cnt = cur.key === "H" ? holAtt : att[+cur.key];
  const sh = shiftsFor(s, cnt), A = dailyOf(cur.idx);
  const dc = dayCalc(s, A, sh, cur.key);
  const ms = genShifts(mateCurve(dc));
  const grp = {};
  for (const m of ms) { const k = m.w + "-" + m.s0; (grp[k] = grp[k] || { ...m, n: 0 }).n++; }
  const rows = [];
  for (const [nm, a, b, c] of sh) rows.push({ lab: `정직원 ${nm} ×${c}`, cls: "f", s0: Math.round(a - 9), slots: Math.round(b - a), bi: -1 });
  for (const g of Object.values(grp).sort((x, y) => y.w - x.w || x.s0 - y.s0))
    rows.push({ lab: `메이트 ${g.w}h ×${g.n} · ${shiftLabel(g)}`, cls: "m" + g.w, s0: g.s0, slots: g.slots, bi: g.bi });
  let html = '<div class="gantt"><div class="ghead"></div>' +
    [...Array(13)].map((_, i) => `<div class="ghead">${9 + i}</div>`).join("");
  for (const r of rows) {
    html += `<div class="glab">${r.lab}</div>`;
    for (let i = 0; i < 13; i++) {
      const inSpan = i >= r.s0 && i < r.s0 + r.slots;
      let cls = "gc";
      if (inSpan) cls += i === r.bi ? " brk" : " " + r.cls;
      if (i === r.s0) cls += " st";
      if (i === r.s0 + r.slots - 1) cls += " en";
      html += `<div class="${cls}"></div>`;
    }
  }
  html += "</div>";
  $('ganttBox').innerHTML = html;
  const buildH = ms.reduce((t, m) => t + m.w, 0);
  const needH = dc.mateMH;
  const mult = cur.key === "H" ? 1.5 : 1;
  const mateWonD = buildH * s.effBase * mult;
  const costD = mateWonD + fullpay / 30.4 + s.nfull * 100000 / 30.4 + A / 1.1 * 0.006;
  $('sfSum').innerHTML =
    `<span>${cur.label === "공휴일" ? "공휴일" : cur.label + "요일"} 일매출 <b>${won(A / 10000)}만</b></span>` +
    `<span>필요 <b>${needH.toFixed(1)}h</b> → 시프트 구성 <b>${buildH}h</b> (과잉 ${Math.max(0, buildH - needH).toFixed(1)}h)</span>` +
    `<span>메이트 인건비 <b>${won(mateWonD)}원</b>${mult > 1 ? " (공휴일 ×1.5)" : ""}</span>` +
    `<span>이날 예상 인건비율 <b>${(costD / (A / 1.1) * 100).toFixed(1)}%</b></span>`;
  const cnts = { 8: 0, 7: 0, 6: 0, 5: 0, 4: 0 };
  for (let w = 0; w < 7; w++) {
    const shw = shiftsFor(s, att[w]);
    const d2 = dayCalc(s, dailyOf(s.wd[w]), shw, String(w));
    for (const m of genShifts(mateCurve(d2))) cnts[m.w]++;
  }
  const wh = [8, 7, 6, 5, 4].reduce((t, w) => t + cnts[w] * w, 0);
  const nLong = Math.max(0, Math.round((cnts[8] + cnts[7]) / 5));
  const nMid = (cnts[6] + cnts[5]) ? Math.max(1, Math.round((cnts[6] + cnts[5]) / 5)) : 0;
  const ultraCap = 0.3;
  const ultra4 = Math.round(cnts[4] * ultraCap), reg4 = cnts[4] - ultra4;
  const n4 = Math.ceil(reg4 / 5), nU = Math.ceil(ultra4 / 3);
  const save = Math.round(ultra4 * 4 * 0.2 * 10500 * 52 / 12 / 10000);
  const mixTxt = [8, 7, 6, 5, 4].filter(w => cnts[w]).map(w => `<b>${w}h ×${cnts[w]}</b>`).join(" · ");
  const am = s.augMix;
  $('mixBox').innerHTML =
    `주간 메이트 시프트: ${mixTxt} (주 ${wh}h)<br>` +
    `권장 계약 구성: <b>8h/7h 주5일 ${nLong}명</b>${nMid ? ` + <b>6h/5h 주5일 ${nMid}명</b>` : ""}${n4 ? ` + <b>4h 주5일 ${n4}명</b> (주20h, 주휴 발생)` : ""} + <b>4h 주3일 ${nU}명</b> (주12h 초단시간, 주휴 미발생)<br>` +
    `초단시간 배치(30% 기준)로 절감되는 주휴수당: <b>월 약 ${won(save)}만원</b>` +
    (am ? `<br>8월 실측: 메이트 <b>${am.n}명</b> 운용, 주15h미만 <b>${am.u}명(${am.p}%)</b> — 위 권장안과 비교해 보세요` : "");
}

function renderDetail(s, types, att, holAtt, dailyOf, fullpay) {
  if (!types.some(t => t.key === expDay)) expDay = "5";
  const hrs = [["09", 9]].concat(HOURS.map((h, i) => [h.slice(0, 2), 10 + i]));
  const days = types.map(ty => {
    const cnt = ty.key === "H" ? holAtt : att[+ty.key];
    const sh = shiftsFor(s, cnt);
    const A = dailyOf(ty.idx);
    const dc = dayCalc(s, A, sh, ty.key);
    return { ...ty, cnt, sh, A, dc };
  });
  const maxNeed = Math.max(...days.flatMap(d => d.dc.rows.map(r => r.need)));
  const heat = v => v <= 0 ? "" : `background:color-mix(in srgb,var(--heat) ${Math.min(70, Math.round(v / maxNeed * 70))}%,transparent)`;
  const heatP = v => v <= 0 ? "" : `background:color-mix(in srgb,var(--heat) ${Math.min(75, Math.round(10 + v * 17))}%,transparent)`;
  const SHORT = { 카운터: "카운", 프리버싱: "프리", 프랩: "프랩", 콜파트: "콜", 핫파트: "핫", 육절기: "육절", DMO: "DMO" };
  let h1 = '<tr><th rowspan="2">시간</th>', h2 = '<tr>';
  for (const d of days) {
    const exp = d.key === expDay;
    if (exp) {
      h1 += `<th class="day exp" colspan="${PARTS.length}" data-k="${d.key}">${d.label} ▾ · ${won(d.A / 10000)}만</th>`;
      h2 += PARTS.map(p => `<th>${SHORT[p]}</th>`).join("");
    } else {
      h1 += `<th class="day" rowspan="2" data-k="${d.key}">${d.label}<br><span style="font-weight:500">${won(d.A / 10000)}만</span></th>`;
    }
  }
  h1 += "</tr>"; h2 += "</tr>";
  let body = "";
  hrs.forEach(([lab, h], ri) => {
    let row = `<tr><td class="hr">${lab}시</td>`;
    for (const d of days) {
      const need = d.dc.rows[ri].need;
      if (d.key === expDay) {
        const ps = partSplit(need, h);
        row += PARTS.map(p => {
          const v = ps[p];
          return `<td class="${v ? "" : "z"}" style="${heatP(v)}">${v ? (v % 1 ? v.toFixed(1) : v) : "·"}</td>`;
        }).join("");
      } else {
        row += `<td style="${heat(need)}">${need % 1 ? need.toFixed(1) : need}</td>`;
      }
    }
    body += row + "</tr>";
  });
  $('dtable').innerHTML = `<table class="dtable"><thead>${h1}${h2}</thead><tbody>${body}</tbody></table>`;
  $('dtable').querySelectorAll("th.day").forEach(th => {
    th.onclick = () => { expDay = th.dataset.k; render(); };
  });
  const d = days.find(x => x.key === expDay) || days[5];
  const fullH = d.sh.reduce((t, [, a, b, c]) => t + (b - a) * c, 0);
  const mateWonD = d.dc.mateMH * s.effBase * (d.key === "H" ? 1.5 : 1);
  const costD = mateWonD + fullpay / 30.4 + s.nfull * 100000 / 30.4 + d.A / 1.1 * 0.006;
  $('dsum').innerHTML =
    `<span>${d.label === "공휴일" ? "공휴일" : d.label + "요일"} 일매출 <b>${won(d.A / 10000)}만</b></span>` +
    `<span>정직원 <b>${d.cnt}명 · ${fullH}h</b></span>` +
    `<span>메이트 <b>${d.dc.mateMH.toFixed(1)}h</b></span>` +
    `<span>메이트 인건비 <b>${won(mateWonD)}원</b></span>` +
    `<span>이날 예상 인건비율 <b>${(costD / (d.A / 1.1) * 100).toFixed(1)}%</b></span>`;
}

// ----- 개괄/상세/시프트판 탭 -----
function showPlanTab(t) {
  for (const [id, wrap] of [["tabOv", "ovWrap"], ["tabDt", "dtWrap"], ["tabSf", "sfWrap"]]) {
    $(id).classList.toggle("on", id === t); $(wrap).hidden = (id !== t);
  }
}
$('tabOv').onclick = () => showPlanTab("tabOv");
$('tabDt').onclick = () => showPlanTab("tabDt");
$('tabSf').onclick = () => showPlanTab("tabSf");

// ---------- 월 계획 확정 저장 (plan_runs) ----------
$('savePlanBtn').onclick = async () => {
  if (!lastResult) return;
  const msg = $('planMsg'); msg.className = 'plan-msg'; msg.textContent = '저장 중…';
  const r = lastResult;
  const row = {
    store_code: r.store_code, ym: r.ym, forecast_sales: r.forecast_sales,
    staffing_snapshot: { staffing: r.staffing, nfull: r.nfull, fullpay: r.fullpay, grade_cost: gradeCost },
    standard_plan_id: null, // 임시 기준(엔진) — 표준 계획표 등록 후 연결
    coeff_ym: '2026-08', engine_version: ENGINE_VERSION,
    output: { ratio: r.ratio, mate_mh: r.mate_mh, mate_cost: r.mate_cost, total_cost: r.total_cost },
    status: 'confirmed', created_by: currentUser ? currentUser.id : null
  };
  const { error } = await sb.from('ot_plan_runs').upsert(row, { onConflict: 'store_code,ym' });
  if (error) { msg.className = 'plan-msg err'; msg.textContent = '저장 실패: ' + error.message; }
  else { msg.className = 'plan-msg ok'; msg.textContent = `${OT_DATA[r.store_code].name} ${r.ym} 계획 확정 저장됨 (인건비율 ${r.ratio}%)`; }
};

init();
