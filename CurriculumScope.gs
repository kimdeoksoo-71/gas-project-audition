/*************************************************
 * CurriculumScope.gs — 검증 프롬프트의 교육과정 범위 블록 · 해설의 교육과정 부합 (renual §9-5, 2026-11-20)
 *
 * 계획: audit-pipeline-docs `renual/2026-11-19-renewal-plan-v3.md` §7(프롬프트 행) · §7.2 · P5-1 · P5-8.
 *   - 범위 블록은 kice-engine `tools/scope_blocks.py`가 curriculum.json 에서 만들어 pmt 시트 `scope_*` 행에 넣는다.
 *     (GAS 는 맥미니 파일을 읽지 않는다.) 행이 없으면 지금처럼 동작한다(블록·AE·AF 없음).
 *   - STEP1·2 system = 기존 system + 단계 지시(scope_step1_rule / scope_step2_rule) + 블록(scope_2022/2015/none_block).
 *     교육과정별로 고정이라 캐시가 깨지지 않는다. 행마다 다른 출제 교과목은 user 끝 `[출제 범위] …` 한 줄로 준다.
 *   - STEP3·4 는 블록 없이 한 단락(scope_step34_rule · Claude 판정 scope_judge_rule) — 범위만을 이유로 결함을 올리지 않게.
 *   - STEP2 JSON 의 curriculum_fit(부합|범위밖|용어|판단불가) · curriculum_note → Data_DS AE · AF (→ Stack AG · AH, Movetostack).
 *
 * 행의 교육과정 (§2.3 과목코드 우선, Latex 변환 Classify 의 cl_resolveItem_ 과 같은 규칙)
 *   0통합 → 2022 · 대수·미적분Ⅰ·확률과 통계 (간접: 공통수학1·2)
 *   1공통 → 2015 · 수학Ⅰ·수학Ⅱ / 3확통·4미적·5기하 → 2015 · 수학Ⅰ·수학Ⅱ + 그 선택과목 (간접: 수학)
 *   9순번·9기출 → Latex 변환 Meta D(문항 단위 — 기출은 출처 학년도) → 없으면 Sets 교육과정. 교과목 구분 없이 그 교육과정 전체.
 *   그 밖(키 형식 아님 · 2009 이하 · 정보 없음) → 블록 없음(scope_none_block) → curriculum_fit '판단불가'.
 *   sc_* 순수 함수는 시트를 쓰지 않는다(Node 시험).
 *************************************************/

const SC = {
  PM: {
    b2022: 'scope_2022_block', b2015: 'scope_2015_block', none: 'scope_none_block',
    r1: 'scope_step1_rule', r2: 'scope_step2_rule', r34: 'scope_step34_rule', judge: 'scope_judge_rule',
  },
  FITS: ['부합', '범위밖', '용어', '판단불가'],
  CURR: {
    '2022': { base: ['대수', '미적분Ⅰ', '확률과 통계'], all: ['대수', '미적분Ⅰ', '확률과 통계', '미적분Ⅱ', '기하'], indirect: '공통수학1, 공통수학2' },
    '2015': { base: ['수학Ⅰ', '수학Ⅱ'], add: { '3': '확률과 통계', '4': '미적분', '5': '기하' },
              all: ['수학Ⅰ', '수학Ⅱ', '확률과 통계', '미적분', '기하'], indirect: '수학' },
  },
  META_SHEET: 'Meta', META_CURR_COL: 4,   // Latex 변환 Meta A 키 · D 교육과정
  SETS_SHEET: 'Sets', SETS_CURR_COL: 4,   // Latex 변환 Sets A 세트명 · D 교육과정
};

/* ── 순수 함수 ── */
function sc_nfc_(s) { s = String(s == null ? '' : s); return s.normalize ? s.normalize('NFC') : s; }

