/**
 * 인생푸드 VOC 통합 대시보드 — Apps Script 백엔드
 *
 * 설치(최초 1회):
 * 1. 확장 프로그램 > Apps Script 열기 → 이 파일을 Code.gs에 통째로 붙여넣기
 * 2. setupSheets() 실행 → 필요한 시트 8개 생성. 반환값에 무엇이 생겼는지 전부 적힌다.
 * 3. (선택) setupDailyTrigger() 실행 → 매일 오전 11시 syncAll() 자동 실행
 * ⚠️ Code_watchtower_snapshot.gs도 같은 프로젝트에 함께 넣어야 한다. syncCommentmong()이 그 파일의
 *    toFiveScale_()을 쓴다(네이버는 100점 만점이라 1~5로 환산해야 평균 별점이 망가지지 않는다).
 *
 * 시트 구성:
 *   MASTER_VOC          최근 RETENTION_DAYS치 원문. 대시보드가 읽는 곳
 *   ARCHIVE_VOC         보관 기간을 지난 원문
 *   DAILY_AGGREGATE     날짜 × 브랜드 집계. 영구 보관 → 전년 동기 비교가 여기서 나온다
 *   MONTHLY_STORE_AGG   월 × 매장 집계. 영구 보관 → 전년 동월 매장 비교
 *   RANKING             경쟁사 활동량 랭킹(WATCHTOWER가 주 1회 채움)
 *   RAW_댓글몽 / RAW_가맹점문의 / RAW_소셜   원본 붙여넣는 자리
 *
 * 소스 5개와 수집 방식:
 *   배달앱리뷰   댓글몽 엑셀 → RAW_댓글몽에 붙여넣기 (브랜드마다 따로 받아야 함)
 *   QR설문       네이티브 구글시트라 시트ID만으로 자동
 *   점주VOC·발주고  "가맹점문의관리" 한 파일에 유입경로로 섞여 있음 → RAW_가맹점문의에 붙여넣기
 *                 유입경로='발주고'만 발주고, 나머지(개인연락·카카오톡·cs유선연락)는 점주VOC로 분류
 *   소셜·커뮤니티  다이닝코드·블로그 등 → RAW_소셜에 붙여넣기. 자사 브랜드 언급만 받는다(경쟁사는 WATCHTOWER 담당)
 *
 * 왜 원문과 집계를 갈라놨나:
 *   366일 원문을 시트에 두면 12.4M셀이라 구글시트 한계(10M)를 넘는다. 그런데 전년비 비교에 필요한 건
 *   건수·평균별점·크리티컬비율이지 원문이 아니다. 그래서 원문은 짧게 두고 집계만 영구 보관한다.
 *   집계는 하루 한 줄이라 5년을 쌓아도 2만 행이 안 된다.
 *
 * 남은 확인 항목:
 * - RAW_댓글몽에 붙여넣기 전 "리뷰ID" 열 서식을 텍스트로 지정할 것. 숫자로 들어오면 큰 값이 깨진다.
 *   (safeIdString_이 깨진 값을 걸러내지만, 애초에 안 깨지게 하는 편이 낫다)
 * - category/keyword는 원본에 없어서 categorize_()/extractKeyword_()로 임시 추정 — 정확도 낮음.
 * - region(매장↔지사)은 2026-07-28 "댓글몽BIZ매장등록" 파일 기준. 재배치가 있으면 YEONGNAM_STORES/HONAM_STORES 갱신.
 *   ⚠️ 매장명은 PII가 아니라 하드코딩했지만, 점주 실명·연락처는 절대 이 시트/대시보드로 옮기지 말 것.
 * - 웹앱 배포는 example.com 도메인 정책상 외부에서 302로 막힌다. 대시보드는 로그인된 브라우저에서만 실데이터를 받는다.
 *   WATCHTOWER는 웹앱이 아니라 Drive 커넥터로 WATCHTOWER_SNAPSHOT을 직접 읽는다.
 */

const MASTER_SHEET_NAME = 'MASTER_VOC';
const RAW_COMMENTMONG_SHEET = 'RAW_댓글몽';
const RAW_FRANCHISE_SHEET = 'RAW_가맹점문의';
const RAW_SOCIAL_SHEET = 'RAW_소셜';
const RANKING_SHEET_NAME = 'RANKING';
const RANKING_HEADERS = ['week_of','ladder','name','is_own','rank','prev_rank','score','note'];
const ARCHIVE_SHEET_NAME = 'ARCHIVE_VOC';
const DAILY_AGG_SHEET_NAME = 'DAILY_AGGREGATE';
// 실데이터 볼륨이 커질 걸 대비한 설계: MASTER_VOC는 최근 N일 원문만 유지(대시보드가 매번 전체를 통째로 읽어가기 때문).
// 그보다 오래된 원문은 ARCHIVE_VOC로 옮기고, 트렌드 차트용 일별 집계(건수/평균별점/크리티컬%)는 DAILY_AGGREGATE에 영구 보관.
const RETENTION_DAYS = 90;

// 마스터 시트 컬럼 — 원 스키마 초안(voc_id~reply_text) + 대시보드 운영에 필요해서 추가한 3개(region/menu/resolved_hours)
const HEADERS = [
  'voc_id', 'source', 'store_id', 'store_name', 'platform', 'date',
  'rating', 'sentiment', 'category', 'keywords', 'raw_text',
  'response_status', 'reply_text', 'region', 'menu', 'resolved_hours',
  // 2026-08-20 추가. 소셜·커뮤니티 언급은 원문 글로 돌아가는 링크가 핵심이라 컬럼이 필요하다.
  // 다른 소스는 빈 값으로 남는다.
  'url',
];

/**
 * 이름으로 받은 값을 HEADERS 순서의 배열로 바꾼다.
 *
 * 예전에는 네 곳에서 16개짜리 배열을 순서대로 직접 밀어넣었다. 컬럼을 하나 늘리려면
 * 네 곳을 다 고쳐야 하고, 한 곳만 빠뜨리면 setValues가 폭 불일치로 죽는다.
 * 이름으로 넣고 순서는 여기서만 맞춘다. 빠진 항목은 빈 칸이 된다.
 */
function toRow_(o) {
  return HEADERS.map((h) => {
    const v = o[h];
    return (v === undefined || v === null) ? '' : v;
  });
}

/**
 * 이미 만들어진 시트에 컬럼이 추가됐을 때 헤더 행을 맞춰준다.
 * 기존 데이터가 있는 시트는 setupSheets()가 다시 안 만들기 때문에, 헤더만 따로 보정한다.
 */
function ensureHeaders_(sheet) {
  const width = sheet.getLastColumn();
  const current = width ? sheet.getRange(1, 1, 1, width).getValues()[0] : [];
  const missing = HEADERS.filter((h) => current.indexOf(h) === -1);
  if (!missing.length) return 0;
  sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
  return missing.length;
}

// QR설문(전단설문) 응답 시트 — "인생아구찜 고객 만족도 설문 조사(응답)" 네이티브 구글시트, 확인 완료
const QR_SURVEY_SHEET_ID = '스프레드시트ID_교체하세요';

