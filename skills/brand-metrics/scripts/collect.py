#!/usr/bin/env python3
"""
인생푸드 3개 브랜드 주차별 포털 지표 수집기.

매주 1회 실행하면 data/weekly_metrics.csv 에 그 주차 값이 append 된다.
같은 (week_start, brand_id, metric_key)가 이미 있으면 최신값으로 덮어쓴다.

필요 환경변수:
  NAVER_CLIENT_ID, NAVER_CLIENT_SECRET   -- 네이버 개발자센터 오픈API (무료)

사용:
  python collect.py                 # 52주 소급 + 이번 주 스냅샷
  python collect.py --weeks 8       # 최근 8주만 갱신
  python collect.py --dry-run       # 호출만 하고 파일은 안 씀
"""
import argparse, csv, json, os, re, sys, time, urllib.parse, urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
CONF = os.path.join(HERE, "keywords.json")
OUT = os.path.join(HERE, "data", "weekly_metrics.csv")
COLS = ["week_start", "brand_id", "brand", "portal", "metric_key", "value",
        "unit", "kind", "note", "collected_at"]

CID = os.environ.get("NAVER_CLIENT_ID", "")
CSEC = os.environ.get("NAVER_CLIENT_SECRET", "")


# ---------- 공통 ----------

def monday(d):
    return d - timedelta(days=d.weekday())


def api(url, body=None):
    """네이버 오픈API 호출. body가 있으면 POST(JSON), 없으면 GET."""
    req = urllib.request.Request(url)
    req.add_header("X-Naver-Client-Id", CID)
    req.add_header("X-Naver-Client-Secret", CSEC)
    data = None
    if body is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode("utf-8")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, data, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            if attempt == 2:
                print("  ! 실패: %s %s" % (url[:70], e), file=sys.stderr)
                return None
            time.sleep(2 ** attempt)


def strip_tags(s):
    return re.sub(r"<[^>]+>", "", s or "")


# ---------- 1층. 검색 수요 (데이터랩) ----------

def datalab_daily(groups, start, end):
    """일 단위로 받아 주차로 롤업. 한 번의 호출 = 하나의 공통 스케일."""
    body = {"startDate": start.isoformat(), "endDate": end.isoformat(),
            "timeUnit": "date",
            "keywordGroups": [{"groupName": g["id"], "keywords": g["keywords"]}
                              for g in groups[:5]]}
    res = api("https://openapi.naver.com/v1/datalab/search", body)
    if not res:
        return {}
    out = {}
    for r in res.get("results", []):
        weeks = defaultdict(list)
        for pt in r["data"]:
            d = datetime.strptime(pt["period"], "%Y-%m-%d").date()
            weeks[monday(d)].append(pt["ratio"])
        out[r["title"]] = dict(weeks)
    return out


def anchored(weekly, anchor_n=4):
    """첫 anchor_n주 평균을 100으로 고정. 매주 재실행해도 값이 흔들리지 않게."""
    ks = sorted(weekly)
    if not ks:
        return {}
    base_vals = [sum(weekly[k]) / len(weekly[k]) for k in ks[:anchor_n]]
    base = sum(base_vals) / len(base_vals) if base_vals else 0
    if base <= 0:
        return {}
    res = {}
    for k in ks:
        vals = weekly[k]
        res[k] = {"avg": round(sum(vals) / len(vals) / base * 100, 2),
                  "peak": round(max(vals) / base * 100, 2),
                  "days": len(vals)}
    return res


# ---------- 2층. 콘텐츠·평판 (검색 문서) ----------

def search_docs(kind, query, want=1000):
    """blog/cafearticle/kin/news/webkr/local 문서 수집. total과 원문 목록을 함께."""
    items, total = [], 0
    per = 100 if kind in ("blog", "cafearticle", "kin", "news", "webkr") else 5
    sort = "date" if kind in ("blog", "news") else "sim"
    for start in range(1, want + 1, per):
        if start > 1000:
            break
        url = ("https://openapi.naver.com/v1/search/%s.json?query=%s&display=%d&start=%d&sort=%s"
               % (kind, urllib.parse.quote(query), per, start, sort))
        res = api(url)
        if not res:
            break
        total = res.get("total", total)
        got = res.get("items", [])
        items += got
        if len(got) < per:
            break
        time.sleep(0.1)
    return total, items


def is_ours(item, brand):
    """네이버 검색은 따옴표 정확일치를 지원하지 않는다. 그래서 후처리로 거른다."""
    text = strip_tags(item.get("title", "")) + " " + strip_tags(item.get("description", ""))
    if not any(k in text for k in brand["include_any"]):
        return False
    return not any(k in text for k in brand["exclude_any"])


def weekly_posts(items, brand, date_field):
    """발행일이 있는 채널(blog/news)만 주차별 발행량 산출."""
    buckets = defaultdict(int)
    for it in items:
        if not is_ours(it, brand):
            continue
        raw = it.get(date_field, "")
        try:
            if date_field == "postdate":
                d = datetime.strptime(raw, "%Y%m%d").date()
            else:
                d = datetime.strptime(raw[5:16], "%d %b %Y").date()
        except Exception:
            continue
        buckets[monday(d)] += 1
    return buckets


# ---------- 기록 ----------

