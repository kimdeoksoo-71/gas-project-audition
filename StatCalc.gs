/**
 * ============================================================
 * StatCalc.gs — 난이도 통계 집계 (Stack → Stat)  v2
 * ============================================================
 * Stack 시트의 S열(thinking_tokens)을 세트/문항그룹별로 집계하여
 * Stat 시트 3행 이하에 기록합니다.
 *
 * [확정 사양 — 2026-07-30 승인]
 *  ① 세트 경계: Y열(세트명) 값이 "행 번호상 연속으로 동일"한 구간.
 *     구간 내 S열이 빈/무효인 행이 있어도 세트가 끊기지 않음.
 *     Y열이 빈 행은 어떤 세트에도 속하지 않으며 구간을 끊음.
 *  ② 실행 시마다 Stat 3행 이하를 전부 지우고 Stack 전체를 재집계.
 *     (2행의 함수는 절대 건드리지 않음)
 *  ③ D열 모델명: 세트 내 첫 번째 비어있지 않은 T값.
 *     2종 이상 혼재 시 "모델명 외" 로 표기.
 *  ④ 평균값(E~Y)은 정수 반올림.
 *  ⑤ 유효 행 = S열 값이 숫자이며 0보다 큰 행.
 *     S가 빈칸·0·비숫자인 행은 38개 카운트/평균/총합 모두에서 제외.
 *  ⑦ 문항그룹 매핑은 명시적 문자열 목록(trim 후 완전 일치)만 인정.
 *
 * [v2 변경사항]
 *  - Z열(총 토큰수) 집계 대상을 E~T열 그룹(공통+확통+미적)으로 제한.
 *    기하(U~Y)는 선택과목 미응시 세트가 대부분이라 세트 간 일관 비교를
 *    위해 총합에서 제외. (TOTAL_MAX_COL = 20 = T열)
 *    → 부수 효과: 어떤 그룹에도 매칭되지 않는 Z값도 총합에서 제외됨.
 *  - 공통 1~9번 zero-padding 표기 반영 (1공통01 ~ 1공통09).
 *
 * 의존성: 없음 (API·트리거·LockService 미사용, 순수 시트 연산)
 * 메뉴 등록: MainMenu.gs → '📊 난이도 통계 계산' → calculateDifficultyStats
 * ============================================================
 */

const STATCONFIG = {
  SRC_SHEET: 'Stack',
  DST_SHEET: 'Stat',

  /* Stack 시트 열 번호 (1-based) */
  SRC_COL: {
    TOKENS: 19,   // S  thinking_tokens
    MODEL:  20,   // T  AI 모델명
    SET:    25,   // Y  세트명
    GROUP:  26,   // Z  문항그룹 (예: 1공통03)
  },

  /* 하나의 세트로 인정하는 최소 유효 문항 수 (S값 > 0 기준) */
  MIN_SET_SIZE: 38,

  /* Stat 기록 시작 행 (2행은 평균 함수 전용 — 불가침) */
  DST_START_ROW: 3,

  /* Stat 열 개수 (A~Z) */
  DST_NUM_COLS: 26,

  /* v2: Z열 총합에 포함할 그룹의 Stat 열 번호 상한 (T=20, 기하 U~Y 제외) */
  TOTAL_MAX_COL: 20,

  /**
   * Stat E~Y열 ↔ Stack Z열 값 매핑 (명시적 목록, 완전 일치)
   * col: Stat 열 번호 (E=5 ~ Y=25)
   * 주의: 공통 1~9번은 Stack 실데이터 표기에 맞춰 zero-padding (v2)
   */
  GROUPS: [
    { col: 5,  name: '공통2',   keys: ['1공통01', '1공통02'] },
    { col: 6,  name: '공통3객', keys: ['1공통03', '1공통04', '1공통05', '1공통06', '1공통07', '1공통08'] },
    { col: 7,  name: '공통3주', keys: ['1공통16', '1공통17', '1공통18', '1공통19'] },
    { col: 8,  name: '공통4하', keys: ['1공통09', '1공통10', '1공통11', '1공통12'] },
    { col: 9,  name: '공통4중', keys: ['1공통13', '1공통14', '1공통20'] },
    { col: 10, name: '공통4상', keys: ['1공통15', '1공통21', '1공통22'] },
    { col: 11, name: '확통하',  keys: ['3확통23', '3확통24', '3확통25', '3확통26'] },
    { col: 12, name: '확통27',  keys: ['3확통27'] },
    { col: 13, name: '확통28',  keys: ['3확통28'] },
    { col: 14, name: '확통29',  keys: ['3확통29'] },
    { col: 15, name: '확통30',  keys: ['3확통30'] },
    { col: 16, name: '미적하',  keys: ['4미적23', '4미적24', '4미적25', '4미적26'] },
    { col: 17, name: '미적27',  keys: ['4미적27'] },
    { col: 18, name: '미적28',  keys: ['4미적28'] },
    { col: 19, name: '미적29',  keys: ['4미적29'] },
    { col: 20, name: '미적30',  keys: ['4미적30'] },
    { col: 21, name: '기하하',  keys: ['5기하23', '5기하24', '5기하25', '5기하26'] },
    { col: 22, name: '기하27',  keys: ['5기하27'] },
    { col: 23, name: '기하28',  keys: ['5기하28'] },
    { col: 24, name: '기하29',  keys: ['5기하29'] },
    { col: 25, name: '기하30',  keys: ['5기하30'] },
  ],
};


