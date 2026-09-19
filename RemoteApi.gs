/**
 * RemoteApi.gs — 헤드리스 원격 제어 API (Phase 1)
 * 프로젝트: gas-project-audition (문항 검증)
 *
 * 맥미니의 `audit_runner`가 이 웹앱을 호출해 파이프라인을 조종한다.
 * UI 함수(`pv_start` 등)는 건드리지 않는다 — 코어(`pv_startCore_` 등)만 부른다.
 *
 * ── 배포 ─────────────────────────────────────────────────────────────
 *   웹앱 / 실행: 나(kimdeoksoo@gmail.com) / 액세스: 모든 사용자
 *
 * ⚠️⚠️ 코드를 고친 뒤에는 반드시 **배포 관리 → 연필(수정) → 버전: 새 버전 → 배포**.
 *      "새 배포"를 만들면 **URL이 바뀌고 옛 배포가 그대로 살아남는다.**
 *      러너는 저장해 둔 옛 URL을 계속 부르고, 옛 배포가 정상 응답하므로
 *      **에러 없이 옛 코드가 계속 돈다** — 무인 운영에서 가장 나쁜 고장이다.
 *      방어책으로 `VERSION`을 두었다. 러너는 기동 시 `cmd=ping`의 version을
 *      기대값과 대조해 불일치하면 즉시 알리고 멈춘다.
 *
 * ── 인증 ─────────────────────────────────────────────────────────────
 *   스크립트 속성 `REMOTE_TOKEN`(32자 이상 난수)과 쿼리 파라미터 `token` 비교.
 *   불일치 시 **빈 200 응답** — 엔드포인트의 존재 자체를 드러내지 않는다 (C7).
 */

const RAPI = {
  VERSION:     'audition-1.0.2',        // 배포 대조용. 코드 변경 시 올린다
  PROJECT:     'audition',
  TOKEN_PROP:  'REMOTE_TOKEN',
  LOG_TAIL:    20,                      // status가 돌려줄 Pipeline_Log 최대 행수

  // ⏸️ C6 내구성 판정(2026-09-26) 전까지 비활성.
  //    D안 확정 시 true로 바꾸면 러너가 Drive·Sheets REST를 직접 쓸 수 있다.
  //    E안(rclone)으로 가면 이 엔드포인트는 영영 필요 없다.
  ENABLE_DRIVETOKEN: false,
};

/* =================================================
 * 진입점
 * ================================================= */

/**
 * 웹앱 GET 라우터.
 *
 * ⚠️ GAS는 프로젝트당 `doGet`이 하나뿐이다. 기존 ErrorViewer의 `doGet`은
 *    `ev_render_()`로 이름만 옮겼다.
 * ⚠️ **토큰 없는 요청은 `cmd`가 없어도 전부 빈 200.** (2026-09-19 변경)
 *    이 웹앱은 "모든 사용자"로 배포되므로, 토큰 없이 뷰어를 열어 주면 URL을 아는
 *    누구나 검증 데이터를 볼 수 있다. 뷰어 웹앱은 배포된 적이 없고(덕수님 확인),
 *    메뉴의 오류 뷰어는 `openErrorViewer()` 팝업이라 이 경로와 무관하다.
 */
function doGet(e) {
  const p = (e && e.parameter) || {};

  if (!rapi_auth_(p.token)) return ContentService.createTextOutput('');   // C7: 빈 200

  try {
    switch (p.cmd) {
      case 'ping':        return rapi_json_(rapi_ping_());
      case 'start':       return rapi_json_(rapi_start_(p));
      case 'status':      return rapi_json_(rapi_status_());
      case 'stop':        return rapi_json_(pv_stopCore_('원격 중지 (RemoteApi)'));
      case 'resume':      return rapi_json_(pv_resumeCore_({ deferTick: true, by: '원격 이어하기 (RemoteApi)' }));
      case 'result':      return rapi_json_(rapi_result_(p));
      case 'keycheck':    return rapi_json_(rapi_keycheck_(p));
      case 'drivetoken':  return rapi_json_(rapi_driveToken_());
      default:            return rapi_json_({ ok: false, reason: 'unknown cmd: ' + p.cmd });
    }
  } catch (err) {
    return rapi_json_({ ok: false, reason: String((err && err.message) || err) });
  }
}

/* =================================================
 * 엔드포인트
 * ================================================= */

function rapi_ping_() {
  return { ok: true, project: RAPI.PROJECT, version: RAPI.VERSION, at: new Date().toISOString() };
}

/**
 * 파이프라인 시작.
 *   keywords : 쉼표/줄바꿈 구분 (필수)
 *   quality  : 0이면 STEP3 건너뜀 (C8). 기본 1
 *   garbage  : 자리만 확보 — 동작 없음
 *   force    : 1이면 진행 중인 파이프라인을 중단하고 새로 시작
 *   presave  : 'discard'면 미저장 결과를 Stack에 옮기지 않고 버림. 기본 저장
 *
 * ⚠️ tick을 직접 돌리지 않고 1분 뒤 트리거로 예약한다(`deferTick:true`).
 *    웹앱 요청이 즉시 반환돼야 러너가 타임아웃 없이 다음 일을 한다.
 */
