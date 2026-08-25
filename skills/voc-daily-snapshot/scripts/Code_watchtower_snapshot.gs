/**
 * WATCHTOWER 스냅샷 — Code.gs 맨 아래에 이어 붙이세요 (별도 파일로 추가해도 됩니다)
 *
 * 왜 필요한가:
 *   WATCHTOWER 에이전트가 MASTER_VOC 전체(90일치 수만 행)를 통째로 읽으면 무겁고 잘립니다.
 *   그래서 Apps Script가 미리 계산해 WATCHTOWER_SNAPSHOT 시트에 6줄로 요약해두고,
 *   에이전트는 그 작은 시트만 읽습니다.
 *
 * 설치:
 *   1. 이 코드를 붙여넣고 저장
 *   2. buildWatchtowerSnapshot() 한 번 실행 → WATCHTOWER_SNAPSHOT 시트 생성 확인
 *   3. setupWatchtowerTrigger() 한 번 실행 → 매일 07:30 자동 갱신 (WATCHTOWER 08:00 실행 전에 끝나도록)
 *
 * 개인정보:
 *   매장명까지만 기록합니다. 리뷰 원문·점주 실명·연락처는 이 시트에 절대 넣지 않습니다.
 */

const WT_SNAPSHOT_SHEET = 'WATCHTOWER_SNAPSHOT';
const WT_DIAG_SHEET = 'WATCHTOWER_DIAG';

/**
 * WATCHTOWER 전용 외부 스프레드시트.
 *
 * 왜 별도 파일인가:
 *   에이전트는 Drive 커넥터로 시트를 읽는데, 커넥터는 파일 앞쪽부터 일정 용량까지만 추출한다.
 *   VOC 마스터 파일은 MASTER_VOC만으로 그 한도를 넘겨서, 같은 파일에 둔 스냅샷은
 *   리뷰가 쌓일수록 읽기 범위 밖으로 밀려난다(2026-08-20 실제로 발생).
 *   탭을 앞으로 옮기는 것만으로는 언젠가 또 터지므로, 아예 작은 파일로 분리한다.
 *
 * 파일 ID는 스크립트 속성에 저장되어 재생성되지 않는다.
 */
const WT_DATA_FILE_NAME = 'WATCHTOWER_DATA';

function wtDataFile_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('WT_DATA_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* 지워졌으면 아래에서 새로 만든다 */ }
  }
  const ss = SpreadsheetApp.create(WT_DATA_FILE_NAME);
  props.setProperty('WT_DATA_ID', ss.getId());
  Logger.log('WATCHTOWER_DATA 새로 생성: ' + ss.getUrl());
  return ss;
}

/** 외부 파일의 시트 하나를 통째로 덮어쓴다. */
function wtWriteExternal_(sheetName, rows) {
  const ss = wtDataFile_();
  let sh = ss.getSheetByName(sheetName);
  if (!sh) sh = ss.insertSheet(sheetName);
  sh.clear();
  if (rows.length) sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  // 기본 생성되는 '시트1'은 비어 있으면 지운다
  const blank = ss.getSheetByName('시트1') || ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  return ss.getUrl();
}

/**
 * 플랫폼별 별점 만점. 여기 없는 플랫폼은 5점 만점으로 본다.
 * 네이버는 플레이스 점수라 100점 만점으로 들어온다(2026-08-20 확인).
 * 새 플랫폼이 추가되면 여기만 고치면 된다.
 */
const RATING_SCALE = {
  '네이버': 100,
};

/**
 * 어떤 척도로 들어온 별점이든 1~5 정수로 환산한다.
 * 해당 플랫폼의 만점을 넘는 값은 오류값으로 보고 null(평점 없음)로 버린다.
 *   예) 땡겨요는 5점 만점인데 99가 들어온 9건이 있었다(2026-08-20).
 *       같은 플랫폼의 나머지 264건이 2~5 범위라 척도가 다른 게 아니라 오류값이다.
 *       이런 값을 억지로 환산하면 없는 만점 리뷰를 만들어낸다.
 */