// 매장↔지사 매핑 (2026-07-28 "댓글몽BIZ매장등록" 파일 담당자 컬럼 기준, 사용자 확인 완료: 영남=류한그루 / 호남=차중무)
// 나머지 슈퍼바이저 담당 매장은 별도 지사가 아니라 전부 본사(hq) 범위.
const YEONGNAM_STORES = [
  '인생아구찜 수성점','인생아구찜 울산동구점','인생아구찜 칠곡점','인생아구찜 명지점','인생아구찜 성서점',
  '인생아구찜 부산진구점','인생아구찜 장산점','인생아구찜 광안점','인생아구찜 경산점','인생아구찜 사하점',
  '인생아구찜 내당점','인생아구찜 울산남구점','인생아구찜 울산북구점','인생아구찜 금정점','인생아구찜 울산무거점',
  '인생아구찜 산격점','인생아구찜 사상점','인생아구찜 포항북구점','인생아구찜 구미 원호문성점','인생아구찜 양산물금점',
  '인생아구찜 진해점','인생아구찜 남포점','인생아구찜 문현점','인생아구찜 온산온양점','인생아구찜 송정연암점',
  '인생아구찜 장유점','인생아구찜 수성못점','인생아구찜 대구동구점','인생아구찜 달서점','인생아구찜 경주점',
  '인생아구찜 부산북구점','인생아구찜 울산중구점','인생아구찜 용호메트로시티점','인생아구찜 현풍테크노점','인생아구찜 내외점',
  '인생아구찜 센텀점','인생아구찜 신경주점',
];
const HONAM_STORES = [
  '인생아구찜 창원점','인생아구찜 남악점','인생아구찜 목포점','인생아구찜 회원점','인생아구찜 광주북구점',
  '인생아구찜 송천점','인생아구찜 왕지점','인생아구찜 신용점','인생아구찜 진주망경점','인생아구찜 중마점',
  '인생아구찜 여천점','인생아구찜 순천오천점','인생아구찜 익산영등어양점','인생아구찜 여수문수점','인생아구찜 광산점',
  '인생아구찜 인후우아점','인생아구찜 군산점','인생아구찜 순천중앙점','인생아구찜 효자점','인생아구찜 해남점',
  '인생아구찜 옥종점','인생아구찜 광주동구점','인생아구찜 진주점','인생아구찜 봉동점','인생아구찜 전주혁신점',
];
function regionOf_(storeName) {
  if (YEONGNAM_STORES.indexOf(storeName) !== -1) return 'yeongnam';
  if (HONAM_STORES.indexOf(storeName) !== -1) return 'honam';
  return 'hq';
}

/* =========================================================
 * 초기 세팅
 * ========================================================= */
/**
 * 필요한 시트를 전부 만든다. 여러 번 실행해도 안전하다.
 * 무엇을 새로 만들었고 무엇이 이미 있었는지 반환값에 적는다.
 * (예전에는 "준비 완료"만 돌려줘서, 실제로 안 만들어져도 알 수가 없었다.)
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const created = [], existed = [];

  function need(name, headers) {
    const has = ss.getSheetByName(name);
    if (has) { existed.push(name); return has; }
    const sh = ss.insertSheet(name);
    if (headers) { sh.appendRow(headers); sh.setFrozenRows(1); }
    created.push(name);
    return sh;
  }

  const master = need(MASTER_SHEET_NAME, HEADERS);
  need(RAW_COMMENTMONG_SHEET, null);          // 댓글몽 엑셀을 통째로 붙여넣는 자리라 헤더를 미리 넣지 않는다
  need(RAW_FRANCHISE_SHEET, null);            // 가맹점문의 원본도 마찬가지
  need(RAW_SOCIAL_SHEET, SOCIAL_RAW_HEADERS);
  need(RANKING_SHEET_NAME, RANKING_HEADERS);
  need(ARCHIVE_SHEET_NAME, HEADERS);

  // 집계 두 시트는 ensureAggSheet_로 만든다. 여기서 옛 스키마로 만들면
  // rollupAndArchive()가 곧바로 구버전으로 판정해 _OLD_로 치워버린다.
  const before = ss.getSheets().length;
  ensureAggSheet_(ss, DAILY_AGG_SHEET_NAME, DAILY_AGG_HEADERS);
  ensureAggSheet_(ss, MONTHLY_STORE_AGG_SHEET, MONTHLY_AGG_HEADERS);
  const aggMade = ss.getSheets().length - before;

  // 컬럼이 추가된 뒤에도 기존 시트 헤더를 맞춰준다(url 등)
  const fixed = ensureHeaders_(master) + ensureHeaders_(ss.getSheetByName(ARCHIVE_SHEET_NAME));

  const lines = [];
  lines.push(`새로 만든 시트 ${created.length}개: ${created.length ? created.join(', ') : '없음'}`);
  lines.push(`이미 있던 시트 ${existed.length}개: ${existed.length ? existed.join(', ') : '없음'}`);
  lines.push(`집계 시트 처리: ${DAILY_AGG_SHEET_NAME}, ${MONTHLY_STORE_AGG_SHEET} (신규/교체 ${aggMade}개)`);
  if (fixed) lines.push(`헤더 보정 ${fixed}개 컬럼 추가`);
  lines.push(`현재 시트 목록: ${ss.getSheets().map((s) => s.getName()).join(', ')}`);
  const msg = lines.join('\n');
  Logger.log(msg);
  return msg;
}

function getOrCreateMaster(ss) {
  let sh = ss.getSheetByName(MASTER_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(MASTER_SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    return sh;
  }
  // 컬럼이 추가된 뒤 setupSheets()를 다시 안 돌린 상태로 동기화가 먼저 실행되면
  // 16칸짜리 시트에 17칸 행을 쓰려다 폭이 어긋난다. 여기서 항상 먼저 맞춘다.
  ensureHeaders_(sh);
  return sh;
}

/* =========================================================
 * 대시보드가 호출하는 JSONP 엔드포인트
 * ========================================================= */
// 응답을 두 통로로 나눔 (council 만장일치 결론, 2026-08-20)
//  mode=summary (기본): 지표·차트·목록에 필요한 짧은 필드 + 미리보기 60자만. 원문 전문은 안 보냄.
//  mode=detail&ids=a,b,c: 사용자가 행을 클릭했을 때 그 건들의 원문 전문만 따로 보냄.
// 이렇게 나눈 이유: 화면은 한 번에 20건만 쓰는데 예전 구조는 기간 내 전 건의 원문을 통째로 보냈음.
// 원문이 응답 크기의 대부분이라, 이것만 빼면 보관 기간을 줄이지 않고도 응답이 작아짐.
const SNIPPET_LEN = 60;

function doGet(e) {
  const mode = (e.parameter.mode || 'summary').toLowerCase();
  const payload = mode === 'detail' ? buildDetail_(e.parameter.ids) : buildSummary_();
  return respond_(payload, e.parameter.callback);
}