function rapi_start_(p) {
  const keywords = pv_parseKeywords_(p.keywords);
  if (!keywords.length) return { ok: false, reason: 'keywords 파라미터가 비어 있습니다.' };
  return pv_startCore_(keywords, {
    quality:   p.quality !== '0',
    garbage:   false,
    force:     p.force === '1',
    preSave:   p.presave === 'discard' ? 'discard' : 'save',
    deferTick: true,
  });
}

/**
 * 상태 조회. 러너가 5분마다 폴링해 정체를 판정한다(§7).
 * 러너가 판정에 쓰는 값이므로 **가공하지 말고 원본을 그대로** 실어 보낸다.
 */
function rapi_status_() {
  const st = pv_loadState_();
  const props = PropertiesService.getScriptProperties();
  return {
    ok: true,
    version:  RAPI.VERSION,
    state:    st || null,
    logTail:  rapi_logTail_(RAPI.LOG_TAIL),
    hasTick:  ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === PV.TICK_FN),
    fatal:    iv_getFatal_() || null,
    running:  props.getProperty(VCONFIG.PROP.RUNNING) === 'true',
    qRunning: props.getProperty('Q_RUNNING') === 'true',
    stopFlag: props.getProperty(PV.STOP_PROP) === 'true',
    // 1.0.2: verify 단계의 행 단위 진척. state만으로는 2시간짜리 verify가
    //        "느린 것"인지 "멈춘 것"인지 구분이 안 된다(러너 정체 판정용).
    progress: {
      currentRow:    rapi_intProp_(props, VCONFIG.PROP.CURRENT),
      endRow:        rapi_intProp_(props, VCONFIG.PROP.END),
      lastHeartbeat: rapi_intProp_(props, VCONFIG.PROP.HEARTBEAT),   // ms epoch
    },
    at:       new Date().toISOString(),
  };
}

function rapi_intProp_(props, key) {
  const v = parseInt(props.getProperty(key), 10);
  return isNaN(v) ? null : v;
}

/**
 * 키워드 사전 점검 (읽기 전용, 1.0.2).
 * 적재(`pv_load_`)와 **같은 판정 함수**로 Latex변환 `Data_DS`를 훑어, 이번 런 키워드에
 * 이미 걸리는 행이 있는지 센다. 0이 아니면 러너는 crop 전에 멈춘다 —
 * 적재가 부분 문자열 일치라 같은 이름 재실행·겹치는 이름이 옛 행을 끌어오기 때문.
 *   keywords : 쉼표/줄바꿈 구분
 * 응답: { ok, total, byKeyword:{kw:n}, samples:[{row,key}] (최대 10) }
 */
function rapi_keycheck_(p) {
  const keywords = pv_parseKeywords_(p.keywords);
  if (!keywords.length) return { ok: false, reason: 'keywords 파라미터가 비어 있습니다.' };
  const src = SpreadsheetApp.openById(pv_latexFileId_()).getSheetByName(PV.LATEX_SRC_SHEET);
  if (!src) return { ok: false, reason: 'Latex변환 파일에 ' + PV.LATEX_SRC_SHEET + ' 시트가 없습니다.' };
  const last = src.getLastRow();
  const byKeyword = {}, samples = [];
  keywords.forEach(k => { byKeyword[k] = 0; });
  let total = 0;
  if (last >= 2) {
    const one = keywords.map(k => ({ k: k, m: pv_keyMatcher_([k]) }));
    src.getRange(2, 1, last - 1, 1).getValues().forEach((r, i) => {
      const key = String(r[0] || '').trim();
      if (!key) return;
      let hit = false;
      one.forEach(o => { if (o.m(key)) { byKeyword[o.k]++; hit = true; } });
      if (hit) {
        total++;
        if (samples.length < 10) samples.push({ row: i + 2, key: key });
      }
    });
  }
  return { ok: true, total: total, byKeyword: byKeyword, samples: samples, scannedRows: Math.max(last - 1, 0) };
}

/**
 * 판정 집계. N열(문항 검증)과 U열(논리 검증)을 센다.
 * ⚠️ `quality=0`으로 돌린 런은 U열이 비어 있는 게 정상이다 — 오류가 아니다.
 *
 * 어디를 읽나 (2026-09-19 수정):
 *   `stack` 단계가 결과를 Stack으로 옮긴 뒤 **Data_DS를 비운다**(mts_core_).
 *   그래서 런이 끝난 뒤(stats/done)에 Data_DS를 읽으면 항상 0행이었다 — 러너가
 *   결과를 묻는 시점이 바로 그때다. 이제는
 *     Data_DS에 행이 있으면 → Data_DS (진행 중 / stack 전)
 *     비어 있고 이번 런이 stack을 마쳤으면 → Stack의 st.stack.appendRow ~ endRow
 *   Stack은 Data_DS의 A~AC를 같은 열 위치로 복사하므로 N·U 열 번호가 같다.
 *   `errorRows`는 `source` 시트 기준 행 번호다.
 */
