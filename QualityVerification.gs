/**
 * ============================================================
 * QualityVerification.gs — STEP 3: 해설 논리 검증 (v2)
 * ============================================================
 * v2 변경사항:
 *   - 사이드바 실행기(QualityRunner.html) 추가: 행 1건 = 서버 호출 1건 구조로
 *     GAS 6분 실행 한도를 원천 회피 → 시간 초과 재시작 불필요.
 *     (Gmail 계정의 트리거 총 실행시간 90분/일 한도를 소모하지 않는
 *      사용자 상호작용 실행이므로 하루 100건 목표에 적합)
 *   - 서버 함수: openQualityRunner / qr_start / qr_processRow / qr_finish / qr_requestStop
 *   - 동시 실행 가드: STEP1·2(V_RUNNING) 진행 중이면 시작 거부
 *   - 기존 동기 실행(startQualityVerification)은 보조용으로 유지(에디터에서 호출 가능)
 *
 * 목적:
 *   해설의 '논리적 비약(logic_gap)'과 '일관성 없는 서술(inconsistency)'을
 *   비대칭 교차 검증으로 판정한다.
 *     [1차] Gemini(후보 생성, recall) → [2차] Claude(후보 판정, precision)
 *     → [합성] 코드 로직으로 U/V/W/X 기록
 *
 * 설계 원칙:
 *   - STEP 1·2(ItemVerification)와 완전 분리. 트리거 체인 미사용(메뉴 수동 실행).
 *   - Claude는 Gemini 후보가 1개 이상인 행에서만 호출(비용 절감).
 *   - U열 verdict 어휘: ok / check / fail / skip  (+ API 실패 시 error / timeout)
 *     → 'fail' = 확정 결함. 'error'/'timeout'은 재검증(retryErrorRows) 대상 전용.
 *
 * 신규 열:
 *   U(21) Q_VERDICT   ok/check/fail/skip/error/timeout
 *   V(22) Q_REPORT    확정 결함 리포트 (valid 판정만, 사람이 읽는 결과)
 *   W(23) Q_AUDIT     감사 추적: Gemini 후보 ↔ Claude 판정 대조 (파일럿 정밀도 측정용)
 *   X(24) JUDGE_MODEL 2차 판정 Claude 모델명 (Claude 미호출 시 빈칸)
 *
 * ScriptProperties:
 *   CLAUDE_API_KEY   (필수) Anthropic API 키
 *   Q_GEMINI_MODEL   (선택) 기본 gemini-3.1-pro-preview — STEP3 전용 1차 모델(전환 메뉴와 무관하게 고정)
 *   Q_CLAUDE_MODEL   (선택) 기본 claude-opus-4-8
 *   Q_STOP / Q_RUNNING / Q_LAST_HEARTBEAT — 실행 상태
 *
 * 재사용(Itemverification.gs의 전역 함수, 수정 없음):
 *   getPromptSet, safeParseGeminiJson_, is503Error_, parseRowRange(MainMenu.gs)
 * ============================================================
 */

/* ─── STEP3 설정 (VCONFIG와 완전 분리) ─── */
const QCONFIG = {
  DATA_SHEET: 'Data_DS',

  /* 1차: Gemini — 전환 메뉴(V_GEMINI_MODEL)와 무관하게 STEP3 전용으로 고정 */
  GEMINI_MODEL: PropertiesService.getScriptProperties().getProperty('Q_GEMINI_MODEL') || 'gemini-3.1-pro-preview',
  GEMINI_THINKING_LEVEL: 'HIGH',

  /* 2차: Claude Opus 4.8 — adaptive thinking + effort
     주의: temperature/top_p 등 샘플링 파라미터는 지원되지 않음(설정 시 400) */
  CLAUDE_MODEL: PropertiesService.getScriptProperties().getProperty('Q_CLAUDE_MODEL') || 'claude-opus-4-8',
  CLAUDE_MAX_TOKENS: 16000,          // thinking + 응답 합산 하드캡
  CLAUDE_EFFORT: 'high',
  ANTHROPIC_VERSION: '2023-06-01',

  /* 시간 예산 (메뉴 동기 실행: GAS 6분 한도 내 안전 마진) */
  MAX_EXEC_MS:         Math.round(1000 * 60 * 4.5),  // 4.5분
  ROW_TIME_RESERVE_MS: 120000,   // 행 시작 전 최소 확보 시간(Gemini+Claude 감안)
  API_CALL_RESERVE_MS: 45000,

  /* v2: 사이드바 실행기 — 서버 호출 1건당 1행 처리 예산 (실행당 6분 한도 내 마진) */
  RUNNER_ROW_BUDGET_MS: 270000,  // 4.5분

  /* 재시도 */
  MAX_RETRIES:    5,
  RETRY_DELAY_MS: 3000,
  INTER_ROW_COOLDOWN_MS: 1500,

  /* 후보 상한 (Claude 프롬프트 비대 방지) */
  MAX_CANDIDATES: 8,

  /* Data_DS 열 번호 */
  COL: {
    STEM:        5,   // E
    SOLUTION:    3,   // C
    Q_VERDICT:  21,   // U
    Q_REPORT:   22,   // V
    Q_AUDIT:    23,   // W
    JUDGE_MODEL: 24,  // X
  },

  PROP: {
    STOP:      'Q_STOP',
    RUNNING:   'Q_RUNNING',
    HEARTBEAT: 'Q_LAST_HEARTBEAT',
  },
};