function respond_(payload, cb) {
  const json = JSON.stringify(payload);
  const out = cb ? `${cb}(${json})` : json;
  return ContentService
    .createTextOutput(out)
    .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

function buildSummary_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(MASTER_SHEET_NAME);
  const rows = sheet.getDataRange().getValues();
  const headers = rows.shift();
  const idx = (h) => headers.indexOf(h);

  // MASTER_VOC는 최근 RETENTION_DAYS치 원문만 있음 (오래된 건 rollupAndArchive()가 ARCHIVE_VOC로 이미 옮겨둠)
  const items = rows
    .filter((r) => r[idx('voc_id')])
    .map((r) => {
      const text = String(r[idx('raw_text')] || '');
      return {
        id: r[idx('voc_id')],
        source: r[idx('source')],
        store: r[idx('store_name')],
        store_id: r[idx('store_id')],
        region: r[idx('region')] || '',
        platform: r[idx('platform')],
        date: formatDate_(r[idx('date')]),
        rating: r[idx('rating')] === '' || r[idx('rating')] == null ? null : Number(r[idx('rating')]),
        sentiment: r[idx('sentiment')],
        category: r[idx('category')],
        keyword: r[idx('keywords')],
        menu: r[idx('menu')] || '',
        // 목록 한 줄에 쓸 미리보기만. 전문은 mode=detail로 따로 받음.
        snippet: text.length > SNIPPET_LEN ? text.slice(0, SNIPPET_LEN) + '…' : text,
        hasMore: text.length > SNIPPET_LEN,
        response: r[idx('response_status')],
        resolvedHours: r[idx('resolved_hours')] === '' ? null : Number(r[idx('resolved_hours')]) || null,
      };
    });

  // 트렌드는 원문 없이도 그릴 수 있어서 가벼운 집계로 따로 서빙한다.
  // 원문은 보관 기간만 남지만 이 집계는 영구라, 전년 동기 비교가 여기서 나온다.
  // ⚠️ 시트는 발견 순서로 쌓이지 날짜순이 아니라서 반드시 정렬해 내보낸다.
  // 스키마: date, brand, count, rated, rating_sum, crit, avg_rating, critical_rate
  const aggSheet = ss.getSheetByName(DAILY_AGG_SHEET_NAME);
  const trend = aggSheet
    ? aggSheet.getDataRange().getValues().slice(1).filter((r) => r[0]).map((r) => ({
        date: formatDate_(r[0]),
        brand: String(r[1] || ''),
        count: Number(r[2]) || 0,
        // 평균이 아니라 합계를 보낸다. 브랜드가 여러 줄로 오므로 화면에서 날짜별로 합칠 때
        // 평균의 평균을 내면 틀린다. 합계를 보내면 가중평균이 정확히 나온다.
        rated: Number(r[3]) || 0,
        ratingSum: Number(r[4]) || 0,
        critCount: Number(r[5]) || 0,
      })).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    : [];

  // 월 × 매장 집계. 전년 동월 대비 매장 비교용이며 연 2,556행 수준이라 통째로 내려도 가볍다.
  const monSheet = ss.getSheetByName(MONTHLY_STORE_AGG_SHEET);
  const monthly = monSheet
    ? monSheet.getDataRange().getValues().slice(1).filter((r) => r[0]).map((r) => ({
        month: String(r[0]), brand: String(r[1] || ''), store: String(r[2] || ''),
        count: Number(r[3]) || 0, avg: Number(r[7]) || 0, crit: Number(r[8]) || 0,
      }))
    : [];

  // 경쟁사 활동량 랭킹. WATCHTOWER가 주 1회 채우는 자리이고, 비어 있으면 대시보드가 안내를 띄운다.
  const rankSheet = ss.getSheetByName(RANKING_SHEET_NAME);
  const ranking = rankSheet
    ? rankSheet.getDataRange().getValues().slice(1).filter((r) => r[0] && r[2]).map((r) => ({
        week: String(r[0]), ladder: String(r[1] || ''), name: String(r[2] || ''),
        isOwn: String(r[3]).toUpperCase() === 'TRUE' || r[3] === true,
        rank: Number(r[4]) || 0,
        prevRank: (r[5] === '' || r[5] == null) ? null : Number(r[5]),
        score: Number(r[6]) || 0, note: String(r[7] || ''),
      }))
    : [];

  // 화면 맨 위에 "언제 갱신됐고 오늘 몇 건 들어왔나"를 박아서 조용한 실패를 눈에 보이게 만듦
  const today = formatDate_(new Date());
  const meta = {
    lastSync: PropertiesService.getScriptProperties().getProperty('LAST_SYNC_AT') || '',
    todayCount: items.filter((x) => x.date === today).length,
    totalRows: items.length,
    retentionDays: RETENTION_DAYS,
  };

  return { items, trend, monthly, ranking, meta };
}

// 클릭한 건들의 원문 전문만 돌려줌. 한 번에 너무 많이 요청하는 걸 막으려고 상한을 둠.
const DETAIL_MAX = 50;
function buildDetail_(idsParam) {
  const wanted = String(idsParam || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, DETAIL_MAX);
  if (!wanted.length) return { detail: {} };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(MASTER_SHEET_NAME);
  const rows = sheet.getDataRange().getValues();
  const headers = rows.shift();
  const idx = (h) => headers.indexOf(h);

  const want = {};
  wanted.forEach((id) => { want[id] = true; });

  const detail = {};
  rows.forEach((r) => {
    const id = r[idx('voc_id')];
    if (!id || !want[id]) return;
    detail[id] = {
      raw_text: String(r[idx('raw_text')] || ''),
      reply_text: String(r[idx('reply_text')] || ''),
    };
  });
  return { detail };
}

/* =========================================================
 * 댓글몽 엑셀(RAW_댓글몽 시트에 붙여넣은 것) → MASTER_VOC 반영
 * 2026-08-20 실제 export(voc정리 시트) 기준으로 헤더 확정:
 * 번호,리뷰ID,매장명,사업자등록번호,플랫폼,플랫폼매장명,매장ID,별점,작성자,리뷰작성일,
 * 주문메뉴,주문번호(쿠팡이츠),리뷰상태,리뷰내용,등록댓글1,댓글등록일1,등록댓글2,댓글등록일2,등록댓글3,댓글등록일3
 * ⚠️ "매장명"은 표기가 들쭉날쭉하고("인생아구찜-부산본점" 하이픈) 가끔 지사명이 잘못 들어있어("인생아구찜 호남지사")
 *   신뢰 불가 — 대신 플랫폼별로 검증되는 "플랫폼매장명"(공백 표기, 지사 매핑 리스트와 일치)을 store_name으로 사용.
 * ⚠️ "리뷰ID"가 배달의민족 건에서 2.02608E+15처럼 과학적표기법(지수)으로 깨져 들어올 수 있음 — 정밀도가 이미
 *   손실된 상태라 코드로 복구 불가. RAW_댓글몽에 붙여넣기 전에 그 컬럼 서식을 "일반 텍스트"로 지정해야 함.
 * ========================================================= */
function syncCommentmong() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const raw = ss.getSheetByName(RAW_COMMENTMONG_SHEET);
  if (!raw || raw.getLastRow() < 2) return '댓글몽 원본 데이터가 없습니다 (RAW_댓글몽 시트 확인)';

  const rows = raw.getDataRange().getValues();
  const headers = rows.shift();
  const idx = (name) => headers.indexOf(name);

  const COL = {
    reviewId: idx('리뷰ID'),
    storeId: idx('매장ID'),
    storeName: idx('플랫폼매장명'), // "매장명"이 아니라 이걸 씀 (위 주석 참고)
    platform: idx('플랫폼'),
    date: idx('리뷰작성일'),
    rating: idx('별점'),
    menu: idx('주문메뉴'),
    text: idx('리뷰내용'),
    status: idx('리뷰상태'),
    reply: idx('등록댓글1'), // 스레드 2·3번째 댓글은 일단 미반영 (필요해지면 이어붙이기)
  };
  const missing = Object.entries(COL).filter(([, v]) => v === -1).map(([k]) => k);
  if (missing.length) {
    throw new Error(`RAW_댓글몽 헤더에서 컬럼을 못 찾았습니다: ${missing.join(', ')} — 실제 엑셀 헤더명으로 COL을 수정하세요`);
  }

  const master = getOrCreateMaster(ss);
  const existingIds = new Set(
    readVocIds_(master)
  );

  const toAppend = [];
  const badIds = []; // 못 믿을 ID는 조용히 넘기지 않고 세어서 반환 메시지에 올린다
  rows.forEach((r) => {
    if (!r[COL.reviewId]) return;
    const checked = safeIdString_(r[COL.reviewId]);
    if (!checked.ok) {
      badIds.push(`${checked.shown}(${checked.reason})`);
      return;
    }
    const vocId = 'CM-' + checked.value;
    if (existingIds.has(vocId)) return; // 중복 방지 (같은 파일 여러 번 붙여넣어도 안전)

    // 플랫폼마다 만점이 다르다(네이버는 플레이스 점수라 100점 만점) — 저장 전에 1~5로 환산한다.
    // 환산하지 않으면 sentimentFromRating_()이 100점짜리를 전부 '긍정'으로 처리하고
    // 평균 별점도 5점을 넘어버린다. toFiveScale_/RATING_SCALE 정의는 watchtower 파일에 있다.
    const rating = toFiveScale_(r[COL.rating], r[COL.platform]);
    const text = String(r[COL.text] || '');
    toAppend.push(toRow_({
      voc_id: vocId,
      source: '배달앱리뷰',
      store_id: r[COL.storeId],
      store_name: r[COL.storeName],
      platform: r[COL.platform],
      date: formatDate_(r[COL.date]),
      rating: rating,
      sentiment: sentimentFromRating_(rating),
      category: categorize_(text),
      keywords: extractKeyword_(text),
      raw_text: text,
      response_status: r[COL.status],
      reply_text: r[COL.reply] || '',
      region: regionOf_(r[COL.storeName]),
      menu: r[COL.menu] || '',
      // resolved_hours — 응대완료 시각 데이터 확인 전까지 공란
    }));
  });

  if (toAppend.length) {
    master.getRange(master.getLastRow() + 1, 1, toAppend.length, HEADERS.length).setValues(toAppend);
  }
  let msg = `댓글몽 ${toAppend.length}건 반영 완료 (중복 제외)`;
  if (badIds.length) {
    // 못 믿을 ID가 있으면 반환 메시지에 올려서 눈에 보이게 한다. 로그만 남기면 아무도 안 본다.
    msg += ` / ⚠️ ID를 믿을 수 없어 건너뛴 ${badIds.length}건: ${badIds.slice(0, 5).join(', ')}${badIds.length > 5 ? ' …' : ''}`;
    Logger.log(msg);
  }
  return msg;
}

