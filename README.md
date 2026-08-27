# voc

다점포 외식 브랜드의 **고객의 소리(VOC)** 와 **경쟁사 활동**을 하나의 회의 자료로 묶는 Claude Code 스킬 3종.

흩어진 리뷰를 모아 하루 한 장으로 만들고, 경쟁 브랜드가 지금 무엇을 하고 있는지를 매주 같은 자로 잰다.
공통 원칙은 하나다. **재지 못한 것을 잰 척하지 않는다.**

https://chansoul-drunken.github.io/voc/skills/voc-daily-snapshot/assets/dashboard.html

---

## 어떤 업무를 대신하나

| 스킬 | 대신하는 일 | 걸리던 시간 |
|---|---|---|
| **voc-daily-snapshot** | 배달앱·QR설문·점주VOC·발주고·소셜 5개 채널의 리뷰를 시트 한 곳에 모으고 일일 회의용 대시보드로 렌더링 | 매일 아침 수작업 취합 |
| **watchtower** | 경쟁 브랜드 20여 곳의 노출 활동량·악재·바이럴을 매일 훑고 주 1회 순위로 정리 | 주간 경쟁사 리서치 |
| **brand-metrics** | 브랜드별 검색지수·발행량·리뷰수를 ISO 주차로 쌓아 시계열 CSV 생성 | 월간 지표 수기 집계 |

세 스킬은 독립적으로 쓸 수 있고, 같이 쓰면 대시보드 하단에 경쟁사 랭킹이 붙는다.

---

## 무엇이 다른가

**1. 원문을 요약하지 않는다.**
VOC 목록에는 60자 스니펫만 보이고, 클릭하면 `raw_text` 전문이 그대로 뜬다.
요약은 뉘앙스를 죽인다. "면이 좀 불었어요"와 "면이 완전히 퍼져서 못 먹었어요"는 요약하면 같은 문장이 된다.

**2. 못 잰 것을 0으로 적지 않는다.**
브랜드명이 일반명사와 겹쳐 분리가 안 되면 `측정 불가`로 남긴다.
`1등아구찜`은 "1등 맛집"과 구분되지 않아 영구 측정 불가다. 0건으로 적으면 "활동이 없다"는 거짓말이 된다.

**3. 평균의 평균을 내지 않는다.**
집계 시트에 `rating_sum`과 `rated`를 따로 쌓고 나눈다.
일자별 평균을 다시 평균내면 2,000건인 날과 3건인 날이 같은 무게를 갖는다.

**4. 집계는 덮어쓰지 않고 누적한다.**
원문이 이미 아카이브된 날짜에 리뷰가 늦게 도착하면, 그 날짜를 다시 계산하지 않고 기존 합계에 더한다.
이 구분이 없던 초기 버전에서 **2,000건이 1건으로 바뀌는 버그**가 있었다.

**5. 카테고리가 다른 대형 브랜드는 순위에서 뺀다.**
`config.json`의 `reference_only`에 넣어 "참고 · 카테고리 다름"으로 따로 적는다.
전국 찜닭 체인을 아구찜 사다리에 세우면 항상 1위가 되어 나머지 순위가 무의미해진다.

**6. 조용한 날은 보내지 않는다.**
다만 연속 3일 미발송이 되는 날에는 "3일간 조용했습니다" 안심 메일이 온다.
침묵이 조용해서인지 고장나서인지 구분되게 하기 위해서다.

---

## 어떤 말을 하면 호출되나

| 스킬 | 트리거 |
|---|---|
| `voc-daily-snapshot` | "VOC 대시보드", "리뷰 모아줘", "일일 스냅샷", "별점 추이", "매장별 리뷰 현황", "고객 불만 정리" |
| `watchtower` | "경쟁사 모니터링", "경쟁사 뭐하나 봐줘", "우리 브랜드 평판 어때", "활동량 랭킹", "바이럴 터진 거 있나" |
| `brand-metrics` | "브랜드 지표 수집", "검색량 추이", "주차별 지표", "데이터랩 긁어줘", "블로그 발행량 추적" |

---

## 설치

```
/plugin marketplace add chansoul-drunken/voc
```

설치 후 각 스킬의 `config.example.json`을 복사해 실제 값을 채운다.

