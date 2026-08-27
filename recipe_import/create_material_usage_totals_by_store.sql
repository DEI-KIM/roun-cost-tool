-- 매장별 원가 계산을 위한 RPC: 기존 material_usage_totals_for_range와 동일한 집계 로직에
-- store_code/store_name 그룹을 추가한 버전. 원본 자재사용량 행(수만~수십만 개)을 브라우저로
-- 끌고 오지 않고, 자재x매장 조합(수백~수천 개)만 서버에서 미리 합산해서 가볍게 반환한다.
-- Supabase SQL Editor에서 실행. 재실행해도 안전(CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION material_usage_totals_for_range_by_store(p_start date, p_end date)
RETURNS TABLE (
  store_code text,
  store_name text,
  material_code text,
  total_grams numeric,
  total_amount numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    store_code,
    max(store_name) AS store_name,
    material_code,
    sum(coalesce(actual_usage_qty, 0) * coalesce(conversion_factor, 0)) AS total_grams,
    sum(coalesce(actual_usage_amount, 0)) AS total_amount
  FROM material_usage
  WHERE period_end >= p_start
    AND period_end < p_end
    AND material_code IS NOT NULL
    AND store_code IS NOT NULL
  GROUP BY store_code, material_code
$$;

GRANT EXECUTE ON FUNCTION material_usage_totals_for_range_by_store(date, date) TO authenticated;