/* ═══════════════════════════════════════════════
   1. 메뉴 진입 / 중단
   ═══════════════════════════════════════════════ */

/**
 * 메뉴 호출: 행 범위를 입력받아 STEP3 논리 검증을 동기 실행
 * - U열이 이미 채워진 행(error/timeout 제외)은 자동 건너뜀
 *   → 시간 초과로 중단된 뒤 같은 범위를 재입력하면 이어서 처리됨
 */
function startQualityVerification() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QCONFIG.DATA_SHEET);
  if (!sheet) { ui.alert('Data_DS 시트를 찾을 수 없습니다.'); return; }

  // ── 사전 점검: API 키 ──
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('GEMINI_API_KEY')) { ui.alert('GEMINI_API_KEY가 설정되지 않았습니다.'); return; }
  if (!props.getProperty('CLAUDE_API_KEY')) { ui.alert('CLAUDE_API_KEY가 설정되지 않았습니다.'); return; }

  // ── 사전 점검: 프롬프트 (role 누락 시 조용히 빈 문자열이 되므로 반드시 검증) ──
  const qPrompts = loadQualityPrompts_();
  if (!qPrompts) {
    ui.alert(
      '프롬프트 로드 실패',
      'pmt 시트에서 gemini_quality_verify / claude_quality_judge 세트를 읽지 못했습니다.\n' +
      'key 접두어, role(system/user), enabled(TRUE) 값을 확인하세요.',
      ui.ButtonSet.OK
    );
    return;
  }

  // ── 행 범위 입력 ──
  const input = ui.prompt(
    '논리 검증 (STEP 3)',
    '검증할 행 범위를 입력하세요 (예: 2-47)\n\n' +
    '· U열이 이미 채워진 행(error/timeout 제외)은 건너뜁니다.\n' +
    '· 시간 초과로 중단되면 같은 범위로 재실행하면 이어서 처리됩니다.',
    ui.ButtonSet.OK_CANCEL
  );
  if (input.getSelectedButton() !== ui.Button.OK) return;

  const range = parseRowRange(input.getResponseText());
  if (!range || range.startRow < 2) { ui.alert('유효하지 않은 범위입니다. (예: 2-47)'); return; }

  // ── 대상 행 선별 (U열 기준 건너뛰기) ──
  const numRows = range.endRow - range.startRow + 1;
  const uVals = sheet.getRange(range.startRow, QCONFIG.COL.Q_VERDICT, numRows, 1).getValues();
  const targets = [];
  let skippedDone = 0;
  for (let i = 0; i < numRows; i++) {
    const u = String(uVals[i][0] || '').toLowerCase().trim();
    if (u === '' || u === 'error' || u === 'timeout') {
      targets.push(range.startRow + i);
    } else {
      skippedDone++;
    }
  }

  if (targets.length === 0) {
    ui.alert(`범위 내 처리할 행이 없습니다. (이미 완료 ${skippedDone}개)`);
    return;
  }

  const confirm = ui.alert(
    '논리 검증 시작 확인',
    `1차: Gemini (${QCONFIG.GEMINI_MODEL})\n` +
    `2차: Claude (${QCONFIG.CLAUDE_MODEL}) — 후보가 있는 행만 호출\n\n` +
    `대상: ${targets.length}개 행 (이미 완료 ${skippedDone}개 건너뜀)\n` +
    `범위: ${range.startRow} ~ ${range.endRow}\n\n` +
    `시작하시겠습니까?`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  // ── 실행 상태 설정 ──
  props.setProperties({
    [QCONFIG.PROP.STOP]:      'false',
    [QCONFIG.PROP.RUNNING]:   'true',
    [QCONFIG.PROP.HEARTBEAT]: String(Date.now()),
  });

  // ── 동기 루프 ──
  const startTime = Date.now();
  const stats = { ok: 0, fail: 0, check: 0, skip: 0, error: 0 };
  let lastDoneRow = 0;
  let stoppedBy = '';   // '' | 'time' | 'user'

  try {
    for (let k = 0; k < targets.length; k++) {
      const row = targets[k];

      // 사용자 중단
      if (props.getProperty(QCONFIG.PROP.STOP) === 'true') { stoppedBy = 'user'; break; }

      // 시간 예산
      const remaining = QCONFIG.MAX_EXEC_MS - (Date.now() - startTime);
      if (remaining < QCONFIG.ROW_TIME_RESERVE_MS) { stoppedBy = 'time'; break; }

      props.setProperty(QCONFIG.PROP.HEARTBEAT, String(Date.now()));

      const status = verifyQualityForRow_(sheet, row, qPrompts, remaining);
      if (stats[status] !== undefined) stats[status]++;
      lastDoneRow = row;

      if (k < targets.length - 1) Utilities.sleep(QCONFIG.INTER_ROW_COOLDOWN_MS);
      if (k % 3 === 0) SpreadsheetApp.flush();
    }
  } finally {
    SpreadsheetApp.flush();
    props.setProperty(QCONFIG.PROP.RUNNING, 'false');
  }

  const done = stats.ok + stats.fail + stats.check + stats.skip + stats.error;
  const summary =
    `처리: ${done} / ${targets.length}\n` +
    `· ok(결함 없음): ${stats.ok}\n` +
    `· fail(확정 결함): ${stats.fail}\n` +
    `· check(보류): ${stats.check}\n` +
    `· skip(풀이 없음): ${stats.skip}\n` +
    `· error(호출 실패): ${stats.error}\n` +
    `마지막 처리 행: ${lastDoneRow || '없음'}`;

  if (stoppedBy === 'time') {
    ui.alert('논리 검증 — 시간 한도 근접으로 중단',
      summary + '\n\n같은 범위로 메뉴를 재실행하면 남은 행부터 이어서 처리됩니다.',
      ui.ButtonSet.OK);
  } else if (stoppedBy === 'user') {
    ui.alert('논리 검증 — 사용자 중단', summary, ui.ButtonSet.OK);
  } else {
    ui.alert('논리 검증 완료', summary, ui.ButtonSet.OK);
  }
}

