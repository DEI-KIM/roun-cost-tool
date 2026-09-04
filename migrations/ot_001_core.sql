-- 로운 OT M1 — 1단계: 앱이 지금 사용하는 핵심 4개 테이블 + RLS
-- (실적·표준계획표 테이블은 M2 착수 시 2단계 마이그레이션으로 분리)

-- 매장 마스터
create table if not exists ot_stores (
  code text primary key,
  name text not null,
  closed_rule jsonb,          -- 예: {"wd":0,"nth":[2]} = 2째주 월요일
  active boolean not null default true
);

-- 사용자 프로필 (auth.users 연동, role: planner | manager)
create table if not exists ot_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'planner' check (role in ('planner','manager')),
  store_code text references ot_stores(code),
  display_name text
);

-- 직급 표준 인건비
create table if not exists ot_grades (
  grade text primary key,
  std_monthly_cost integer not null,
  sort integer not null default 0
);

-- 월 계획 확정 스냅샷 (S2 [월 계획 확정] 저장 대상)
create table if not exists ot_plan_runs (
  id uuid primary key default gen_random_uuid(),
  store_code text not null references ot_stores(code),
  ym text not null,                       -- 'YYYY-MM'
  forecast_sales bigint not null,
  staffing_snapshot jsonb not null,       -- {staffing, nfull, fullpay, grade_cost}
  standard_plan_id uuid,                  -- 표준 계획표 연결(F4, M2) — 지금은 null = 임시 기준
  coeff_ym text not null,
  engine_version text not null,
  output jsonb not null,                  -- {ratio, mate_mh, mate_cost, total_cost}
  status text not null default 'confirmed' check (status in ('draft','confirmed')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (store_code, ym)                 -- 매장×월 1건, upsert 대상
);

-- ---------- RLS ----------
alter table ot_stores enable row level security;
alter table ot_profiles enable row level security;
alter table ot_grades enable row level security;
alter table ot_plan_runs enable row level security;

-- planner 판별 헬퍼
create or replace function ot_is_planner() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from ot_profiles p where p.user_id = auth.uid() and p.role = 'planner') $$;

-- 조회: 로그인 사용자 전체 허용 (manager 매장 제한은 M2 실적 테이블부터 적용)
create policy ot_stores_read on ot_stores for select to authenticated using (true);
create policy ot_grades_read on ot_grades for select to authenticated using (true);
create policy ot_plan_runs_read on ot_plan_runs for select to authenticated using (true);
create policy ot_profiles_read_own on ot_profiles for select to authenticated using (user_id = auth.uid());

-- 쓰기: planner만
create policy ot_grades_write on ot_grades for all to authenticated
  using (ot_is_planner()) with check (ot_is_planner());
create policy ot_plan_runs_write on ot_plan_runs for all to authenticated
  using (ot_is_planner()) with check (ot_is_planner());
create policy ot_stores_write on ot_stores for all to authenticated
  using (ot_is_planner()) with check (ot_is_planner());