```bash
cp skills/watchtower/config.example.json skills/watchtower/config.json
```

---

## 실행에 필요한 것

| 스킬 | 필요한 것 | 비용 |
|---|---|---|
| voc-daily-snapshot | 구글 스프레드시트 + Apps Script (무료), 리뷰 소스 CSV/API | 무료 |
| watchtower | 네이버 검색 API, 유튜브 Data API (선택) | 무료 |
| brand-metrics | 네이버 개발자센터 오픈API (`NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`) | 무료 |

**API 키는 환경변수와 Apps Script의 Script Properties로만 다룬다.** 코드와 저장소에 넣지 않는다.

---

## 결과물이 어떻게 생겼나

**일일 대시보드** — `skills/voc-daily-snapshot/assets/dashboard.html`
브라우저로 바로 열면 목업 데이터로 동작한다. 상단 KPI 5개, 별점·건수·크리티컬 비율 추이, 전년 동기 비교 토글,
고객 접점(배달앱·QR설문)과 점주 접점(점주VOC·발주고)을 나눈 원문 리스트, 하단에 경쟁사 활동량 랭킹.

**활동량 랭킹** — `examples/RANKING_2026-08-24.tsv`
3개 사다리 22개 브랜드를 실제로 훑은 결과. 각 행에 측정 단서가 붙어 있다.
하한값에는 `+`를, 측정 불가에는 `n/a`를 쓴다.

---

## 저장소 구조

```
voc/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── skills/
│   ├── voc-daily-snapshot/
│   │   ├── SKILL.md
│   │   ├── scripts/Code.gs                    Apps Script 백엔드
│   │   ├── scripts/Code_watchtower_snapshot.gs  WATCHTOWER 연계 스냅샷
│   │   ├── assets/dashboard.html              단일 파일 대시보드
│   │   └── references/commentmong-api-request.md
│   ├── watchtower/
│   │   ├── SKILL.md
│   │   ├── README.md                          운영·튜닝 안내
│   │   ├── config.example.json                감시 대상 사다리 정의
│   │   ├── references/AGENT.md                운영 절차 전문
│   │   └── history/                           상태 파일 예시 4종 + 설명
│   └── brand-metrics/
│       ├── SKILL.md
│       ├── README.md                          43개 지표 인벤토리
│       ├── scripts/collect.py
│       └── keywords.json
└── examples/
    └── RANKING_2026-08-24.tsv
```

---

## 예시의 블라인드 처리

이 저장소는 실제 운영 중인 시스템에서 **접근 경로와 고객 데이터를 걷어낸 판본**이다.

| 항목 | 처리 |
|---|---|
| 스프레드시트 ID, Apps Script 배포 URL | `스프레드시트ID_교체하세요` 등 자리표시자로 치환 |
| 소유자 이메일, 조직 도메인 | `owner@example.com`, `example.com`으로 치환 |
| VOC 원문·고객 리뷰 | 전부 제외. 대시보드의 리뷰는 **합성 목업**이다 |
| 상태 파일(`history/*.json`) 실측값 | 제외. 대신 **스키마를 보여주는 예시값**을 넣었다(`*.example.json`) |
| 경쟁사 리포트 HTML, 내부 패널 리뷰 | 제외 |
| 브랜드명, 블로그 언급 건수 | **그대로 둠.** 공개 프랜차이즈 브랜드이고 공개 검색으로 잰 수치다 |

`config.json`, `history/*.json`, `reports/`는 `.gitignore`에 있다. 실제 값을 넣어도 커밋되지 않는다.

---

## 법적 표시

- 활동량 랭킹이 재는 것은 **경쟁력이 아니라 공개 노출 활동량**이다. 보도자료와 체험단을 많이 돌리면 올라간다. 순위를 실력으로 읽지 말 것.
- 검색 API 결과는 수집 시점의 색인 상태에 따라 달라진다. 같은 질의도 다른 날 다른 수를 준다. 그래서 **하한값 표기**를 쓴다.
- 매장명까지만 다룬다. **점주 실명·개인 연락처, 설문 응답자의 성함·연락처는 시스템에 넣지 않는다.**
- 각 포털의 API 이용약관과 로봇 정책을 따를 것. 이 저장소는 공식 오픈API만 사용한다.

---

## 라이선스

MIT