/** 메뉴 호출: STEP3 중단 요청 */
function stopQualityVerification() {
  PropertiesService.getScriptProperties().setProperty(QCONFIG.PROP.STOP, 'true');
  SpreadsheetApp.getActiveSpreadsheet().toast('논리 검증 중단 요청됨. 현재 행 처리 후 멈춥니다.');
}

/** pmt 시트에서 STEP3 프롬프트 2세트 로드 (system/user 필수 검증) */
function loadQualityPrompts_() {
  const gem   = getPromptSet('gemini_quality_verify');
  const judge = getPromptSet('claude_quality_judge');
  if (!gem.system || !gem.user || !judge.system || !judge.user) return null;
  return { gem: gem, judge: judge };
}


/* ═══════════════════════════════════════════════
   2. 행 단위 검증 (retryErrorRows에서도 재사용)
   ═══════════════════════════════════════════════ */

/**
 * 한 행에 대해 STEP3 전체 흐름 수행 후 U/V/W/X 기록.
 * API 실패는 내부에서 U='error'로 기록하고 'error'를 반환한다(throw하지 않음).
 *
 * @param {Sheet}  sheet     Data_DS 시트
 * @param {number} row       행 번호
 * @param {Object} qPrompts  { gem:{system,user,assistant}, judge:{system,user,assistant} }
 * @param {number} budgetMs  이 행에 허용된 총 시간(ms)
 * @return {string} 'ok' | 'fail' | 'check' | 'skip' | 'error'
 */
