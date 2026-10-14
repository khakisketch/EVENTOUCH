# OD 비주얼 인계 — 제품 구현 기록 (2026-10-03)

## Target
- 제품: `/home/ksi/Desktop/SI-Projects/EVENTOUCH` (master)
- 진입: `index.html` → `styles/tokens.css` → `styles/theme.css` → `features/*.js` 렌더러
- 브랜드: `styles/tokens.css` (brand #F35B2C / action #BC3F1B / canvas #FAF8F5 유지)

## Source artifact
- OD project: `eventouch-a82e` (EVENTOUCH)
- Entry: `eventouch-operations.html`, 208911 bytes
- SHA256: `ed870f5227d3505a49e77e2300769047f8909a5f015f7a00bf49c902b8de767e`
- Run: `9443ee43-a586-4fd9-9876-daeeaaebb10e` (succeeded, refined in place; 원본은 `eventouch-operations-v2.html`로 보존됨)
- 내려받은 번들: `/tmp/opencode/od/eventouch-operations.html` (md5 동일 확인)

## Ported (테마 레이어 이식, 제품 셸 구조 유지)
- 토큰: `--surface-soft`, `--radius`, `--shadow`, `--focus`, `--focus-ring: 3px`
- 본문 14px/1.55, tracking -0.01em, antialiased
- 버튼: hover/active/focus-visible(3px+soft shadow), radius 9px, Primary hover #ed4f23
- 카드: radius token + shadow; overview 결과는 stat 밴드(`.stats/.stat/.stat-value`, tabular-nums)
- 표: 라이트 헤더 + 행 hover + 코드류 mono/tabular
- 폼: 라벨 12px/650 fg, 필드 radius 9px, placeholder 색
- 빈 상태: dashed 폐기 → soft 패널(`--surface-soft`)
- 피드백 3종 leading 1.5, 관객 화면 serif clamp + 토큰 poll-bar 유지
- reduced-motion, 600px inline-form grid (390px 기존 규칙과 병존)

## States / responsive rules
- 10 views × 1280/390: page overflow 0, 미달 컨트롤 0 (무대 체크박스는 라벨이 타깃, 명단 표는 래퍼 내부 스크롤 — 설계대로)
- 16px 입력 폰트 유지(iOS 줌 방지 — 시안 13px 미적용, 의도적 차이)

## Unresolved / differences (시안과 의도적으로 다름)
- 제품 셸 유지: 상단 pill 내비(시안 사이드바 미적용 — 흐름·테스트 보존)
- h2 브랜드 밑줄 제거 → 시안식 섹션 헤드로 (타이포·간격)
- thead 다크 → 라이트 (시안 원장)
- `renderResults`만 마크업 변경(`.stats`), 나머지 렌더러 마크업 동일

## Verification
- `node --test tests/*.test.cjs`: 329 pass, 0 fail
- Screenshots: `/tmp/opencode/visual/{1280,390}/` 20장 reviewed
- Product: http://100.116.163.1:8000/index.html (worktree 직서빙, hard refresh)