/** 교육과정 문자열 정리: '2022' | '2015' | '2009' … | '' */
function sc_currOf_(v) {
  const m = String(v == null ? '' : v).match(/(20\d\d)/);
  return m ? m[1] : '';
}

/**
 * key(+문제집이면 교육과정) → { curr, blockKey, line }
 *   curr9: 9순번·9기출 행의 교육과정(Meta/Sets 에서) — 다른 코드는 무시한다(과목코드 우선).
 */
function sc_scopeOf_(key, curr9) {
  const kc = ds_keyCode_(key);
  const none = (why) => ({ curr: '', blockKey: SC.PM.none, line: '\n\n[출제 범위] ' + why });
  if (!kc) return none('정보 없음 (키 형식 아님)');
  let curr, subjects, extra = '';
  if (kc.digit === '0') { curr = '2022'; subjects = SC.CURR['2022'].base; }
  else if (kc.digit === '9') {
    curr = sc_currOf_(curr9);
    if (!SC.CURR[curr]) return none(curr ? `${curr} 개정 — 범위 블록 없음` : '정보 없음 (문제집 — Meta·Sets 교육과정 없음)');
    subjects = SC.CURR[curr].all;
    extra = ' — 문제집: 교과목 구분 없이 이 교육과정 전체';
  } else {
    curr = '2015';
    subjects = SC.CURR['2015'].base.concat(SC.CURR['2015'].add[kc.digit] ? [SC.CURR['2015'].add[kc.digit]] : []);
  }
  return {
    curr: curr,
    blockKey: curr === '2022' ? SC.PM.b2022 : SC.PM.b2015,
    line: `\n\n[출제 범위] ${curr} 개정 · ${subjects.join(', ')} (간접 포함: ${SC.CURR[curr].indirect})${extra}`,
  };
}

/** pm(sc_prompts_ 결과)·단계(1|2)·scope → system. pm 이 없으면 base 그대로 */
function sc_system_(base, step, scope, pm) {
  if (!pm || !pm.ok12) return base;
  const rule = step === 1 ? pm[SC.PM.r1] : pm[SC.PM.r2];
  const blk = pm[scope.blockKey] || pm[SC.PM.none];
  return base + '\n\n' + rule + '\n\n' + blk;
}

/** user 끝에 [출제 범위] 줄 */
function sc_user_(usr, scope, pm) {
  return (pm && pm.ok12) ? usr + scope.line : usr;
}

/** STEP2 결과 → [AE, AF] (값 정리). scope.curr 가 없거나 skip 이면 판단불가 */
function sc_fit_(res, scope) {
  res = res || {};
  let fit = String(res.curriculum_fit == null ? '' : res.curriculum_fit).trim().replace(/\s+/g, '');
  let note = String(res.curriculum_note == null ? '' : res.curriculum_note).trim();
  if (fit === '범위 밖') fit = '범위밖';
  if (!scope || !scope.curr) return ['판단불가', note];
  if (String(res.verdict || '').toLowerCase() === 'skip') return ['판단불가', note];
  if (SC.FITS.indexOf(fit) < 0) return ['판단불가', ('[응답 값 없음/모름: ' + (fit || '-') + '] ' + note).trim()];
  return [fit, note];
}

/** pmt 2차원 배열 → { key: content, ok12, ok34 }  (enabled 가 TRUE 인 scope_* 행만) */
function sc_promptsFromRows_(rows) {
  const pm = {};
  (rows || []).forEach(r => {
    const key = String(r[0] || '').trim(), en = r[3];
    if (key.indexOf('scope_') !== 0) return;
    if (!(en === true || String(en).toUpperCase() === 'TRUE')) return;
    pm[key] = String(r[2] || '');
  });
  pm.ok12 = !!(pm[SC.PM.b2022] && pm[SC.PM.b2015] && pm[SC.PM.none] && pm[SC.PM.r1] && pm[SC.PM.r2]);
  pm.ok34 = !!(pm[SC.PM.r34] && pm[SC.PM.judge]);
  return pm;
}