/* ═══════════════════════════════════════════════
   메뉴 진입점
   ═══════════════════════════════════════════════ */

function calculateDifficultyStats() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const src = ss.getSheetByName(STATCONFIG.SRC_SHEET);
  const dst = ss.getSheetByName(STATCONFIG.DST_SHEET);

  if (!src) { ui.alert(`'${STATCONFIG.SRC_SHEET}' 시트를 찾을 수 없습니다.`); return; }
  if (!dst) { ui.alert(`'${STATCONFIG.DST_SHEET}' 시트를 찾을 수 없습니다.`); return; }

  // Stack에 Y/Z열이 존재하는지 방어적 확인
  if (src.getMaxColumns() < STATCONFIG.SRC_COL.GROUP) {
    ui.alert(
      'Stack 시트 열 부족',
      `Stack 시트에 Z열(문항그룹)까지 존재해야 합니다.\n` +
      `현재 최대 열: ${src.getMaxColumns()} / 필요: ${STATCONFIG.SRC_COL.GROUP}`,
      ui.ButtonSet.OK
    );
    return;
  }

  const srcLastRow = src.getLastRow();
  if (srcLastRow < 2) {
    ui.alert('Stack 시트에 데이터가 없습니다. (2행 이하 비어있음)');
    return;
  }

  // ── 1. Stack 일괄 읽기 (A~Z, 2행부터) ──
  const numRows = srcLastRow - 1;
  const data = src.getRange(2, 1, numRows, STATCONFIG.SRC_COL.GROUP).getValues();

  // ── 2. 세트(연속 동일 Y값 구간) 탐지 ──
  const runs = statFindSetRuns_(data);

  // ── 3. 각 세트별 통계 계산 (유효 행 38개 이상만) ──
  const statRows = [];
  let skippedRuns = 0;

  for (const run of runs) {
    const row = statBuildStatRow_(run, data);
    if (row) statRows.push(row);
    else skippedRuns++;
  }

  // ── 4. Stat 3행 이하 전체 클리어 (2행 함수 보존) ──
  const dstLastRow = dst.getLastRow();
  if (dstLastRow >= STATCONFIG.DST_START_ROW) {
    dst.getRange(
      STATCONFIG.DST_START_ROW, 1,
      dstLastRow - STATCONFIG.DST_START_ROW + 1,
      STATCONFIG.DST_NUM_COLS
    ).clearContent();
  }

  // ── 5. 기록 ──
  if (statRows.length > 0) {
    dst.getRange(
      STATCONFIG.DST_START_ROW, 1,
      statRows.length,
      STATCONFIG.DST_NUM_COLS
    ).setValues(statRows);
  }

  // ── 6. 완료 안내 ──
  ui.alert(
    '📊 난이도 통계 계산 완료',
    `인식된 연속 구간: ${runs.length}개\n` +
    `세트로 집계됨 (유효 문항 ${STATCONFIG.MIN_SET_SIZE}개 이상): ${statRows.length}개\n` +
    `기준 미달로 제외: ${skippedRuns}개\n\n` +
    `Stat 시트 ${STATCONFIG.DST_START_ROW}행부터 ` +
    `${statRows.length}개 행이 기록되었습니다.\n` +
    `(Z열 총합은 E~T열 그룹(공통+확통+미적)만 포함, 기하 제외)`,
    ui.ButtonSet.OK
  );

  Logger.log(`StatCalc v2: runs=${runs.length}, sets=${statRows.length}, skipped=${skippedRuns}`);
}


/* ═══════════════════════════════════════════════
   내부 헬퍼
   ═══════════════════════════════════════════════ */