function toFiveScale_(rating, platform) {
  const n = Number(rating);
  if (isNaN(n) || n <= 0) return null;
  const max = RATING_SCALE[String(platform).trim()] || 5;

  // ⚠️ 멱등성 — 이 함수는 몇 번을 돌려도 같은 결과여야 한다.
  //   2026-08-20에 이 가드가 없어서 사고가 났다: fixRatingScales를 두 번 실행하자
  //   이미 5점으로 환산된 네이버 값(평균 4.15)을 다시 100으로 나눠 전부 1점으로 뭉갰다.
  //   그래서 "이미 5점 척도 범위 안에 있는 값"은 손대지 않는다.
  //   대가: 100점 만점에서 5점 이하로 받은 리뷰는 환산되지 않고 그대로 남는다.
  //   (100점 만점에 5점 이하는 실무상 거의 없고, 있어도 이미 최저점이라 판정이 뒤집히지 않는다.
  //    두 번 돌렸을 때 데이터가 망가지는 위험이 이 오차보다 훨씬 크다.)
  if (n <= 5) return n;

  if (n > max) return null;                      // 만점 초과 = 오류값, 버린다
  const v = Math.round((n / max) * 5);
  return Math.min(5, Math.max(1, v));            // 1~5로 클램프
}
const WT_BRANDS = ['인생아구찜', '삼대미역', '어화락'];
const WT_WINDOWS = [['48h', 2], ['7d', 7]];

/**
 * 배달앱 신호에서 제외할 플랫폼.
 *
 * 네이버 — 두 가지 이유로 뺀다.
 *   1. 배달앱이 아니라 플레이스(장소) 리뷰다. 배달 주문 경험이 아니라 방문·검색 맥락이라
 *      "배달앱 평판" 지표에 섞이면 신호의 의미가 흐려진다.
 *   2. 2026-08-20 별점 척도 교정 중 137건(MASTER 89 + ARCHIVE 48)이 1점으로 손상됐다.
 *      복구되지 않은 상태라 그대로 쓰면 없는 부정 리뷰를 만들어낸다.
 * 나중에 네이버를 따로 보고 싶으면 별도 채널로 분리하는 게 맞다.
 */
const WT_EXCLUDE_PLATFORMS = ['네이버'];
// 응대완료로 인정하는 리뷰상태 값. 댓글몽 표기가 바뀌면 여기만 고치세요.
const WT_ANSWERED_VALUES = ['답변완료', '답변', '완료'];