function verifyQualityForRow_(sheet, row, qPrompts, budgetMs) {
  const rowStart = Date.now();
  const C = QCONFIG.COL;

  const stem     = String(sheet.getRange(row, C.STEM).getValue()     || '').trim();
  const solution = String(sheet.getRange(row, C.SOLUTION).getValue() || '').trim();

  // ── 풀이 없음 → skip ──
  if (solution === '') {
    writeQualityRow_(sheet, row, 'skip', '', 'C열(풀이) 비어있음', '');
    return 'skip';
  }

  try {
    // ── [1차] Gemini 후보 생성 ──
    // ★ 함수형 치환 필수: 문자열 치환값의 $$/$& 특수 패턴이 LaTeX를 손상시킴
    const gemUser = qPrompts.gem.user
      .replace(/\{problem\}/g,  function () { return stem; })
      .replace(/\{solution\}/g, function () { return solution; });

    const gemBudget = Math.max((budgetMs - (Date.now() - rowStart)) / 2, QCONFIG.API_CALL_RESERVE_MS);
    const gemParsed = callGeminiForQuality_(qPrompts.gem.system, gemUser, qPrompts.gem.assistant, gemBudget);

    // 배열 스키마 필수 검증 (4단계 폴백은 candidates를 모름 → 누락 = 파싱 실패로 간주)
    if (!Array.isArray(gemParsed.candidates)) {
      throw new Error('Gemini 응답에서 candidates 배열을 파싱하지 못했습니다.');
    }

    // ── 후보 없음 → ok (Claude 미호출) ──
    let candidates = sanitizeCandidates_(gemParsed.candidates);
    if (candidates.length === 0) {
      writeQualityRow_(sheet, row, 'ok', '', '(후보 없음)', '');
      return 'ok';
    }

    // 후보 상한
    let truncNote = '';
    if (candidates.length > QCONFIG.MAX_CANDIDATES) {
      truncNote = `(후보 ${candidates.length}개 중 ${QCONFIG.MAX_CANDIDATES}개만 판정)`;
      candidates = candidates.slice(0, QCONFIG.MAX_CANDIDATES);
    }

    // quote 실재성 표기 (판정은 Claude에 위임, 감사 정보만)
    const normSol = normalizeForQuoteCheck_(solution);
    candidates.forEach(function (c) {
      c._quoteFound = normSol.indexOf(normalizeForQuoteCheck_(c.quote)) !== -1;
    });

    // ── [2차] Claude 판정 ──
    const candidatesText = formatCandidatesForJudge_(candidates);
    const judgeUser = qPrompts.judge.user
      .replace(/\{problem\}/g,    function () { return stem; })
      .replace(/\{solution\}/g,   function () { return solution; })
      .replace(/\{candidates\}/g, function () { return candidatesText; });

    const claudeBudget = budgetMs - (Date.now() - rowStart);
    const judgeParsed = callClaudeWithRetry_(qPrompts.judge.system, judgeUser, claudeBudget);

    if (!Array.isArray(judgeParsed.judgments)) {
      throw new Error('Claude 응답에서 judgments 배열을 파싱하지 못했습니다.');
    }

    // ── [합성] ──
    const synth = synthesizeQuality_(candidates, judgeParsed.judgments, truncNote);
    writeQualityRow_(sheet, row, synth.verdict, synth.report, synth.audit, QCONFIG.CLAUDE_MODEL);
    return synth.verdict;

  } catch (e) {
    Logger.log(`STEP3 row ${row} error: ${e.message}`);
    writeQualityRow_(sheet, row, 'error', '', `[Error] ${String(e.message).slice(0, 400)}`, '');
    return 'error';
  }
}

/** U/V/W/X 4개 열 일괄 기록 */
function writeQualityRow_(sheet, row, verdict, report, audit, judgeModel) {
  sheet.getRange(row, QCONFIG.COL.Q_VERDICT, 1, 4)
    .setValues([[verdict, report, audit, judgeModel]]);
}

/**
 * JSON 파싱이 "성공"하며 조용히 손상된 LaTeX 명령 복구.
 * 예: JSON 문자열 "\frac"은 \f가 유효 이스케이프라 form feed + "rac"으로 파싱됨.
 * 제어문자 바로 뒤에 영문자가 이어지면 LaTeX 명령으로 보고 백슬래시를 복원한다.
 * (기존 fixJsonStringEscapes_는 파싱 '실패' 시에만 개입하므로 이 경로를 못 잡음)
 */
function repairLatexControlChars_(s) {
  return String(s || '')
    .replace(/\f(?=[a-zA-Z])/g, '\\f')   // \frac, \forall ...
    .replace(/\x08(?=[a-zA-Z])/g, '\\b') // \begin, \beta ...
    .replace(/\r(?=[a-zA-Z])/g, '\\r')   // \right, \rho ...
    .replace(/\n(?=[a-zA-Z])/g, '\\n')   // \neq, \nabla ... (최소 길이 인용에서 개행+영문자는 희소)
    .replace(/\t(?=[a-zA-Z])/g, '\\t');  // \theta, \tan, \text ...
}