/* =========================================================
 * [준비] 댓글몽 API 연동 — API를 받으면 이걸로 syncCommentmong()을 대체
 *
 * 사용법:
 * 1. Apps Script 편집기 > 프로젝트 설정(톱니바퀴) > "스크립트 속성"에 아래 2개 추가
 *    COMMENTMONG_API_KEY   = 댓글몽이 발급한 키
 *    COMMENTMONG_API_BASE  = 댓글몽이 알려준 base URL (예: https://api.lemong.ai/v1)
 *    ⚠️ 코드에 절대 하드코딩하지 말 것 — 이 파일을 다른 사람과 공유해도 키가 노출되지 않음
 * 2. 아래 인증 헤더/엔드포인트/필드명은 댓글몽 API 문서를 받으면 실제 값으로 수정 필요 (지금은 가장 흔한 패턴으로 가정)
 * 3. syncAll()에서 syncCommentmong() 대신 syncCommentmongApi()를 호출하도록 교체
 * 4. RAW_댓글몽 시트/매일 수동 다운로드 스텝은 더 이상 필요 없어짐
 * ========================================================= */
function syncCommentmongApi() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('COMMENTMONG_API_KEY');
  const apiBase = props.getProperty('COMMENTMONG_API_BASE');
  if (!apiKey || !apiBase) return '스크립트 속성에 COMMENTMONG_API_KEY / COMMENTMONG_API_BASE를 먼저 설정하세요';

  const lastSync = props.getProperty('COMMENTMONG_LAST_SYNC') || '2000-01-01T00:00:00Z';
  const nowIso = new Date().toISOString();

  const master = getOrCreateMaster(SpreadsheetApp.getActiveSpreadsheet());
  const existingIds = new Set(
    readVocIds_(master)
  );

  const toAppend = [];
  let page = 1;
  const MAX_PAGES = 200; // 무한루프 방지 안전장치

  while (page <= MAX_PAGES) {
    // TODO: 실제 API 문서 기준으로 엔드포인트/파라미터명 확정 (지금은 흔한 REST 패턴으로 가정)
    const url = `${apiBase}/reviews?updated_after=${encodeURIComponent(lastSync)}&page=${page}&per_page=100`;
    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: `Bearer ${apiKey}` }, // TODO: 실제 인증 헤더 형식 확인
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      throw new Error(`댓글몽 API 호출 실패 (${res.getResponseCode()}): ${res.getContentText().slice(0, 300)}`);
    }

    const body = JSON.parse(res.getContentText());
    const rows = body.data || body.items || []; // TODO: 실제 응답 구조에 맞춰 키 이름 수정
    if (!rows.length) break;

    rows.forEach((r) => {
      // TODO: 실제 API 응답 필드명으로 교체 (지금은 화면/엑셀에서 본 라벨 기준 추정)
      const vocId = 'CM-' + (r.review_id || r.id);
      if (existingIds.has(vocId)) return;
      const rating = Number(r.rating) || null;
      const text = String(r.content || r.review_text || '');
      toAppend.push(toRow_({
        voc_id: vocId,
        source: '배달앱리뷰',
        store_id: r.store_id,
        store_name: r.store_name,
        platform: r.platform,
        date: formatDate_(r.created_at),
        rating: rating,
        sentiment: sentimentFromRating_(rating),
        category: categorize_(text),
        keywords: extractKeyword_(text),
        raw_text: text,
        response_status: r.reply_status || r.status,
        reply_text: r.reply_content || '',
        region: regionOf_(r.store_name),
        menu: r.menu_name || '',
      }));
    });

    if (!body.has_next && !body.next_page) break; // TODO: 실제 페이지네이션 응답 필드명 확인
    page++;
  }

  if (toAppend.length) {
    master.getRange(master.getLastRow() + 1, 1, toAppend.length, HEADERS.length).setValues(toAppend);
  }
  props.setProperty('COMMENTMONG_LAST_SYNC', nowIso); // 다음 실행은 이 시각 이후 데이터만 조회 (증분 동기화)
  return `댓글몽 API ${toAppend.length}건 반영 완료 (증분 기준: ${lastSync} 이후)`;
}

/* =========================================================
 * QR설문("인생아구찜 고객 만족도 설문 조사(응답)") — 네이티브 구글시트라 openById로 직접 읽음, RAW_ 붙여넣기 불필요
 * Google Forms 헤더는 질문 문구 그대로라 완전일치 대신 부분일치(includes)로 컬럼을 찾음 — 질문 문구가 바뀌면 깨질 수 있음
 * ⚠️ "성함과 연락처" 컬럼은 경품 발송용 개인정보라 절대 master 시트로 옮기지 않음(고의로 매핑 안 함)
 * ========================================================= */