/**
 * S열 값이 유효한지 판정 (숫자이며 > 0)
 * 승인 사양 ⑤: 빈칸·0·비숫자 모두 무효
 */
function statIsValidToken_(v) {
  if (v === '' || v === null || v === undefined) return false;
  const n = Number(v);
  return isFinite(n) && n > 0;
}

/**
 * v2: Z열 총합 대상 그룹 키 집합 생성 (Stat 열 번호 ≤ TOTAL_MAX_COL)
 * 공통 + 확통 + 미적의 모든 Z열 표기가 포함되고, 기하(U~Y)는 빠짐.
 */
function statBuildTotalKeySet_() {
  const set = {};
  for (const g of STATCONFIG.GROUPS) {
    if (g.col <= STATCONFIG.TOTAL_MAX_COL) {
      for (const k of g.keys) set[k] = true;
    }
  }
  return set;
}

/**
 * Y열 기준 연속 동일 세트명 구간 탐지
 * @param {Array<Array>} data  Stack 2행 이하 A~Z 값 배열
 * @return {Array<{setName:string, startIdx:number, endIdx:number}>}
 *         startIdx/endIdx는 data 배열 인덱스 (실제 행번호 = idx + 2)
 */
function statFindSetRuns_(data) {
  const SET_IDX = STATCONFIG.SRC_COL.SET - 1;   // Y = index 24
  const runs = [];
  let cur = null;

  for (let i = 0; i < data.length; i++) {
    const setName = String(data[i][SET_IDX] || '').trim();

    if (setName === '') {
      // Y열이 빈 행: 어떤 세트에도 속하지 않으며 구간을 끊음
      if (cur) { runs.push(cur); cur = null; }
      continue;
    }

    if (cur && cur.setName === setName) {
      cur.endIdx = i;                     // 구간 연장
    } else {
      if (cur) runs.push(cur);            // 이전 구간 마감
      cur = { setName: setName, startIdx: i, endIdx: i };
    }
  }
  if (cur) runs.push(cur);

  return runs;
}

/**
 * 하나의 연속 구간에 대한 Stat 행(A~Z, 26열) 생성
 * 유효 문항 수가 MIN_SET_SIZE 미만이면 null 반환
 */
function statBuildStatRow_(run, data) {
  const C = STATCONFIG.SRC_COL;
  const TOK_IDX   = C.TOKENS - 1;   // S = index 18
  const MODEL_IDX = C.MODEL  - 1;   // T = index 19
  const GROUP_IDX = C.GROUP  - 1;   // Z = index 25

  // ── 구간 내 유효 행 수집 ──
  const validRows = [];   // { tokens:number, group:string }
  const models = [];      // 등장 순서 유지, 중복 제거

  for (let i = run.startIdx; i <= run.endIdx; i++) {
    const rawTok = data[i][TOK_IDX];
    if (!statIsValidToken_(rawTok)) continue;   // 사양 ⑤

    validRows.push({
      tokens: Number(rawTok),
      group:  String(data[i][GROUP_IDX] || '').trim(),
    });

    const model = String(data[i][MODEL_IDX] || '').trim();
    if (model && models.indexOf(model) === -1) models.push(model);
  }

  // ── 세트 인정 기준 (사양 ①⑤: 유효 행 기준 38개 이상) ──
  if (validRows.length < STATCONFIG.MIN_SET_SIZE) return null;

  // ── 기본 정보 ──
  const out = new Array(STATCONFIG.DST_NUM_COLS).fill('');
  out[0] = run.setName;               // A 세트명
  out[1] = run.startIdx + 2;          // B 시작 행번호 (Stack 실제 행)
  out[2] = run.endIdx + 2;            // C 끝 행번호
  out[3] = models.length === 0 ? ''   // D 모델명 (사양 ③)
         : models.length === 1 ? models[0]
         : models[0] + ' 외';

  // ── 그룹별 평균 (사양 ④: 정수 반올림 / 사양 ⑦: 완전 일치) ──
  for (const g of STATCONFIG.GROUPS) {
    let sum = 0, cnt = 0;
    for (const r of validRows) {
      if (g.keys.indexOf(r.group) !== -1) {
        sum += r.tokens;
        cnt++;
      }
    }
    out[g.col - 1] = (cnt > 0) ? Math.round(sum / cnt) : '';
  }

  // ── Z열: 토큰 총합 (v2: E~T열 그룹 = 공통+확통+미적만 포함) ──
  const totalKeys = statBuildTotalKeySet_();
  let total = 0;
  for (const r of validRows) {
    if (totalKeys[r.group]) total += r.tokens;
  }
  out[25] = total;

  return out;
}