/** Gemini 후보 배열 정제: 필드 문자열화, LaTeX 복구, type 정규화, 빈 quote 제거, id 재부여 */
function sanitizeCandidates_(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i] || {};
    // ★ 복구를 trim보다 먼저: 선두의 \f 등 제어문자가 trim에 공백으로 소실되기 전에 복원
    const quote  = repairLatexControlChars_(String(c.quote  || '')).trim();
    const reason = repairLatexControlChars_(String(c.reason || '')).trim();
    let type = String(c.type || '').trim().toLowerCase();
    if (type !== 'logic_gap' && type !== 'inconsistency') {
      type = (type.indexOf('incons') !== -1) ? 'inconsistency' : 'logic_gap';
    }
    if (quote === '' && reason === '') continue;
    out.push({ id: 'c' + (out.length + 1), type: type, quote: quote, reason: reason });
  }
  return out;
}

/** quote 실재성 검사용 정규화(공백 제거) */
function normalizeForQuoteCheck_(s) {
  return String(s || '').replace(/\s+/g, '');
}

/** Claude user 프롬프트의 {candidates} 자리에 넣을 가독 텍스트 */
function formatCandidatesForJudge_(candidates) {
  return candidates.map(function (c) {
    return c.id + ' [' + c.type + ']\n' +
           'quote: ' + c.quote + '\n' +
           'reason: ' + c.reason;
  }).join('\n\n');
}

/**
 * §3.3 합성 규칙 (순수 코드 로직)
 *  - valid ≥ 1        → 'fail'  (V열에 확정 결함 리포트)
 *  - uncertain ≥ 1    → 'check'
 *  - 전부 invalid     → 'ok'
 *  - 판정 누락 후보   → uncertain으로 취급
 */
function synthesizeQuality_(candidates, judgments, truncNote) {
  const byId = {};
  judgments.forEach(function (j) {
    if (j && j.id) byId[String(j.id).trim()] = j;
  });

  const TYPE_LABEL = { logic_gap: '비약', inconsistency: '불일치' };
  const counter = { logic_gap: 0, inconsistency: 0 };
  const reportBlocks = [];
  const auditLines = [];
  let validCnt = 0, uncertainCnt = 0;

  candidates.forEach(function (c) {
    const j = byId[c.id];
    let ruling = j ? String(j.ruling || '').toLowerCase().trim() : '';
    let note   = j ? repairLatexControlChars_(String(j.note || '')).trim() : '';
    if (ruling !== 'valid' && ruling !== 'invalid' && ruling !== 'uncertain') {
      ruling = 'uncertain';
      note = note || '판정 누락';
    }

    if (ruling === 'valid') {
      validCnt++;
      counter[c.type]++;
      reportBlocks.push(
        '[' + TYPE_LABEL[c.type] + counter[c.type] + ']\n' +
        '지점: ' + c.quote + '\n' +
        '근거: ' + (note || c.reason)
      );
    } else if (ruling === 'uncertain') {
      uncertainCnt++;
    }

    auditLines.push(
      '[' + c.id + '|' + c.type + (c._quoteFound === false ? '|quote원문불일치' : '') + '] ' +
      c.quote + ' → Claude:' + ruling + (note ? ' (' + note + ')' : '')
    );
  });

  const verdict = (validCnt >= 1) ? 'fail' : (uncertainCnt >= 1 ? 'check' : 'ok');
  let audit = auditLines.join('\n');
  if (truncNote) audit = truncNote + '\n' + audit;

  return { verdict: verdict, report: reportBlocks.join('\n\n'), audit: audit };
}


/* ═══════════════════════════════════════════════
   3. Gemini 호출 (STEP3 전용 — 모델 고정)
   ═══════════════════════════════════════════════
   기존 callGeminiUnified_는 전환 메뉴의 VCONFIG.GEMINI_MODEL을 사용하므로
   STEP3의 "1차 = 3.1 Pro 고정" 원칙을 위해 전용 호출기를 둔다.
   safeParseGeminiJson_ / is503Error_ 는 전역 함수라 그대로 재사용. */

function callGeminiForQuality_(sys, usr, ast, timeBudgetMs) {
  const startedAt = Date.now();

  for (let attempt = 0; attempt < QCONFIG.MAX_RETRIES; attempt++) {
    try {
      return callGeminiForQualityOnce_(sys, usr, ast);
    } catch (e) {
      const errorMsg = e.message || '';
      const isRetryable = is503Error_(errorMsg);
      const isLastAttempt = (attempt === QCONFIG.MAX_RETRIES - 1);

      if (!isRetryable) { Logger.log(`[Q-Gemini] 영구 에러: ${errorMsg.slice(0, 150)}`); throw e; }
      if (isLastAttempt) { Logger.log(`[Q-Gemini] 재시도 소진: ${errorMsg.slice(0, 150)}`); throw e; }

      const baseDelay = QCONFIG.RETRY_DELAY_MS * Math.pow(2, attempt);
      const jitter    = Math.floor(Math.random() * 2000);
      const sleepMs   = Math.min(baseDelay + jitter, 60000);

      const elapsed = Date.now() - startedAt;
      if (timeBudgetMs && (elapsed + sleepMs + QCONFIG.API_CALL_RESERVE_MS) > timeBudgetMs) {
        throw new Error(`시간 예산 초과로 재시도 포기: ${errorMsg}`);
      }
      Logger.log(`[Q-Gemini] 재시도 ${attempt + 1}/${QCONFIG.MAX_RETRIES}: ${sleepMs}ms 대기`);
      Utilities.sleep(sleepMs);
    }
  }
}