function syncQrSurvey() {
  if (!QR_SURVEY_SHEET_ID) return 'QR_SURVEY_SHEET_ID가 설정되지 않았습니다 — 건너뜀';
  const src = SpreadsheetApp.openById(QR_SURVEY_SHEET_ID);
  const sheet = src.getSheets()[0];
  const rows = sheet.getDataRange().getValues();
  const headers = rows.shift();

  const findCol = (needle) => headers.findIndex((h) => String(h).includes(needle));
  const COL = {
    timestamp: findCol('타임스탬프'),
    store: findCol('매장명'),
    visitDate: findCol('이용일자'),
    platform: findCol('플랫폼'),
    overallSat: findCol('전반적인 만족도'),
    overallReason: findCol('11-1'),
    tasteReason: findCol('12-1'),
    bestExperience: findCol('가장 만족스러운 경험'),
    menuSuggestion: findCol('추가되었으면 하는'),
    brandFeedback: findCol('브랜드 발전을 위해'),
  };
  const missing = Object.entries(COL).filter(([, v]) => v === -1).map(([k]) => k);
  if (missing.length) {
    throw new Error(`QR설문 헤더에서 컬럼을 못 찾았습니다: ${missing.join(', ')} — 설문 문구가 바뀌었는지 확인하세요`);
  }

  const master = getOrCreateMaster(ss_());
  const existingIds = new Set(
    readVocIds_(master)
  );

  const SAT_TO_RATING = { '매우만족': 5, '만족': 4, '보통': 3, '불만족': 2, '매우불만족': 1 };

  const toAppend = [];
  rows.forEach((r) => {
    const store = String(r[COL.store] || '').trim();
    if (!store) return;

    const date = formatDate_(r[COL.visitDate] || r[COL.timestamp]);
    const vocId = makeId_('QR', [store, date, String(r[COL.timestamp])]);
    if (existingIds.has(vocId)) return;

    const rating = SAT_TO_RATING[String(r[COL.overallSat]).trim()] || null;
    // 개인정보(성함/연락처)는 절대 포함하지 않고, 자유서술 응답만 이어붙여 raw_text 구성
    const parts = [
      r[COL.overallReason] && `[전반적 불만이유] ${r[COL.overallReason]}`,
      r[COL.tasteReason] && `[맛/품질 불만이유] ${r[COL.tasteReason]}`,
      r[COL.bestExperience] && `[만족 경험] ${r[COL.bestExperience]}`,
      r[COL.menuSuggestion] && `[메뉴 제안] ${r[COL.menuSuggestion]}`,
      r[COL.brandFeedback] && `[브랜드 의견] ${r[COL.brandFeedback]}`,
    ].filter(Boolean);
    const text = parts.join(' / ');
    if (!text) return; // 자유서술 응답이 전혀 없는 행은 VOC로서 의미가 없어 건너뜀

    toAppend.push(toRow_({
      voc_id: vocId,
      source: 'QR설문',
      store_name: store,
      platform: r[COL.platform] || 'QR',
      date: date,
      rating: rating,
      sentiment: sentimentFromRating_(rating),
      category: categorize_(text),
      keywords: extractKeyword_(text),
      raw_text: text,
      region: regionOf_(store),
      // response_status — QR설문은 CS 응대 티켓 개념이 없어 공란
      // store_id/menu/resolved_hours/url도 해당 없음
    }));
  });

  if (toAppend.length) {
    master.getRange(master.getLastRow() + 1, 1, toAppend.length, HEADERS.length).setValues(toAppend);
  }
  return `QR설문 ${toAppend.length}건 반영 완료 (중복 제외)`;
}

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/* =========================================================
 * 가맹점 문의(발주고 등) — "인생아구찜 가맹점문의관리" 파일 구조 기준
 * 실제 헤더: 점포명,유입경로,문의날짜,접수자,상세 문의 내용,처리자,완료내역,완료일,처리상태,비고
 * ⚠️ 원본에 명시적 고유ID가 없어 (점포명+문의날짜+문의내용앞20자)를 해시해서 voc_id로 사용 — 중복 붙여넣기에도 안전
 * ========================================================= */
function syncFranchiseInquiry() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const raw = ss.getSheetByName(RAW_FRANCHISE_SHEET);
  if (!raw || raw.getLastRow() < 2) return '가맹점문의 원본 데이터가 없습니다 (RAW_가맹점문의 시트 확인)';

  const rows = raw.getDataRange().getValues();
  const headers = rows.shift();
  const idx = (name) => headers.indexOf(name);

  const COL = {
    store: idx('점포명'),
    channel: idx('유입경로'), // 시트 내 통계 요약 기준 값: 발주고/개인연락/카카오톡/cs유선연락/기타
    date: idx('문의날짜'),
    text: idx('상세 문의 내용'),
    status: idx('처리상태'),
    resolution: idx('완료내역'),
  };
  const missing = Object.entries(COL).filter(([, v]) => v === -1).map(([k]) => k);
  if (missing.length) {
    throw new Error(`RAW_가맹점문의 헤더에서 컬럼을 못 찾았습니다: ${missing.join(', ')} — 실제 파일 헤더명으로 COL을 수정하세요`);
  }

  const master = getOrCreateMaster(ss);
  const existingIds = new Set(
    readVocIds_(master)
  );

  const toAppend = [];
  rows.forEach((r) => {
    const store = String(r[COL.store] || '').trim();
    const text = String(r[COL.text] || '').trim();
    if (!store || !text) return;

    const date = formatDate_(r[COL.date]);
    const vocId = makeId_('FQ', [store, date, text.slice(0, 20)]);
    if (existingIds.has(vocId)) return; // 중복 방지

    // 유입경로가 '발주고'인 것만 발주고로, 개인연락/카카오톡/cs유선연락 등 나머지는 전부 점주VOC로 버킷
    const source = (r[COL.channel] || '').trim() === '발주고' ? '발주고' : '점주VOC';

    toAppend.push(toRow_({
      voc_id: vocId,
      source: source,
      // store_id — 댓글몽 매장번호 체계와 달라 매칭 불가, 매장명으로만 조인
      store_name: store,
      platform: '가맹점문의관리시트', // 배달앱 플랫폼이 아니라 이 관리 파일 자체를 출처로 표기
      date: date,
      // rating — 가맹점 문의에는 별점이 없음
      sentiment: '중립', // 임시값. 내용 기반 분류로 교체 권장
      category: categorize_(text),
      keywords: extractKeyword_(text),
      raw_text: text,
      response_status: r[COL.status] || '',
      reply_text: r[COL.resolution] || '',
      region: regionOf_(store),
    }));
  });

  if (toAppend.length) {
    master.getRange(master.getLastRow() + 1, 1, toAppend.length, HEADERS.length).setValues(toAppend);
  }
  return `가맹점문의 ${toAppend.length}건 반영 완료 (중복 제외)`;
}

/* =========================================================
 * 소셜·커뮤니티 언급 (5번째 소스, 2026-08-20 추가)
 *
 * 기존 4개 소스는 전부 자사 채널이다. 배달앱·QR설문·점주문의·발주고 모두 고객이
 * "우리 창구에" 남긴 글이다. 그런데 네이버 블로그·카페, 다이닝코드, 커뮤니티, 유튜브에
 * 남는 브랜드 언급은 통째로 빠져 있었다. 그쪽이 신규 고객이 실제로 보는 화면이다.
 *
 * 성격이 다르므로 운영 방식도 다르다:
 *  - 볼륨이 작다. 배달앱은 하루 1,300건인데 소셜은 매장당 1~2건 수준이다(2026-08-20 실측).
 *    그래서 매일 돌릴 필요가 없다. 주 1회로 충분하다.
 *  - 매장이 특정 안 되는 브랜드 단위 언급이 많다. 그때는 store_name에 브랜드명을 넣고
 *    지사 범위에서는 빠지게 둔다(본사만 본다).
 *  - 원문 글로 돌아가는 링크가 핵심이라 url 컬럼을 쓴다.
 *
 * 수집은 사람이 검색해서 RAW_소셜 시트에 붙여넣는다. 자동 크롤링은 각 플랫폼 약관 문제가
 * 있어서 넣지 않았다.
 * ========================================================= */
const SOCIAL_RAW_HEADERS = ['채널', '작성일', '매장명', '별점', '내용', 'URL', '감성'];

/**
 * 자사 브랜드. RAW_소셜에 경쟁사 언급이 섞여 들어오는 것을 막는 기준이다.
 *
 * 경쟁사 모니터링은 WATCHTOWER가 따로 한다(watchtower/config.json의 ladders에 경쟁사 21곳 등록,
 * 일간 리스크 경보 + 주간 활동량 랭킹). 경쟁사 언급을 MASTER_VOC에 넣으면 두 가지가 깨진다.
 *   1. 총 VOC 건수와 평균 별점이 오염된다. 경쟁사 ★5 리뷰가 우리 평균을 끌어올린다.
 *   2. WATCHTOWER와 집계가 중복된다.
 * 그래서 여기서는 자사 브랜드 언급만 받는다.
 */
const OWN_BRANDS = ['인생아구찜', '삼대미역', '어화락'];

function isOwnBrandMention_(store, text) {
  const hay = String(store || '') + ' ' + String(text || '');
    return OWN_BRANDS.some((b) => hay.indexOf(b) !== -1);
}