function buildWatchtowerSnapshot() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const master = ss.getSheetByName(MASTER_SHEET_NAME);
  if (!master) throw new Error(`${MASTER_SHEET_NAME} 시트가 없습니다 — setupSheets()를 먼저 실행하세요`);

  const rows = master.getDataRange().getValues();
  const headers = rows.shift();
  const idx = (h) => {
    const i = headers.indexOf(h);
    if (i < 0) throw new Error(`MASTER_VOC 헤더에 '${h}' 컬럼이 없습니다 — 스키마가 바뀌었는지 확인하세요`);
    return i;
  };
  const iSource = idx('source'), iStore = idx('store_name'), iDate = idx('date');
  const iSent = idx('sentiment'), iResp = idx('response_status'), iRating = idx('rating');
  const iPlat = idx('platform');

  const todayStr = formatDate_(new Date());
  // 날짜만 찍으면 하루 안에 여러 번 돌렸을 때 갱신됐는지 알 수가 없다 — 시각까지 남긴다.
  const stampStr = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  const out = [['updated_at', 'brand', 'window', 'total', 'neg', 'unanswered', 'top_store_neg', 'avg_rating', 'status_distinct']];

  WT_WINDOWS.forEach(function (w) {
    const label = w[0], days = w[1];
    const cutoff = addDays_(todayStr, -days);

    WT_BRANDS.forEach(function (brand) {
      // 배달앱 리뷰만. 점주VOC·발주고·QR설문이 섞이면 배달앱 신호가 오염됩니다.
      const sel = rows.filter(function (r) {
        return r[iSource] === '배달앱리뷰'
          && WT_EXCLUDE_PLATFORMS.indexOf(String(r[iPlat]).trim()) === -1
          && String(r[iStore]).indexOf(brand) === 0
          && formatDate_(r[iDate]) >= cutoff;
      });

      const neg = sel.filter(function (r) { return r[iSent] === '부정'; });
      // 응대완료로 인정하는 값이 아니면 미응대로 본다(공란 포함) — 방치가 확산 위험을 키우므로 보수적으로 집계
      const unanswered = neg.filter(function (r) {
        return WT_ANSWERED_VALUES.indexOf(String(r[iResp]).trim()) === -1;
      });

      // 응대상태 필드의 변별력 검사.
      // 2026-08-20 실측: 댓글몽 엑셀 122행의 '리뷰상태'가 전부 '미답변' 한 값뿐이었다.
      // 한 값만 있는 필드는 정보가 없다 — 그걸로 ★을 올리면 모든 브랜드가 근거 없이 위험해 보인다.
      // 그래서 고유값 개수를 같이 기록하고, 1 이하면 WATCHTOWER가 미응대 보정을 건너뛴다(AGENT.md 2-2d).
      const statusSet = {};
      sel.forEach(function (r) { statusSet[String(r[iResp]).trim()] = 1; });
      const statusDistinct = Object.keys(statusSet).length;

      // 같은 매장에서 부정이 몇 건까지 반복됐나 (3건 이상이면 WATCHTOWER가 ★5로 본다)
      const byStore = {};
      neg.forEach(function (r) {
        const s = String(r[iStore]);
        byStore[s] = (byStore[s] || 0) + 1;
      });
      const counts = Object.keys(byStore).map(function (k) { return byStore[k]; });
      const topStoreNeg = counts.length ? Math.max.apply(null, counts) : 0;

      const ratings = sel.map(function (r) { return Number(r[iRating]); }).filter(function (n) { return !isNaN(n) && n > 0; });
      const avg = ratings.length
        ? Math.round((ratings.reduce(function (a, b) { return a + b; }, 0) / ratings.length) * 100) / 100
        : '';

      out.push([stampStr, brand, label, sel.length, neg.length, unanswered.length, topStoreNeg, avg, statusDistinct]);
    });
  });

  let sh = ss.getSheetByName(WT_SNAPSHOT_SHEET);
  if (!sh) sh = ss.insertSheet(WT_SNAPSHOT_SHEET);
  sh.clear();
  sh.getRange(1, 1, out.length, out[0].length).setValues(out);
  sh.setFrozenRows(1);

  // ⚠️ 반드시 첫 번째 탭으로 옮긴다.
  // WATCHTOWER는 Drive 커넥터로 이 스프레드시트를 읽는데, 커넥터는 앞쪽부터 약 139KB까지만 추출한다.
  // MASTER_VOC가 커질수록 뒤쪽 시트는 읽기 범위 밖으로 밀려나고, 그러면 에이전트가 스냅샷을
  // "없는 것"으로 보게 된다 — 데이터는 멀쩡한데 리포트만 조용히 비는 최악의 실패다.
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(1);

  // 에이전트가 실제로 읽는 곳은 외부 파일이다 (위 wtDataFile_ 주석 참고)
  const url = wtWriteExternal_(WT_SNAPSHOT_SHEET, out);

  return `WATCHTOWER 스냅샷 갱신 완료 — ${out.length - 1}행 (${stampStr} 기준, 네이버 제외)\n외부 파일: ${url}`;
}

/**
 * 매일 07:30 자동 갱신. WATCHTOWER 일간 실행(08:00)보다 먼저 끝나도록 잡았습니다.
 * syncAll()이 먼저 돌아야 최신 리뷰가 반영되므로, syncAll → 스냅샷 순서로 실행합니다.
 */
function setupWatchtowerTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncAllThenSnapshot') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncAllThenSnapshot').timeBased().atHour(7).nearMinute(30).everyDays(1).create();
  return '매일 오전 7시30분경 syncAll + 스냅샷 자동 실행 트리거 등록 완료';
}

function syncAllThenSnapshot() {
  try {
    syncAll();
  } catch (err) {
    // 동기화가 실패해도 스냅샷은 기존 데이터로라도 갱신한다 — 다만 실패 사실을 로그에 남긴다
    console.error('syncAll 실패: ' + err.message);
  }
  return buildWatchtowerSnapshot();
}

/* =========================================================
 * 별점 척도 교정 — 진단 + 수정을 한 번에 (일회성)
 *
 * 하는 일:
 *   1. MASTER_VOC / ARCHIVE_VOC 의 플랫폼별 별점 분포를 '수정 전' 상태로 기록
 *   2. RATING_SCALE에 등록된 플랫폼(현재 네이버=100점)의 별점을 1~5로 환산
 *   3. 환산된 별점으로 sentiment(긍정/중립/부정)를 다시 계산해 덮어씀
 *   4. '수정 후' 분포를 기록하고 WATCHTOWER_DIAG 시트에 전부 남김
 *
 * ⚠️ MASTER_VOC의 rating·sentiment 값을 실제로 바꿉니다.
 *    최근 데이터는 RAW_댓글몽에 원본이 남아 있어 syncCommentmong으로 복구 가능하지만,
 *    ARCHIVE_VOC는 원본이 없으니 되돌릴 수 없습니다. 실행 전 시트 사본을 떠두길 권합니다.
 *    (파일 > 사본 만들기)
 *
 * 실행 후 buildWatchtowerSnapshot() 을 한 번 더 돌려야 스냅샷에 반영됩니다.
 * ========================================================= */