function callGeminiForQualityOnce_(sys, usr, ast) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');

  const contents = [{ role: 'user', parts: [{ text: usr }] }];
  if (ast && ast.trim() !== '') contents.push({ role: 'model', parts: [{ text: ast }] });

  const payload = {
    system_instruction: { parts: [{ text: sys }] },
    contents: contents,
    generationConfig: {
      response_mime_type: 'application/json',
      // Gemini 3.x REST: camelCase + 대문자 enum (이월 학습)
      thinkingConfig: { thinkingLevel: QCONFIG.GEMINI_THINKING_LEVEL },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${QCONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code !== 200) throw new Error(`Gemini API (${code}): ${resp.getContentText().slice(0, 300)}`);

  const json    = JSON.parse(resp.getContentText());
  const content = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!content) throw new Error('Gemini 응답에서 content를 찾을 수 없습니다.');

  Logger.log('[Q-Gemini Raw] ' + content.substring(0, 500));
  return safeParseGeminiJson_(content);
}


/* ═══════════════════════════════════════════════
   4. Claude API 호출 (신규)
   ═══════════════════════════════════════════════ */

/**
 * Claude 호출 + 지수 백오프/지터 재시도.
 * 재시도 대상: 529(overloaded), 429, 500, 502, 503, 504
 * 즉시 중단: credit/billing 계열, 인증/요청 형식 오류(400/401/403/404)
 */
function callClaudeWithRetry_(sys, usr, timeBudgetMs) {
  const startedAt = Date.now();

  for (let attempt = 0; attempt < QCONFIG.MAX_RETRIES; attempt++) {
    try {
      return callClaudeUnified_(sys, usr);
    } catch (e) {
      const errorMsg = e.message || '';
      const isRetryable = isClaudeRetryable_(errorMsg);
      const isLastAttempt = (attempt === QCONFIG.MAX_RETRIES - 1);

      if (!isRetryable) { Logger.log(`[Claude] 영구 에러: ${errorMsg.slice(0, 200)}`); throw e; }
      if (isLastAttempt) { Logger.log(`[Claude] 재시도 소진: ${errorMsg.slice(0, 200)}`); throw e; }

      const baseDelay = QCONFIG.RETRY_DELAY_MS * Math.pow(2, attempt);
      const jitter    = Math.floor(Math.random() * 2000);
      const sleepMs   = Math.min(baseDelay + jitter, 60000);

      const elapsed = Date.now() - startedAt;
      if (timeBudgetMs && (elapsed + sleepMs + QCONFIG.API_CALL_RESERVE_MS) > timeBudgetMs) {
        throw new Error(`시간 예산 초과로 재시도 포기: ${errorMsg}`);
      }
      Logger.log(`[Claude] 재시도 ${attempt + 1}/${QCONFIG.MAX_RETRIES}: ${sleepMs}ms 대기`);
      Utilities.sleep(sleepMs);
    }
  }
}

/**
 * Claude 재시도 가능 여부 판별
 * 529 overloaded → 재시도. credit/billing 계열 → 즉시 중단.
 */
function isClaudeRetryable_(errorMsg) {
  const msg = String(errorMsg);

  // 크레딧/결제 계열 → 재시도 무의미
  if (/credit balance|billing|purchase credits/i.test(msg)) {
    Logger.log('[FATAL] Anthropic 크레딧/결제 문제. 재시도 불가. https://console.anthropic.com 확인.');
    return false;
  }

  const retryableCodes = ['529', '429', '500', '502', '503', '504'];
  for (const code of retryableCodes) {
    if (msg.includes(`(${code})`)) return true;
  }
  if (/overloaded/i.test(msg)) return true;
  if (msg.includes('응답에서 text를 찾을 수 없습니다')) return true;  // 간헐적 빈 응답
  return false;
}