/**
 * 진단용. Apps Script 편집기에서 이 함수를 실행하고 반환값(또는 실행 로그)을 읽으면 된다.
 *
 * 답해주는 것 세 가지:
 *   1. 삼대미역·어화락이 스냅샷에서 0건인 이유가 "데이터가 없어서"인지 "매장명이 브랜드명으로
 *      시작하지 않아 필터에서 빠져서"인지. 스냅샷 필터는 매장명 앞부분 일치라 표기가 다르면 못 잡는다.
 *   2. MASTER_VOC에 실제로 며칠 치가 들어 있는지, 하루 평균 몇 건인지.
 *      (하루 1,300건이라는 수치는 댓글몽 화면에서 본 값이고 시트 실측으로 검증된 적이 없다.)
 *   3. 가장 최근 리뷰가 며칠 전인지. 48시간 창이 비는 이유가 여기서 드러난다.
 */
function diagnoseBrandCoverage() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(MASTER_SHEET_NAME);
  const rows = sh.getDataRange().getValues();
  const headers = rows.shift();
  const iSource = headers.indexOf('source');
  const iStore = headers.indexOf('store_name');
  const iDate = headers.indexOf('date');
  const iPlat = headers.indexOf('platform');

  const delivery = rows.filter((r) => r[iSource] === '배달앱리뷰');
  const out = [];
  out.push(`MASTER_VOC 총 ${rows.length}행 / 배달앱리뷰 ${delivery.length}행`);

  // 1) 브랜드별 매칭 결과 — 스냅샷과 같은 "앞부분 일치" 방식으로 세고, 포함 일치와 비교한다.
  out.push('', '[브랜드 매칭]');
  OWN_BRANDS.forEach((b) => {
    const startsWith = delivery.filter((r) => String(r[iStore]).indexOf(b) === 0).length;
    const contains = delivery.filter((r) => String(r[iStore]).indexOf(b) !== -1).length;
    let note = '';
    if (startsWith === 0 && contains > 0) note = '  ← 표기 불일치! 매장명이 브랜드명으로 시작하지 않아 스냅샷에서 전부 누락됨';
    else if (startsWith === 0 && contains === 0) note = '  ← 데이터 자체가 없음(엑셀 export에 안 담겼을 가능성)';
    else if (contains > startsWith) note = `  ← ${contains - startsWith}건은 매장명 표기가 달라 스냅샷에서 누락됨`;
    out.push(`  ${b}: 앞부분일치 ${startsWith}건 / 포함 ${contains}건${note}`);
  });

  // 2) 어느 브랜드에도 안 걸린 매장명 표본 — 표기 문제를 눈으로 확인하는 용도
  const orphans = {};
  delivery.forEach((r) => {
    const s = String(r[iStore] || '');
    if (!OWN_BRANDS.some((b) => s.indexOf(b) === 0)) orphans[s] = (orphans[s] || 0) + 1;
  });
  const orphanKeys = Object.keys(orphans);
  out.push('', `[어느 브랜드로도 안 잡힌 매장명] ${orphanKeys.length}종`);
  orphanKeys.slice(0, 15).forEach((k) => out.push(`  "${k}" ${orphans[k]}건`));
  if (orphanKeys.length > 15) out.push(`  … 외 ${orphanKeys.length - 15}종`);

  // 3) 날짜 범위와 하루 평균 — "하루 1,300건" 가정의 실측 검증
  const dates = delivery.map((r) => formatDate_(r[iDate])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (dates.length) {
    const first = dates[0], last = dates[dates.length - 1];
    const distinctDays = new Set(dates).size;
    const spanDays = Math.round((new Date(last) - new Date(first)) / 86400000) + 1;
    const today = formatDate_(new Date());
    const daysStale = Math.round((new Date(today) - new Date(last)) / 86400000);
    out.push('', '[유입량 실측]');
    out.push(`  기간: ${first} ~ ${last} (${spanDays}일 구간, 실제 데이터가 있는 날 ${distinctDays}일)`);
    out.push(`  하루 평균: ${(delivery.length / Math.max(distinctDays, 1)).toFixed(0)}건 (데이터 있는 날 기준)`);
    out.push(`  가장 최근 리뷰: ${last} → 오늘 기준 ${daysStale}일 전`);
    if (daysStale >= 2) out.push(`  ⚠️ 48시간 창이 비는 이유입니다. 댓글몽 export를 ${last} 이후분으로 다시 받아 붙여넣으세요.`);
  }

  // 4) 플랫폼 분포 — 네이버 제외 규칙이 실제로 얼마를 걸러내는지
  const plat = {};
  delivery.forEach((r) => { const p = String(r[iPlat] || '(공란)').trim(); plat[p] = (plat[p] || 0) + 1; });
  out.push('', '[플랫폼 분포]');
  Object.keys(plat).sort((a, b) => plat[b] - plat[a]).forEach((p) => out.push(`  ${p}: ${plat[p]}건`));

  const text = out.join('\n');
  Logger.log(text);
  return text;
}

function syncSocialMentions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const raw = ss.getSheetByName(RAW_SOCIAL_SHEET);
  if (!raw || raw.getLastRow() < 2) return '소셜 원본 데이터가 없습니다 (RAW_소셜 시트 확인)';

  const rows = raw.getDataRange().getValues();
  const headers = rows.shift();
  const idx = (name) => headers.indexOf(name);
  const COL = {
    channel: idx('채널'), date: idx('작성일'), store: idx('매장명'),
    rating: idx('별점'), text: idx('내용'), url: idx('URL'), sentiment: idx('감성'),
  };
  const missing = Object.entries(COL).filter(([, v]) => v === -1).map(([k]) => k);
  if (missing.length) {
    throw new Error(`RAW_소셜 헤더에서 컬럼을 못 찾았습니다: ${missing.join(', ')} — 헤더는 ${SOCIAL_RAW_HEADERS.join(', ')} 입니다`);
  }

  const master = getOrCreateMaster(ss);
  const existingIds = new Set(readVocIds_(master));

  const toAppend = [];
  const skippedNotOurs = [];
  rows.forEach((r) => {
    const text = String(r[COL.text] || '').trim();
    const url = String(r[COL.url] || '').trim();
    if (!text) return;

    // 경쟁사 언급은 받지 않는다. WATCHTOWER 담당이고, 여기 들어오면 우리 지표가 오염된다.
    if (!isOwnBrandMention_(r[COL.store], text)) {
      skippedNotOurs.push(String(r[COL.store] || text.slice(0, 12)));
      return;
    }

    const date = formatDate_(r[COL.date]);
    // URL이 있으면 그게 가장 안정적인 고유키다. 없으면 채널+날짜+내용앞20자로 해시한다.
    const vocId = makeId_('SO', [url || (String(r[COL.channel]) + '|' + date), text.slice(0, 20)]);
    if (existingIds.has(vocId)) return;

    const store = String(r[COL.store] || '').trim();
    const rating = r[COL.rating] === '' || r[COL.rating] == null ? null : Number(r[COL.rating]);
    // 감성은 사람이 적어준 값을 우선 쓰고, 비어 있으면 별점으로 추정한다.
    const sentiment = String(r[COL.sentiment] || '').trim() || sentimentFromRating_(rating);

    toAppend.push(toRow_({
      voc_id: vocId,
      source: '소셜·커뮤니티',
      store_name: store || '(브랜드 언급)', // 매장 미특정 건은 지사 범위에서 자연히 빠진다
      platform: String(r[COL.channel] || '').trim() || '기타',
      date: date,
      rating: rating,
      sentiment: sentiment,
      category: categorize_(text),
      keywords: extractKeyword_(text),
      raw_text: text,
      region: regionOf_(store),
      url: url,
    }));
  });

  if (toAppend.length) {
    master.getRange(master.getLastRow() + 1, 1, toAppend.length, HEADERS.length).setValues(toAppend);
  }
  let msg = `소셜·커뮤니티 ${toAppend.length}건 반영 완료 (중복 제외)`;
  if (skippedNotOurs.length) {
    msg += ` / 자사 브랜드 언급이 아니어서 건너뛴 ${skippedNotOurs.length}건: ${skippedNotOurs.slice(0, 3).join(', ')}${skippedNotOurs.length > 3 ? ' …' : ''}`
      + ' (경쟁사는 WATCHTOWER 담당입니다)';
  }
  return msg;
}