function fixRatingScales() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const report = [];
  let totalChanged = 0;

  function platStats(rows, iP, iR) {
    const by = {};
    rows.forEach(function (r) {
      const p = String(r[iP] || '(공란)');
      const n = Number(r[iR]);
      if (!by[p]) by[p] = { n: 0, blank: 0, min: Infinity, max: -Infinity, sum: 0 };
      const b = by[p];
      if (r[iR] === '' || r[iR] == null || isNaN(n)) { b.blank++; return; }
      b.n++; b.sum += n;
      if (n < b.min) b.min = n;
      if (n > b.max) b.max = n;
    });
    return by;
  }

  function renderStats(by, indent) {
    Object.keys(by).sort().forEach(function (p) {
      const b = by[p];
      const avg = b.n ? Math.round((b.sum / b.n) * 100) / 100 : '-';
      const range = b.n ? b.min + '~' + b.max : '-';
      const scale = RATING_SCALE[p] || 5;
      const flag = b.max > 5 ? '   ⚠️ 5점 초과 (등록 만점 ' + scale + ')' : '';
      report.push(indent + p + ': ' + b.n + '건(공란 ' + b.blank + ') 범위 ' + range + ' 평균 ' + avg + flag);
    });
  }

  [MASTER_SHEET_NAME, ARCHIVE_SHEET_NAME].forEach(function (sheetName) {
    const sh = ss.getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) { report.push(sheetName + ': 데이터 없음'); return; }

    const range = sh.getDataRange();
    const values = range.getValues();
    const h = values[0];
    const rows = values.slice(1);
    const iR = h.indexOf('rating'), iP = h.indexOf('platform'), iS = h.indexOf('sentiment');
    if (iR < 0 || iP < 0 || iS < 0) { report.push(sheetName + ': rating/platform/sentiment 컬럼을 못 찾음'); return; }

    report.push('');
    report.push('■ ' + sheetName + ' (' + rows.length + '행)');
    report.push('  ── 수정 전 ──');
    renderStats(platStats(rows, iP, iR), '   ');

    let changed = 0, voided = 0;
    const changedBy = {}, voidedBy = {};
    rows.forEach(function (r) {
      const before = Number(r[iR]);
      if (r[iR] === '' || r[iR] == null || isNaN(before)) return; // 원래 공란이면 건드리지 않는다
      const after = toFiveScale_(before, r[iP]);
      const p = String(r[iP]);
      if (after == null) {
        // 플랫폼 만점을 넘는 오류값 — 평점 없음으로 버리고 sentiment는 중립 처리
        r[iR] = '';
        r[iS] = sentimentFromRating_(null);
        voided++;
        voidedBy[p] = (voidedBy[p] || 0) + 1;
      } else if (after !== before) {
        r[iR] = after;
        r[iS] = sentimentFromRating_(after);
        changed++;
        changedBy[p] = (changedBy[p] || 0) + 1;
      }
    });

    report.push('  ── 수정 후 ──');
    renderStats(platStats(rows, iP, iR), '   ');
    report.push('  환산한 행: ' + changed + '건 ' + JSON.stringify(changedBy));
    report.push('  오류값으로 버린 행: ' + voided + '건 ' + JSON.stringify(voidedBy));
    totalChanged += changed + voided;

    if (changed || voided) {
      range.setValues(values); // 헤더 포함 원본 그대로 다시 쓰기
      report.push('  → 시트에 반영 완료');
    } else {
      report.push('  → 바꿀 행 없음, 시트 미변경');
    }
  });

  report.unshift('환산 규칙: ' + JSON.stringify(RATING_SCALE) + ' (그 외 플랫폼은 5점 만점)');
  report.unshift('별점 척도 교정 실행: ' + formatDate_(new Date()));

  let sh = ss.getSheetByName(WT_DIAG_SHEET);
  if (!sh) sh = ss.insertSheet(WT_DIAG_SHEET);
  sh.clear();
  const outRows = report.map(function (line) { return [line]; });
  sh.getRange(1, 1, outRows.length, 1).setValues(outRows);
  sh.setColumnWidth(1, 900);
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(1);

  const url = wtWriteExternal_(WT_DIAG_SHEET, outRows);

  return '별점 교정 완료 — ' + totalChanged + '건 환산.\n외부 파일: ' + url + '\n이어서 buildWatchtowerSnapshot() 실행하세요.';
}