/**
 * Anthropic Messages API 단일 호출
 * - adaptive thinking + effort=high (Opus 4.8은 수동 budget_tokens 미지원)
 * - temperature 등 샘플링 파라미터 설정 금지(400 반환)
 * - 응답 content에서 type:"text" 블록만 취합 (thinking 블록 무시)
 */
function callClaudeUnified_(sys, usr) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY가 설정되지 않았습니다.');

  const payload = {
    model: QCONFIG.CLAUDE_MODEL,
    max_tokens: QCONFIG.CLAUDE_MAX_TOKENS,
    system: sys,
    thinking: { type: 'adaptive' },
    output_config: { effort: QCONFIG.CLAUDE_EFFORT },
    messages: [{ role: 'user', content: usr }],
  };

  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': QCONFIG.ANTHROPIC_VERSION,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code !== 200) throw new Error(`Claude API (${code}): ${resp.getContentText().slice(0, 300)}`);

  const json = JSON.parse(resp.getContentText());

  // text 블록 취합
  let text = '';
  const blocks = json.content || [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] && blocks[i].type === 'text') text += blocks[i].text || '';
  }
  if (!text.trim()) throw new Error('Claude 응답에서 text를 찾을 수 없습니다.');

  // 파일럿 비용 파악용 usage 로깅 (시트 기록 없음)
  const usage = json.usage || {};
  Logger.log(`[Claude usage] input=${usage.input_tokens || 0}, output=${usage.output_tokens || 0}`);
  Logger.log('[Claude Raw] ' + text.substring(0, 500));

  // Claude엔 JSON 강제 옵션이 없어 코드펜스가 붙을 수 있음 → 기존 파서 공유
  return safeParseGeminiJson_(text);
}


/* ═══════════════════════════════════════════════
   5. 단일 행 테스트 (파일럿 전 파이프라인 점검)
   ═══════════════════════════════════════════════ */

/** 메뉴 호출: 활성 셀이 있는 행 1개로 STEP3 전체 파이프라인을 검증 */
function testSingleQualityRow() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QCONFIG.DATA_SHEET);
  if (!sheet) { ui.alert('Data_DS 시트를 찾을 수 없습니다.'); return; }

  const activeSheet = ss.getActiveSheet();
  if (activeSheet.getName() !== QCONFIG.DATA_SHEET) {
    ui.alert('Data_DS 시트에서 테스트할 행의 셀을 선택한 뒤 실행하세요.');
    return;
  }
  const rowNum = activeSheet.getActiveCell().getRow();
  if (rowNum < 2) { ui.alert('2행 이하의 데이터 행을 선택하세요.'); return; }

  const qPrompts = loadQualityPrompts_();
  if (!qPrompts) {
    ui.alert('프롬프트 로드 실패. pmt 시트의 key/role/enabled를 확인하세요.');
    return;
  }

  const confirm = ui.alert(
    '논리검증 단일 행 테스트',
    `행 ${rowNum}에 대해 STEP3(Gemini→Claude→합성)를 실행합니다.\n` +
    `U~X열이 덮어쓰기 됩니다. 진행할까요?`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  ss.toast(`행 ${rowNum} 논리 검증 중... (최대 수 분 소요)`);
  const status = verifyQualityForRow_(sheet, rowNum, qPrompts, QCONFIG.MAX_EXEC_MS);
  SpreadsheetApp.flush();

  ui.alert(
    '테스트 완료',
    `행 ${rowNum} 결과: ${status}\n\nU~X열과 실행 로그(Logger)를 확인하세요.`,
    ui.ButtonSet.OK
  );
}


/* ═══════════════════════════════════════════════
   6. v2: 사이드바 실행기 (QualityRunner)
   ═══════════════════════════════════════════════
   구조: 사이드바 JS가 행 1건당 서버 호출 1건(qr_processRow)을 연쇄 실행.
   각 호출은 독립적인 실행 예산을 가지므로 6분 한도에 걸리지 않고,
   사용자 상호작용 실행이라 트리거 일일 한도(90분)도 소모하지 않는다.
   행 간 쿨다운은 서버측 sleep으로 처리(백그라운드 탭 타이머 스로틀 회피). */

