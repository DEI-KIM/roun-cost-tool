---
name: deploy-and-verify
description: roun-cost-tool(정적 GitHub Pages 사이트, 빌드 없음)에서 app.js/style.css를 고치고 실제 배포된 사이트에서 검증할 때 반드시 따라야 하는 워크플로우. 캐시버스터 버전 올리기, GitHub Pages 전파 대기, 그리고 이 저장소에서 세션 내내 시간을 가장 많이 잡아먹었던 "테스트가 오래된/엉뚱한 캐시를 읽는 문제"를 다룬다. 이 저장소에서 app.js나 style.css를 수정하거나, 배포 후 authenticated Chrome 탭으로 동작을 확인하거나, "느리다/이상하게 나온다"는 증상을 디버깅할 때는 매번 이 스킬을 먼저 참고할 것 — 안 그러면 지난 세션처럼 몇 시간을 같은 함정에 다시 빠지게 된다.
---

# roun-cost-tool 배포·검증 워크플로우

이 문서는 2026-08-12 세션에서 15번 넘는 배포-확인 사이클을 거치며 반복적으로 부딪힌 문제들을 정리한 것이다. 대부분은 "버그"가 아니라 **캐시가 아직 안 바뀌었는데 확인했거나, 이전 테스트의 비동기 작업이 아직 끝나기 전에 다음 걸 건드려서** 생긴 착시였다. 이 순서를 따르면 그 함정을 대부분 피할 수 있다.

## 이 앱의 구조 (모르면 헷갈리는 것들)

- **빌드 과정이 없다.** `app.js`/`style.css`/`index.html`을 직접 고치고 git push하면 그게 곧 배포다. 로컬 dev 서버도 없다 — 검증은 항상 실제 배포된 사이트(`https://dei-kim.github.io/roun-cost-tool/`)에서 한다.
- **RLS 때문에 anon key로는 아무것도 못 한다.** 모든 읽기/쓰기 확인은 이미 로그인되어 있는 authenticated Chrome 탭(`mcp__claude-in-chrome__*`)에서 `javascript_tool`로 페이지의 `sb` 클라이언트를 직접 써야 한다. raw fetch나 별도 API 키로 우회하려 하지 말 것.

## 1. 배포 시퀀스

1. `app.js`/`style.css` 수정
2. **고친 파일에 대응하는 캐시버스터를 반드시 올린다.** `index.html`에 독립적인 버전 태그가 두 개 있다 — `app.js?v=YYYYMMDDHHmm`, `style.css?v=YYYYMMDDHHmm`. 건드린 파일의 태그만 올리면 되고(둘 다 건드렸으면 둘 다), 항상 지금 시각 기준으로 더 큰 숫자로. 이걸 깜빡하면 코드는 고쳤는데 브라우저/CDN이 계속 옛날 버전을 서빙해서, 그 뒤에 하는 모든 테스트가 고치기 전 동작을 보게 된다 — 이번 세션에서 가장 자주 발생한 삽질 원인이다.
3. `git add` (수정한 파일 + index.html), 커밋 메시지는 **무엇을 고쳤는지보다 왜 고쳤는지**를 한국어로 명확히, `git push`
4. GitHub Pages 전파는 즉시가 아니라 보통 10~30초 걸린다. 아래 "전파 확인" 루프 없이 바로 테스트로 넘어가지 말 것.

## 2. 전파 확인 루프 (매번 이대로)

```
매번 새로운 ?cb=<임의값>을 붙여서 navigate
→ document.querySelector('script[src*="app.js"]').src 확인
→ 방금 올린 버전 번호와 다르면: 10초 대기 → 다시 새 ?cb=로 navigate → 재확인
→ 버전이 일치할 때까지 반복 (보통 1~3번이면 됨)
```

버전 문자열이 맞다는 걸 직접 확인하기 전까지는 절대 동작 테스트로 넘어가지 않는다. 한 번 navigate하고 바로 믿지 말 것.

## 3. 이 세션에서 가장 많은 시간을 잡아먹은 함정: 비동기 순서 경쟁

"피벗 탭이 0개점으로 뜬다", "대시보드가 비어있다" 같은 증상을 몇 시간 쫓았는데, 거의 다 진짜 버그가 아니라 **내가 테스트하면서 만든 경쟁 상태**였다.

**왜 이게 생기나:** `<select>` 값을 바꾸고 `dispatchEvent(new Event('change'))`로 트리거하면 비동기 로드 체인이 시작된다. 이게 아직 안 끝났는데 또 다른 컨트롤을 바꾸거나 탭을 클릭하면, 두 개의 로드가 동시에 돌다가 **먼저 시작한(옛날/기본값) 로드가 나중에 끝나면서 캐시를 도로 옛날 값으로 덮어써버린다.** 캐시 자체는 에러도 없고 null도 아니라서 겉보기엔 멀쩡해 보이는데, 내용물이 방금 요청한 게 아니라 그 전 요청 결과다.

**막는 법:**
- 테스트에 필요한 컨트롤 값들을 **각각 dispatchEvent로 따로따로 바꾸지 말고**, 가능하면 한 번에 세팅한 뒤 트리거를 한 번만 건다.
- 컨트롤을 바꿨으면, 결과 캐시의 `.stores.length` 같은 파생 값을 보기 전에 **먼저 캐시 자신의 식별 필드(예: `.dateRange`, `.seasonId`)가 방금 요청한 값과 일치하는지부터 확인**한다. 일치 안 하면 아직 이전 요청의 결과를 보고 있는 것 — 더 기다리거나 다시 트리거하지 말고 그냥 기다린다.
- 뭔가 안 될 때 반사적으로 재시도하지 말 것 — 재시도가 바로 이 경쟁 상태를 만드는 원인이다. 의심되면 그냥 10초 이상 더 기다렸다가 딱 한 번만 다시 확인한다.