function rapi_result_(p) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const st = pv_loadState_();
  const base = { ok: true, runId: (st && st.startedAt) || '', stage: (st && st.stage) || '',
                 keywords: (st && st.keywords) || [] };

  let sheet = ss.getSheetByName(PV.DATA_SHEET);
  let first = 2, count = sheet.getLastRow() - 1;
  let source = PV.DATA_SHEET;
  if (count < 1) {
    const sk = st && st.stack;
    if (!sk || !sk.appendRow || !sk.endRow) {
      return Object.assign(base, { source: '', rows: 0, n: {}, q: {}, errorRows: [],
        note: 'Data_DS가 비어 있고 이번 런의 Stack 기록도 없음' });
    }
    sheet = ss.getSheetByName(MTS.DST_SHEET);
    first = sk.appendRow; count = sk.endRow - sk.appendRow + 1; source = MTS.DST_SHEET;
  }

  const n = {}, q = {}, errorRows = [];
  const vals = sheet.getRange(first, 1, count, QCONFIG.COL.Q_VERDICT).getValues();
  vals.forEach((row, i) => {
    const nv = String(row[13] || '').toLowerCase().trim() || '(빈칸)';                 // N열
    const qv = String(row[QCONFIG.COL.Q_VERDICT - 1] || '').toLowerCase().trim() || '(빈칸)';  // U열
    n[nv] = (n[nv] || 0) + 1;
    q[qv] = (q[qv] || 0) + 1;
    if (nv === 'error' || nv === 'timeout' || qv === 'error' || qv === 'timeout') errorRows.push(first + i);
  });
  return Object.assign(base, { source: source, range: [first, first + count - 1],
                               rows: count, n: n, q: q, errorRows: errorRows });
}

/**
 * ⏸️ D안 전용 — 러너가 Drive·Sheets REST를 직접 호출하기 위한 OAuth 토큰.
 *    2026-09-26 내구성 판정 전까지 `ENABLE_DRIVETOKEN=false`로 잠가둔다.
 *
 * ⚠️ 이 토큰은 **전체 Drive 권한**을 담는다. 절대 로그에 남기지 말 것.
 *    수명은 약 1시간이며 러너는 401을 받으면 새로 받아온다.
 */
function rapi_driveToken_() {
  if (!RAPI.ENABLE_DRIVETOKEN) {
    return { ok: false, reason: 'drivetoken 비활성 — 2026-09-26 C6 내구성 판정 후 결정' };
  }
  return { ok: true, token: ScriptApp.getOAuthToken(), expires_in: 3300 };
}

/* =================================================
 * 내부 유틸
 * ================================================= */

/** 토큰 비교. 길이가 달라도 조기 반환하지 않도록 상수시간 비교한다. */
function rapi_auth_(given) {
  const want = PropertiesService.getScriptProperties().getProperty(RAPI.TOKEN_PROP);
  if (!want || !given) return false;
  if (want.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function rapi_json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Pipeline_Log 마지막 n행 → [{time, run, stage, message}] */
function rapi_logTail_(n) {
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(PV.LOG_SHEET);
    if (!sh) return [];
    const last = sh.getLastRow();
    if (last < 2) return [];
    const from = Math.max(2, last - n + 1);
    return sh.getRange(from, 1, last - from + 1, 4).getValues().map(r => ({
      time: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
      run: String(r[1] || ''), stage: String(r[2] || ''), message: String(r[3] || ''),
    }));
  } catch (_) { return []; }
}

/* =================================================
 * 설치 보조 (편집기에서 1회 실행)
 * ================================================= */

/**
 * `REMOTE_TOKEN` 설정 확인 (편집기에서 1회 실행). **토큰을 만들지도, 로그에 찍지도 않는다.**
 * 토큰은 맥미니에서 암호용 난수로 생성한다(`~/audit_runner/secrets/remote_tokens.json`의 "audition").
 *   → 프로젝트 설정 → 스크립트 속성 → `REMOTE_TOKEN`에 그 값을 붙여 넣은 뒤 이 함수로 확인.
 * ⚠️ 프로젝트별로 다른 토큰을 쓴다 — 하나가 새어도 나머지가 버틴다.
 * (2026-09-19 변경: 옛 버전은 Math.random()으로 생성하고 실행 로그에 토큰을 남겼다. 로그는 지울 수 없다.)
 */
function rapi_setupToken() {
  const tok = PropertiesService.getScriptProperties().getProperty(RAPI.TOKEN_PROP);
  if (!tok) { console.log('REMOTE_TOKEN 미설정 — 스크립트 속성에 추가하세요.'); return; }
  const ok = tok.length >= 32 && /^[A-Za-z0-9]+$/.test(tok);
  console.log('REMOTE_TOKEN 설정됨: 길이 %s, 형식 %s', tok.length, ok ? '정상' : '⚠️ 비정상(공백·줄바꿈 섞임?)');
}