/* =========================================================
 * 집계 스키마 (2026-08-24 개편)
 *
 * 왜 바꿨나 — 두 가지 결함이 있었다.
 *
 * 1. 덮어쓰기 결함. 예전 집계는 MASTER_VOC에 남아 있는 행만으로 그날 값을 계산해 덮어썼다.
 *    보관 기간이 지나 아카이브된 날짜에 리뷰가 뒤늦게 1건 들어오면, 그날 집계가 그 1건으로
 *    통째로 대체됐다. 전년비를 보려는 바로 그 과거 데이터가 조용히 망가지는 자리다.
 *    → 합계(rating_sum, crit)를 저장해 누적이 가능하게 바꿨다. 새로 들어온 만큼만 더한다.
 *
 * 2. 차원 부족. date 하나뿐이라 "작년 이맘때 부산본점은 어땠나"를 볼 수 없었다.
 *    → 일별은 브랜드 차원, 월별은 매장 차원을 더했다.
 *
 * 크기: 일별 × 브랜드 3개 = 연 1,098행, 월별 × 매장 213개 = 연 2,556행.
 * 원문을 366일 두는 건 12.4M셀이라 불가능하지만, 집계는 5년을 쌓아도 2만 행이 안 된다.
 * 전년 동기 비교는 전부 이 두 시트에서 나온다.
 * ========================================================= */
const DAILY_AGG_HEADERS = ['date', 'brand', 'count', 'rated', 'rating_sum', 'crit', 'avg_rating', 'critical_rate'];
const MONTHLY_STORE_AGG_SHEET = 'MONTHLY_STORE_AGG';
const MONTHLY_AGG_HEADERS = ['month', 'brand', 'store_name', 'count', 'rated', 'rating_sum', 'crit', 'avg_rating', 'critical_rate'];

// 매장명 앞부분으로 브랜드를 가른다. WATCHTOWER 스냅샷과 같은 방식이라 두 집계가 어긋나지 않는다.
function brandOf_(storeName) {
  const s = String(storeName || '');
  for (let i = 0; i < OWN_BRANDS.length; i++) {
    if (s.indexOf(OWN_BRANDS[i]) === 0) return OWN_BRANDS[i];
  }
  return '(기타)';
}

/**
 * 집계 시트를 새 스키마로 맞춘다. 옛 4칸 스키마면 통째로 다시 만들지 않고 이름만 바꿔 보존한다.
 * 옛 행에는 rating_sum이 없어 정확한 누적이 불가능한데, 추정으로 채우면 조용히 틀린 값이 남는다.
 * 지우지도 추정하지도 않고 따로 치워두는 쪽을 택했다.
 */
function ensureAggSheet_(ss, name, wantHeaders) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(wantHeaders);
    sh.setFrozenRows(1);
    return sh;
  }
  const width = sh.getLastColumn();
  const cur = width ? sh.getRange(1, 1, 1, width).getValues()[0] : [];
  const same = wantHeaders.length === cur.length && wantHeaders.every((h, i) => cur[i] === h);
  if (same) return sh;

  const parked = `${name}_OLD_${formatDate_(new Date())}`;
  if (ss.getSheetByName(parked)) ss.deleteSheet(ss.getSheetByName(parked));
  sh.setName(parked);
  const fresh = ss.insertSheet(name);
  fresh.appendRow(wantHeaders);
  fresh.setFrozenRows(1);
  return fresh;
}

// 시트를 {키 -> {row, vals}} 로 읽어 둔다. 누적할 때 기존 합계가 필요하다.
function readAggIndex_(sheet, keyCols) {
  const rows = sheet.getDataRange().getValues();
  const idx = {};
  for (let i = 1; i < rows.length; i++) {
    const key = keyCols.map((c) => String(rows[i][c])).join('|');
    if (!key.replace(/\|/g, '')) continue;
    idx[key] = { row: i + 1, vals: rows[i] };
  }
  return idx;
}

function rollupAndArchive() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const master = getOrCreateMaster(ss);
  const rows = master.getDataRange().getValues();
  const headers = rows.shift();
  const iDate = headers.indexOf('date');
  const iRating = headers.indexOf('rating');
  const iStore = headers.indexOf('store_name');
  if (!rows.length) return '집계할 데이터 없음';

  const today = formatDate_(new Date());
  const cutoff = addDays_(today, -RETENTION_DAYS);

  // 한 행을 합계로 접는다. 평균이 아니라 합계를 들고 있어야 나중에 정확히 더할 수 있다.
  function fold(bucket, r) {
    bucket.count++;
    const v = r[iRating];
    if (v !== '' && v != null && !isNaN(Number(v))) {
      bucket.rated++;
      bucket.rating_sum += Number(v);
      if (Number(v) <= 3) bucket.crit++;
    }
  }
  const blank = () => ({ count: 0, rated: 0, rating_sum: 0, crit: 0 });

  const daily = {};   // "date|brand"
  const monthly = {}; // "month|brand|store"
  rows.forEach((r) => {
    const d = formatDate_(r[iDate]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return; // 날짜가 아닌 값은 집계에서 뺀다
    const store = String(r[iStore] || '');
    const brand = brandOf_(store);

    const dk = d + '|' + brand;
    (daily[dk] = daily[dk] || blank()) && fold(daily[dk], r);

    const mk = d.slice(0, 7) + '|' + brand + '|' + store;
    (monthly[mk] = monthly[mk] || blank()) && fold(monthly[mk], r);
  });

  const dailySheet = ensureAggSheet_(ss, DAILY_AGG_SHEET_NAME, DAILY_AGG_HEADERS);
  const monthlySheet = ensureAggSheet_(ss, MONTHLY_STORE_AGG_SHEET, MONTHLY_AGG_HEADERS);

  const stats = { dailyNew: 0, dailySet: 0, dailyAdd: 0, monthlyTouched: 0 };

  /**
   * 보관 기간 안쪽 날짜는 MASTER에 그날 전체가 있으므로 계산값으로 덮어쓴다(set).
   * 보관 기간을 지난 날짜는 MASTER에 뒤늦게 들어온 일부만 있으므로 기존 값에 더한다(add).
   * 이 구분이 이번 수정의 핵심이다.
   */
  function flush(sheet, index, buckets, keyLen, sealedFn) {
    const updates = [], appends = [];
    Object.keys(buckets).forEach((key) => {
      const b = buckets[key];
      const parts = key.split('|');
      const prev = index[key];
      let count = b.count, rated = b.rated, sum = b.rating_sum, crit = b.crit;

      if (prev && sealedFn(parts)) {
        count += Number(prev.vals[keyLen]) || 0;
        rated += Number(prev.vals[keyLen + 1]) || 0;
        sum += Number(prev.vals[keyLen + 2]) || 0;
        crit += Number(prev.vals[keyLen + 3]) || 0;
        stats.dailyAdd++;
      } else if (prev) {
        stats.dailySet++;
      } else {
        stats.dailyNew++;
      }

      const avg = rated ? Number((sum / rated).toFixed(2)) : '';
      const cr = rated ? Number((crit / rated * 100).toFixed(1)) : '';
      const line = parts.concat([count, rated, Number(sum.toFixed(2)), crit, avg, cr]);
      if (prev) updates.push({ row: prev.row, line: line });
      else appends.push(line);
    });

    // 한 줄씩 쓰면 API 호출이 행 수만큼 난다. 이어진 구간은 묶어서 쓴다.
    updates.sort((a, b) => a.row - b.row);
    let i = 0;
    while (i < updates.length) {
      let j = i;
      while (j + 1 < updates.length && updates[j + 1].row === updates[j].row + 1) j++;
      const block = updates.slice(i, j + 1).map((u) => u.line);
      sheet.getRange(updates[i].row, 1, block.length, block[0].length).setValues(block);
      i = j + 1;
    }
    if (appends.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, appends[0].length).setValues(appends);
    }
    return updates.length + appends.length;
  }

  flush(dailySheet, readAggIndex_(dailySheet, [0, 1]), daily, 2, (parts) => parts[0] < cutoff);
  stats.monthlyTouched = flush(
    monthlySheet, readAggIndex_(monthlySheet, [0, 1, 2]), monthly, 3,
    // 그 달 전체가 보관 기간을 벗어났을 때만 누적으로 본다. 이번 달은 계속 덮어쓴다.
    (parts) => (parts[0] + '-31') < cutoff
  );

  // 보관 기간을 지난 원문은 ARCHIVE_VOC로 옮기고 MASTER_VOC에서 뺀다.
  const keepRows = [], archiveRows = [];
  rows.forEach((r) => { (formatDate_(r[iDate]) < cutoff ? archiveRows : keepRows).push(r); });

  if (archiveRows.length) {
    const archiveSheet = ss.getSheetByName(ARCHIVE_SHEET_NAME) || (() => {
      const s = ss.insertSheet(ARCHIVE_SHEET_NAME);
      s.appendRow(HEADERS);
      return s;
    })();
    ensureHeaders_(archiveSheet);
    archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, archiveRows.length, HEADERS.length).setValues(archiveRows);

    master.getRange(2, 1, master.getLastRow() - 1, HEADERS.length).clearContent();
    if (keepRows.length) master.getRange(2, 1, keepRows.length, HEADERS.length).setValues(keepRows);
  }

  return `일별집계 신규 ${stats.dailyNew} / 갱신 ${stats.dailySet} / 누적 ${stats.dailyAdd}`
    + ` · 월별매장집계 ${stats.monthlyTouched}행`
    + ` · 아카이브 ${archiveRows.length}건 (기준일 이전: ${cutoff})`;
}

