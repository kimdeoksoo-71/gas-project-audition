/*************************************************
 * AnswerMatch.gs — 정답 대조 열 (renual D-1, 2026-11-19)
 *
 * 계획: audit-pipeline-docs `renual/2026-11-19-renewal-plan-v3.md` §7.0 · P5-9 · P5-10.
 *   - Data_DS AD = STEP1 derived_answer(O) 와 given_answer(D) 대조: `일치 / 불일치 / 정답없음 / 판정없음`.
 *     규칙: D 공란 → 정답없음 / N(problem_verdict)이 check·error·skip·timeout 이거나 O 공란 → 판정없음 / 그 밖은 정규화 비교.
 *     정규화: 원문자↔숫자(①=1) · 공백·`$`·`\,` 제거 · 분수 기약화(`\frac{2}{4}`=`1/2`) · 합답형은 보기 집합 비교(`ㄱ,ㄷ`=`ㄷ, ㄱ`).
 *   - 새 열은 Data_DS AD~AF(정답 대조 · 교육과정 부합 · 교육과정 메모 — 뒤 둘은 §7.2 에서 채움) → Stack AF~AH 로 옮긴다(Movetostack).
 *   - STEP1 기록 지점(Itemverification 3곳 + 재시도·건너뜀·timeout, Pipelineverify pv_retryRow_)마다 am_writeRow_ 를 부른다.
 *     Stack 이관 직전(mts_core_)에 전 행을 한 번 더 계산한다(사람이 고친 D·O 반영).
 *   - am_* 순수 함수는 시트를 쓰지 않는다(Node 시험).
 *************************************************/

const AM = {
  COL_MATCH: 30,          // Data_DS AD  정답 대조
  COL_FIT: 31,            // Data_DS AE  교육과정 부합 (§7.2 — 이후 단계)
  COL_NOTE: 32,           // Data_DS AF  교육과정 메모 (§7.2)
  DS_LAST_COL: 32,        // Data_DS 에서 쓰는 마지막 열 (AF)
  STACK_COL: 32,          // Stack AF  (Data_DS AD~AF → Stack AF~AH)
  STACK_LAST_COL: 34,     // Stack AH
  HEADS: ['answer_match', 'curriculum_fit', 'curriculum_note'],
  STACK_HEADS: ['정답 대조', '교육과정 부합', '교육과정 메모'],
  NO_JUDGE: ['check', 'error', 'skip', 'timeout'],
  COL_D: 4, COL_N: 14, COL_O: 15,
};

/* ── 순수 함수 ── */
function am_gcd_(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; }

/**
 * 정답 문자열 → 비교용 정규형. 합답형이면 'set:ㄱ,ㄷ', 분수면 'n/d'(기약), 정수·소수는 숫자 문자열, 그 밖은 정리한 원문.
 */
function am_norm_(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).normalize ? String(v).normalize('NFC') : String(v);
  s = s.replace(/\\textcircled\s*\{\s*([1-9])\s*\}/g, '$1')
       .replace(/[①②③④⑤⑥⑦⑧⑨]/g, c => String('①②③④⑤⑥⑦⑧⑨'.indexOf(c) + 1))
       .replace(/\\[,;:!]|\\quad|\\qquad|\\left|\\right|\\displaystyle/g, '')
       .replace(/[$\s]/g, '')
       .replace(/^정답[:：]?/, '').replace(/^답[:：]?/, '')
       .replace(/[.。]$/, '');
  s = s.replace(/^\((\d)\)$/, '$1').replace(/^\{(.*)\}$/, '$1');
  // 합답형: ㄱ,ㄴ,ㄷ 만으로 된 목록
  if (/^[ㄱㄴㄷㄹㅁ](?:[,，、·]?[ㄱㄴㄷㄹㅁ])*$/.test(s) && /[ㄱㄴㄷㄹㅁ]/.test(s)) {
    return 'set:' + Array.from(new Set(s.replace(/[,，、·]/g, '').split(''))).sort().join(',');
  }
  // 분수: \frac{a}{b} · \dfrac · \tfrac · a/b (부호 포함)
  let m = s.match(/^(-?)\\[dt]?frac\{(-?\d+)\}\{(-?\d+)\}$/) || s.match(/^(-?)\\[dt]?frac(\d)(\d)$/);
  let num, den;
  if (m) { num = Number(m[2]) * (m[1] ? -1 : 1); den = Number(m[3]); }
  else if ((m = s.match(/^(-?\d+)\/(-?\d+)$/))) { num = Number(m[1]); den = Number(m[2]); }
  if (m && den !== 0) {
    if (den < 0) { num = -num; den = -den; }
    const g = am_gcd_(num, den) || 1;
    num /= g; den /= g;
    return den === 1 ? String(num) : num + '/' + den;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return String(Number(s));
  return s;
}

/** D·N·O → '일치' | '불일치' | '정답없음' | '판정없음' */
function am_match_(given, verdict, derived) {
  if (String(given == null ? '' : given).trim() === '') return '정답없음';
  const v = String(verdict == null ? '' : verdict).trim().toLowerCase();
  if (AM.NO_JUDGE.indexOf(v) >= 0 || String(derived == null ? '' : derived).trim() === '') return '판정없음';
  const a = am_norm_(given), b = am_norm_(derived);
  return a !== '' && a === b ? '일치' : '불일치';
}

/* ── 시트 ── */
/** Data_DS 한 행의 AD 다시 계산 */
function am_writeRow_(sheet, row) {
  try {
    const r = sheet.getRange(row, 1, 1, AM.COL_O).getValues()[0];
    sheet.getRange(row, AM.COL_MATCH).setValue(am_match_(r[AM.COL_D - 1], r[AM.COL_N - 1], r[AM.COL_O - 1]));
  } catch (e) { Logger.log('am_writeRow_ ' + row + ': ' + e.message); }   // 대조 실패가 검증을 멈추게 하지 않는다
}

/** Data_DS 전 행(키가 있는 행)의 AD 를 한 번에 다시 계산 → 값별 개수 */
function am_fillAll_(sheet) {
  const last = sheet.getLastRow();
  const cnt = { '일치': 0, '불일치': 0, '정답없음': 0, '판정없음': 0 };
  if (last < 2) return cnt;
  am_ensureWidth_(sheet, AM.DS_LAST_COL);
  const v = sheet.getRange(2, 1, last - 1, AM.COL_O).getValues();
  const out = v.map(r => {
    if (String(r[0] || '').trim() === '') return [''];
    const m = am_match_(r[AM.COL_D - 1], r[AM.COL_N - 1], r[AM.COL_O - 1]); cnt[m]++; return [m];
  });
  sheet.getRange(2, AM.COL_MATCH, out.length, 1).setValues(out);
  return cnt;
}

function am_ensureWidth_(sheet, lastCol) {
  if (sheet.getMaxColumns() < lastCol) sheet.insertColumnsAfter(sheet.getMaxColumns(), lastCol - sheet.getMaxColumns());
}

/** 머리 보장 (빈 칸일 때만). stack=true 면 Stack AF~AH, 아니면 Data_DS AD~AF */
function am_ensureHeaders_(sheet, stack) {
  const col = stack ? AM.STACK_COL : AM.COL_MATCH, heads = stack ? AM.STACK_HEADS : AM.HEADS;
  am_ensureWidth_(sheet, col + heads.length - 1);
  heads.forEach((h, i) => { const c = sheet.getRange(1, col + i); if (!String(c.getValue() || '').trim()) c.setValue(h); });
}