/* =========================================================
 * 진단 — 별점 이상치 추적 (읽기 전용, 수정하지 않음)
 *
 * 왜: 2026-08-20 스냅샷의 avg_rating이 5.68로 나왔다. 1~5점 척도에서 불가능한 값이다.
 *     sentimentFromRating_()이 별점으로 부정/긍정을 가르므로, 별점이 오염돼 있으면
 *     neg 건수와 그 위에 세워진 리스크 지수 전체를 믿을 수 없다.
 *     실행 후 [실행 로그]를 확인하세요.
 * ========================================================= */
function diagnoseRatings() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const report = [];

  [MASTER_SHEET_NAME, ARCHIVE_SHEET_NAME].forEach(function (sheetName) {
    const sh = ss.getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) { report.push(sheetName + ': 데이터 없음'); return; }

    const rows = sh.getDataRange().getValues();
    const h = rows.shift();
    const iR = h.indexOf('rating'), iS = h.indexOf('source'),
          iP = h.indexOf('platform'), iD = h.indexOf('date'),
          iN = h.indexOf('store_name');

    report.push('');
    report.push('■ ' + sheetName + ' (' + rows.length + '행)');

    // 플랫폼 × 별점 교차표 — "플랫폼마다 점수 척도가 다른가"를 바로 판정한다
    const byPlat = {};
    rows.forEach(function (r) {
      const plat = String(r[iP] || '(공란)');
      const n = Number(r[iR]);
      if (!byPlat[plat]) byPlat[plat] = { n: 0, blank: 0, min: Infinity, max: -Infinity, sum: 0, dist: {} };
      const b = byPlat[plat];
      if (r[iR] === '' || r[iR] == null || isNaN(n)) { b.blank++; return; }
      b.n++; b.sum += n;
      if (n < b.min) b.min = n;
      if (n > b.max) b.max = n;
      b.dist[n] = (b.dist[n] || 0) + 1;
    });

    report.push('  ── 플랫폼별 별점 범위 ──');
    Object.keys(byPlat).sort().forEach(function (plat) {
      const b = byPlat[plat];
      const avg = b.n ? Math.round((b.sum / b.n) * 100) / 100 : '-';
      const range = b.n ? b.min + '~' + b.max : '-';
      const flag = b.max > 5 ? '   ⚠️ 5점 초과' : '';
      report.push('   ' + plat + ': ' + b.n + '건(공란 ' + b.blank + ') 범위 ' + range + ' 평균 ' + avg + flag);
      report.push('       분포 ' + JSON.stringify(b.dist));
    });

    const bad = rows.filter(function (r) { return Number(r[iR]) > 5; });
    report.push('  별점 > 5 인 행: ' + bad.length + '건');
    if (bad.length) {
      const bySrc = {};
      bad.forEach(function (r) {
        const k = r[iS] + ' / ' + r[iP];
        bySrc[k] = (bySrc[k] || 0) + 1;
      });
      report.push('  소스/플랫폼별: ' + JSON.stringify(bySrc));
      report.push('  샘플 5건:');
      bad.slice(0, 5).forEach(function (r) {
        report.push('    ' + r[iS] + ' | ' + r[iP] + ' | ' + r[iD] + ' | ' + r[iN] + ' | rating=' + r[iR]);
      });
    }
  });

  const text = report.join('\n');
  Logger.log(text);

  // 실행 로그를 복사해 옮기는 수고를 덜기 위해 결과를 시트에도 그대로 쓴다.
  // WATCHTOWER가 Drive로 이 시트를 직접 읽는다.
  let sh = ss.getSheetByName(WT_DIAG_SHEET);
  if (!sh) sh = ss.insertSheet(WT_DIAG_SHEET);
  sh.clear();
  const outRows = report.map(function (line) { return [line]; });
  outRows.unshift(['진단 실행 시각: ' + formatDate_(new Date())]);
  sh.getRange(1, 1, outRows.length, 1).setValues(outRows);
  sh.setColumnWidth(1, 900);

  // 스냅샷과 같은 이유로 앞쪽에 둔다 (위 buildWatchtowerSnapshot 주석 참고)
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(1);

  return '진단 완료 — ' + WT_DIAG_SHEET + ' 시트에 기록했습니다 (' + report.length + '줄)';
}