/** STEP3·4 프롬프트 세트({gem,judge})에 범위 단락을 붙인 새 세트 */
function sc_addRule34_(set, pm) {
  if (!set || !pm || !pm.ok34) return set;
  return {
    gem: Object.assign({}, set.gem, { system: set.gem.system + '\n\n' + pm[SC.PM.r34] }),
    judge: Object.assign({}, set.judge, { system: set.judge.system + '\n\n' + pm[SC.PM.judge] }),
  };
}

/** Meta·Sets 행 → 9 계열 키의 교육과정 찾기 함수 (순수) */
function sc_curr9Finder_(metaRows, setsRows) {
  const byKey = {}, bySet = {};
  (metaRows || []).forEach(r => { const k = sc_nfc_(r[0]).trim(); if (k) byKey[k] = sc_currOf_(r[SC.META_CURR_COL - 1]); });
  (setsRows || []).forEach(r => { const k = sc_nfc_(r[0]).trim(); if (k) bySet[k] = sc_currOf_(r[SC.SETS_CURR_COL - 1]); });
  return key => {
    const k = sc_nfc_(key).trim();
    if (byKey[k]) return byKey[k];
    const sp = ds_splitKey_(k);
    return (sp && bySet[sc_nfc_(sp.set)]) || '';
  };
}

/* ── 시트 (한 실행에 한 번 읽는다) ── */
var SC_PM_ = null;        // pmt scope 행
var SC_FIND9_ = null;     // 9 계열 교육과정 찾기

function sc_prompts_() {
  if (SC_PM_) return SC_PM_;
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(VCONFIG.PMT_SHEET);
    const last = sh ? sh.getLastRow() : 0;
    SC_PM_ = sc_promptsFromRows_(last >= 2 ? sh.getRange(2, 1, last - 1, 4).getValues() : []);   // key·role·content·enabled
  } catch (e) {
    Logger.log('sc_prompts_: ' + e.message);
    SC_PM_ = sc_promptsFromRows_([]);
  }
  return SC_PM_;
}

function sc_find9_() {
  if (SC_FIND9_) return SC_FIND9_;
  let meta = [], sets = [];
  try {
    const ss = SpreadsheetApp.openById(pv_latexFileId_());
    const m = ss.getSheetByName(SC.META_SHEET), s = ss.getSheetByName(SC.SETS_SHEET);
    if (m && m.getLastRow() >= 2) meta = m.getRange(2, 1, m.getLastRow() - 1, SC.META_CURR_COL).getValues();
    if (s && s.getLastRow() >= 2) sets = s.getRange(2, 1, s.getLastRow() - 1, SC.SETS_CURR_COL).getValues();
  } catch (e) { Logger.log('sc_find9_: ' + e.message); }   // 못 읽으면 9 계열은 '정보 없음'(판단불가)
  SC_FIND9_ = sc_curr9Finder_(meta, sets);
  return SC_FIND9_;
}

/** 행의 범위. key 를 모르면 A열에서 읽는다 */
function sc_scopeForRow_(sheet, row, key) {
  if (key == null) key = sheet.getRange(row, 1).getValue();
  const kc = ds_keyCode_(key);
  return sc_scopeOf_(key, kc && kc.digit === '9' ? sc_find9_()(key) : '');
}

/** STEP2 결과를 AE·AF 에 쓴다 (pmt scope 행이 없으면 쓰지 않는다). res=null 이면 비운다(해설 없음) */
function sc_writeFit_(sheet, row, res, scope) {
  try {
    const pm = sc_prompts_();
    if (!pm.ok12) return;
    const v = res ? sc_fit_(res, scope) : ['', ''];
    sheet.getRange(row, AM.COL_FIT, 1, 2).setValues([v]);
  } catch (e) { Logger.log('sc_writeFit_ ' + row + ': ' + e.message); }   // 부합 기록 실패가 검증을 멈추게 하지 않는다
}