/* =========================================================
 * 매일 자동 실행
 * ========================================================= */
function syncAll() {
  // 소셜은 볼륨이 작고 수집이 주 1회라 매일 돌려도 대부분 "데이터 없음"으로 끝난다. 비용이 거의 없어 같이 둔다.
  const results = [syncCommentmong(), syncQrSurvey(), syncFranchiseInquiry(), syncSocialMentions(), rollupAndArchive()];
  // 마지막 성공 시각을 남겨서 대시보드 상단에 표시한다. 자료가 안 들어온 걸 모르고
  // 어제 숫자로 회의하는 조용한 실패를 막는 용도다.
  PropertiesService.getScriptProperties()
    .setProperty('LAST_SYNC_AT', Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'));
  Logger.log(results.join('\n'));
  return results;
}

function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncAll').timeBased().everyDays(1).atHour(11).create();
  return '매일 오전 11시(서버 시간대 기준) 자동 실행 트리거 등록 완료';
}

/* =========================================================
 * 헬퍼
 * ========================================================= */

/**
 * MASTER_VOC에 이미 들어있는 voc_id 목록 (중복 반영 방지용).
 *
 * ⚠️ 이 함수가 따로 있는 이유 — 최초 실행에서만 터지던 버그:
 *   헤더만 있는 빈 시트는 getLastRow()가 1이라 (1-1)=0이 되고,
 *   getRange(2, 1, 0, 1)은 "The number of rows in the range must be at least 1" 예외를 던진다.
 *   Math.max(..., 0)로 감싸도 0은 여전히 유효하지 않은 행 수라 막지 못했다.
 *   데이터가 한 줄이라도 있으면 정상 동작해서, 첫 실행 때만 드러나는 종류의 버그였다.
 */
function readVocIds_(master) {
  const lastRow = master.getLastRow();
  if (lastRow < 2) return []; // 헤더만 있음 = 기존 데이터 없음
  return master.getRange(2, 1, lastRow - 1, 1).getValues().flat();
}

// 자바스크립트가 정수를 정확히 담을 수 있는 최대값. 이걸 넘으면 자릿수가 실제로 날아간다.
const MAX_EXACT_INT = 9007199254740991;

/**
 * 리뷰ID를 믿을 수 있는 문자열로 바꾼다. 이미 망가진 값은 받지 않는다.
 *
 * 시트가 큰 숫자를 2.02608E+15처럼 보여주는 것은 표시 형식일 뿐이고 저장된 값은 온전하다.
 * 배민 리뷰ID는 16자리(약 2.0×10^15)로 위 최대값 안에 들어오므로 그대로 써도 된다.
 * 진짜로 못 믿을 경우는 둘뿐이다.
 *   1. 셀 값이 지수 표기 "문자열"로 들어온 경우 (텍스트로 붙여넣다 깨진 것)
 *   2. 숫자가 정확히 담을 수 있는 범위를 넘은 경우 (이때는 실제로 뒷자리가 날아간다)
 *
 * 예전 판은 String(값)에 정규식을 걸었는데, 숫자로 들어오면 "2026080000000000"처럼
 * e+ 표기가 없어서 하나도 못 잡았다. 조용히 틀린 ID가 통과했다.
 */
function safeIdString_(v) {
  if (typeof v === 'number') {
    if (!isFinite(v)) return { ok: false, reason: '숫자가 아님', shown: String(v) };
    if (Math.floor(v) !== v) return { ok: false, reason: '정수가 아님', shown: String(v) };
    if (Math.abs(v) > MAX_EXACT_INT) return { ok: false, reason: '자릿수 소실', shown: String(v) };
    return { ok: true, value: String(v) };
  }
  const s = String(v).trim();
  if (!s) return { ok: false, reason: '빈 값', shown: '' };
  if (/e\+?\d+$/i.test(s)) return { ok: false, reason: '지수표기 문자열', shown: s };
  return { ok: true, value: s };
}

function sentimentFromRating_(rating) {
  if (rating == null) return '중립';
  if (rating >= 4) return '긍정';
  if (rating === 3) return '중립';
  return '부정';
}

// 원본에 고유ID가 없는 소스(가맹점문의 등)를 위한 결정적 해시 ID — 같은 내용 재붙여넣기해도 중복되지 않음
function makeId_(prefix, parts) {
  const raw = parts.join('|');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  const hex = digest.map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('').slice(0, 10);
  return `${prefix}-${hex}`;
}

function formatDate_(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd');
}

function addDays_(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return formatDate_(d);
}

// 매우 단순한 키워드 매칭 — 정확도 낮음, 임시 로직 (추후 수기 태깅/정교한 분류로 교체 권장)
function categorize_(text) {
  const rules = [
    { cat: 'process', kws: ['배달', '지연', '포장', '늦', '파손', '대기'] },
    { cat: 'people', kws: ['친절', '응대', '직원', '사장님', '불친절'] },
    { cat: 'price', kws: ['가격', '가성비', '비싸', '저렴'] },
    { cat: 'place', kws: ['매장', '청결', '주차', '위생'] },
    { cat: 'promotion', kws: ['프로모션', '이벤트', '할인', '쿠폰'] },
  ];
  for (const r of rules) {
    if (r.kws.some((k) => text.includes(k))) return r.cat;
  }
  return 'product';
}

function extractKeyword_(text) {
  // 임시 placeholder: 텍스트 앞부분을 그대로 노출. 실제 키워드 추출 로직으로 교체 필요.
  return text.length > 14 ? text.slice(0, 14) + '…' : text;
}