## 4. 이 앱은 원래 좀 느리다 — 조급해하지 말 것

시즌 전환(`loadAllForCurrentSeason` → `loadDashboard` → ...) 같은 무거운 로드는 정상적으로 돌아도 **15~30초 이상** 걸릴 수 있다. `material_usage`가 27만 행 넘고, 매장별 IPF 계산도 실제로 무겁다. 5~10초 기다리고 "안 된다"고 판단하지 말고, 10초 단위로 2~3번은 폴링해본다.

## 5. `fetchAllRows` 페이지네이션 — 손대지 말 것 (건드려서 3번 삽질함)

`app.js`의 `fetchAllRows`는 지금 **순차 페이지네이션**(한 번에 한 페이지씩)으로 되어 있다. 이번 세션에 "느리니까 병렬로 바꾸자"를 세 번 시도했다가 세 번 다 다른 이유로 더 나쁜 상황을 만들어서 결국 순차 방식으로 되돌렸다:
- `{count:'exact'}`를 붙이면 큰/필터링된 테이블에서 Postgres가 statement timeout을 낸다 — 절대 쓰지 말 것.
- 페이지를 병렬로 쏘는 건 **그 함수 호출 하나만** 큰 테이블을 훑을 때는 도움되지만, 앱 안에 `Promise.all`로 `fetchAllRows`를 여러 개 동시에 부르는 곳(피벗 탭 등)이 이미 있어서, 거기에 병렬화까지 더하면 요청이 수십 개씩 한꺼번에 몰려 오히려 응답이 지연되거나 빈 결과처럼 보인다.

정말 특정 호출 하나가 느려서 못 참겠으면, `fetchAllRows` 자체를 고치지 말고 **그 호출 하나만 좁혀서** 최적화한다(아래 6번처럼 쿼리를 줄이거나 서버 집계로 바꾸는 식).

## 6. "왜 이렇게 느리지?" 싶으면 가장 먼저 확인할 것

`read_network_requests`로 offset이 수만~수십만까지 올라가는 요청이 있는지 본다. 있으면 그건 **테이블 전체를 필터 없이 훑고 있다는 신호**다. 이번 세션에 이 패턴을 두 개 찾아 고쳤다:
- `loadMarketView()` (market_prices, 30만 행+) — 어느 탭에 있든 부팅할 때마다 무조건 불러오고 있었음 → "시장 데이터" 탭을 실제로 열 때만 불러오도록 지연 로드로 수정 (`marketViewLoaded` 플래그).
- `loadCostTrend()` (material_usage, 27만 행+, 필터 없음) — 월별 합계 몇 개 뽑으려고 전체를 다 받아와 브라우저에서 합산하고 있었음 → Postgres RPC 함수(`material_usage_monthly_totals()`)로 DB가 직접 SUM/GROUP BY 하도록 교체.

**교훈:** "표 전체를 다 받아서 클라이언트에서 계산"하는 패턴을 보면 의심부터 한다. 고치는 방법은 병렬화가 아니라 (a) 지연 로딩(그 탭/기능을 실제로 쓸 때만 로드) 또는 (b) 서버 쪽 집계(RPC/view)다.

## 7. DB 스키마·함수를 바꿔야 할 때

Supabase RLS 때문에 Claude가 직접 DDL을 실행할 수 없다. 이번 세션에 성공적으로 쓴 패턴:

1. 정확한 SQL을 작성해서(`CREATE TABLE` / `CREATE FUNCTION` / `GRANT`) 사용자에게 Supabase SQL Editor에서 실행해달라고 요청
2. 실행했다는 확인을 받으면, authenticated 탭에서 직접 검증한다 (`sb.from('table').select('*').limit(1)` 또는 `sb.rpc('fn_name')`으로 실제로 되는지)
3. **재실행 가능하게(idempotent) 짤 것.** `create table`이 포함된 스크립트를 한 번 실행해서 "already exists" 에러가 나면, 그 아래 있던 `grant`문까지 같이 안 돌아간다 — 사용자가 실수로 전체를 다시 붙여넣고 실행할 수 있으니 `create table if not exists`, `drop policy if exists ... ; create policy ...` 형태로 몇 번을 다시 돌려도 안전하게 짠다.
4. **GRANT를 빠뜨리지 말 것.** SQL Editor로 직접 만든 테이블은 Supabase Table Editor UI가 자동으로 붙여주는 `grant select, insert, update, delete on X to authenticated`가 안 붙는다. RLS 정책이 멀쩡해 보이는데도 "permission denied for table X" 에러가 나면 이게 원인이다.

## 8. 디버깅 도구 팁

- `read_network_requests`는 같은 탭에서 페이지를 넘나들어도 깔끔하게 초기화되지 않는 것 같다 — 목록에 있는 요청이 지금 로드가 아니라 이전 테스트에서 남은 것일 수 있다. 현재 실행 중인 스크립트 버전이나 타이밍과 대조해서 신선도를 판단할 것.
- `computer{action:"screenshot"}`이 이번 세션 내내 CDP 타임아웃으로 자주 실패했다. 화면 확인이 필요하면 스크린샷보다 `javascript_tool`로 DOM/computed style을 직접 찍어보는 게(요소 너비, textContent, getBoundingClientRect 등) 훨씬 안정적이다.