/** 메뉴 호출: 논리 검증 실행기 사이드바 열기 */
function openQualityRunner() {
  const html = HtmlService.createHtmlOutputFromFile('QualityRunner')
    .setTitle('논리 검증 실행기 (STEP 3)')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * 실행 시작: 사전 점검 + 대상 행 선별.
 * @param {string} rangeText  예: "2-101"
 * @return {Object} { ok:false, message } 또는
 *                  { ok:true, targets:number[], skippedDone:number,
 *                    geminiModel:string, claudeModel:string }
 */
function qr_start(rangeText) {
  const props = PropertiesService.getScriptProperties();

  // 동시 실행 가드: STEP1·2 트리거 체인 진행 중이면 거부
  if (props.getProperty('V_RUNNING') === 'true') {
    return { ok: false, message: '문항 검증(STEP 1·2)이 실행 중입니다. 완료 또는 중단 후 시작하세요.' };
  }
  if (props.getProperty(QCONFIG.PROP.RUNNING) === 'true') {
    // 이전 실행이 비정상 종료된 잔재일 수 있음 → 안내 후 초기화하고 진행
    Logger.log('[Runner] Q_RUNNING 잔재 감지 — 초기화 후 진행');
  }

  if (!props.getProperty('GEMINI_API_KEY')) return { ok: false, message: 'GEMINI_API_KEY가 설정되지 않았습니다.' };
  if (!props.getProperty('CLAUDE_API_KEY')) return { ok: false, message: 'CLAUDE_API_KEY가 설정되지 않았습니다.' };

  if (!loadQualityPrompts_()) {
    return { ok: false, message: '프롬프트 로드 실패. pmt 시트의 quality 세트(key/role/enabled)를 확인하세요.' };
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(QCONFIG.DATA_SHEET);
  if (!sheet) return { ok: false, message: 'Data_DS 시트를 찾을 수 없습니다.' };

  const range = parseRowRange(rangeText);
  if (!range || range.startRow < 2) return { ok: false, message: '유효하지 않은 범위입니다. (예: 2-101)' };

  // 대상 행 선별: U열이 비었거나 error/timeout인 행만 (완료 행 건너뛰기)
  const numRows = range.endRow - range.startRow + 1;
  const uVals = sheet.getRange(range.startRow, QCONFIG.COL.Q_VERDICT, numRows, 1).getValues();
  const targets = [];
  let skippedDone = 0;
  for (let i = 0; i < numRows; i++) {
    const u = String(uVals[i][0] || '').toLowerCase().trim();
    if (u === '' || u === 'error' || u === 'timeout') targets.push(range.startRow + i);
    else skippedDone++;
  }

  props.setProperties({
    [QCONFIG.PROP.STOP]:      'false',
    [QCONFIG.PROP.RUNNING]:   'true',
    [QCONFIG.PROP.HEARTBEAT]: String(Date.now()),
  });

  return {
    ok: true,
    targets: targets,
    skippedDone: skippedDone,
    geminiModel: QCONFIG.GEMINI_MODEL,
    claudeModel: QCONFIG.CLAUDE_MODEL,
  };
}

/**
 * 행 1건 처리 (서버 호출 1건 = 독립 실행 예산).
 * @param {number} row
 * @param {boolean} isFirst  첫 행이면 행 간 쿨다운 생략
 * @return {Object} { row, status } — status: ok/fail/check/skip/error/stopped
 */
function qr_processRow(row, isFirst) {
  const props = PropertiesService.getScriptProperties();

  // 중단 확인 (사이드바 STOP 버튼 / 메뉴 '⛔ 논리검증 중단' / forceStopAll 모두 감지)
  if (props.getProperty(QCONFIG.PROP.STOP) === 'true') {
    return { row: row, status: 'stopped' };
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(QCONFIG.DATA_SHEET);
  if (!sheet) return { row: row, status: 'error', message: 'Data_DS 시트를 찾을 수 없습니다.' };

  const qPrompts = loadQualityPrompts_();
  if (!qPrompts) return { row: row, status: 'error', message: '프롬프트 로드 실패' };

  // 행 간 쿨다운: 서버측 sleep (백그라운드 탭 setTimeout 스로틀 회피)
  if (!isFirst) Utilities.sleep(QCONFIG.INTER_ROW_COOLDOWN_MS);

  props.setProperty(QCONFIG.PROP.HEARTBEAT, String(Date.now()));

  const status = verifyQualityForRow_(sheet, row, qPrompts, QCONFIG.RUNNER_ROW_BUDGET_MS);
  SpreadsheetApp.flush();

  return { row: row, status: status };
}

/** 실행 종료 처리 (완료·중단 공통) */
function qr_finish() {
  PropertiesService.getScriptProperties().setProperty(QCONFIG.PROP.RUNNING, 'false');
  return true;
}

/** 사이드바 STOP 버튼: Q_STOP 설정 (현재 행 완료 후 정지) */
function qr_requestStop() {
  PropertiesService.getScriptProperties().setProperty(QCONFIG.PROP.STOP, 'true');
  return true;
}