class Sink:
    """kind: flow=그 주차에 발생한 양, stock=그 시점 누적 스냅샷"""

    def __init__(self):
        self.rows = []

    def add(self, week, brand_id, brand, portal, key, value, unit, kind, note=""):
        self.rows.append({
            "week_start": week.isoformat() if hasattr(week, "isoformat") else week,
            "brand_id": brand_id, "brand": brand, "portal": portal,
            "metric_key": key, "value": value, "unit": unit, "kind": kind,
            "note": note, "collected_at": date.today().isoformat()})


def merge_write(rows, path):
    old = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                old[(r["week_start"], r["brand_id"], r["metric_key"])] = r
    for r in rows:
        old[(r["week_start"], r["brand_id"], r["metric_key"])] = r
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        for k in sorted(old):
            w.writerow({c: old[k].get(c, "") for c in COLS})
    return len(old)


# ---------- 메인 ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weeks", type=int, default=52, help="소급 주차 수")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if not CID or not CSEC:
        sys.exit("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수를 먼저 설정하세요.")

    conf = json.load(open(CONF, encoding="utf-8"))
    brands = conf["brands"]
    this_week = monday(date.today())
    end = this_week - timedelta(days=1)            # 지난주 일요일까지가 확정 구간
    start = this_week - timedelta(weeks=a.weeks)
    s = Sink()
    print("수집 구간 %s ~ %s (%d주)" % (start, end, a.weeks))

    # --- A. 브랜드 검색 수요: 3개를 한 호출로 묶어 공통 스케일 확보
    print("[A] 데이터랩 브랜드 검색지수")
    groups = [{"id": b["id"], "keywords": b["datalab_keywords"]} for b in brands]
    raw = datalab_daily(groups, start, end)
    for b in brands:
        for wk, v in anchored(raw.get(b["id"], {})).items():
            s.add(wk, b["id"], b["name"], "naver", "search_index_avg", v["avg"], "index", "flow")
            s.add(wk, b["id"], b["name"], "naver", "search_index_peak", v["peak"], "index", "flow",
                  "일 최고. avg 대비 2배 넘으면 이벤트 의심")
            if v["days"] < 7:
                s.add(wk, b["id"], b["name"], "naver", "search_index_missing_days",
                      7 - v["days"], "days", "flow", "임계치 미만 결측일. 0으로 채우지 말 것")

    # --- A2. 창업 의도 검색 (가맹 리드 선행지표)
    print("[A2] 데이터랩 창업 의도")
    ig = [{"id": b["id"] + "_intent", "keywords": b["intent_keywords"]} for b in brands]
    raw = datalab_daily(ig, start, end)
    for b in brands:
        for wk, v in anchored(raw.get(b["id"] + "_intent", {})).items():
            s.add(wk, b["id"], b["name"], "naver", "startup_intent_index", v["avg"], "index", "flow")

    # --- A3. 시장 맥락 (브랜드와 스케일이 달라 따로 호출)
    print("[A3] 데이터랩 카테고리·시장")
    raw = datalab_daily(conf["context_groups"], start, end)
    for g in conf["context_groups"]:
        for wk, v in anchored(raw.get(g["id"], {})).items():
            s.add(wk, "_market", g["name"], "naver", "ctx_" + g["id"], v["avg"], "index", "flow")

    # --- B. 콘텐츠 발행량 + 재고량
    print("[B] 검색 문서(블로그/카페/지식iN/뉴스/웹)")
    for b in brands:
        q = b["doc_query"]
        for kind, field in (("blog", "postdate"), ("news", "pubDate")):
            total, items = search_docs(kind, q, want=1000)
            ours = [i for i in items if is_ours(i, b)]
            noise = 1 - (len(ours) / len(items)) if items else 0
            s.add(this_week, b["id"], b["name"], "naver", kind + "_total_raw", total, "docs", "stock",
                  "필터 전. 표본 노이즈율 %.0f%%" % (noise * 100))
            s.add(this_week, b["id"], b["name"], "naver", kind + "_noise_rate",
                  round(noise, 3), "ratio", "stock", "0.3 넘으면 키워드 재정의 필요")
            for wk, n in weekly_posts(items, b, field).items():
                if start <= wk <= end:
                    s.add(wk, b["id"], b["name"], "naver", kind + "_posts", n, "docs", "flow")
        for kind in ("cafearticle", "kin", "webkr"):
            total, items = search_docs(kind, q, want=100)
            ours = [i for i in items if is_ours(i, b)]
            rate = (len(ours) / len(items)) if items else 0
            s.add(this_week, b["id"], b["name"], "naver", kind + "_total_raw", total, "docs", "stock")
            s.add(this_week, b["id"], b["name"], "naver", kind + "_total_adj",
                  int(total * rate), "docs", "stock", "표본 적중률 %.0f%% 적용 추정치" % (rate * 100))

    # --- C. 매장 수 스냅샷
    print("[C] 네이버 지역")
    for b in brands:
        total, _ = search_docs("local", b["doc_query"], want=5)
        s.add(this_week, b["id"], b["name"], "naver", "place_count_raw", total, "stores", "stock",
              "지역API는 최대 5건만 반환. 정확한 매장 수는 사내 대장으로 대체")

    print("\n생성 행 %d건" % len(s.rows))
    if a.dry_run:
        for r in s.rows[:15]:
            print(r)
        return
    n = merge_write(s.rows, OUT)
    print("저장 완료 %s (누적 %d행)" % (OUT, n))


if __name__ == "__main__":
    main()
