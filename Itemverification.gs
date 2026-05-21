/**
 * ============================================================
 * ItemVerification.gs — 통합 문항 검증 (문제 + 해설)
 * ============================================================
 * Gemini AI만 사용하여 각 행에 대해:
 *   STEP 1: 문제검증 → N(verdict), O(derived_answer), P(solution_note)
 *   STEP 2: 해설검증 → Q(verdict), R(error_report)
 * 를 순차적으로 수행합니다.
 *
 * 대체 파일: ProblemVerification.gs, SolutionVerification.gs
 * ============================================================
 * v3 변경사항 (2026-05):
 *   - Lazy Watchdog: 메뉴 액션 시 이전 작업 멈춤 감지 (20분 임계)
 *   - Time Budget: 한 행/한 재시도가 GAS 6분 한도 초과 못 하게 제한
 *   - retryErrorRows: 'error' 또는 'timeout' 행만 골라서 재검증
 *   - V_LAST_HEARTBEAT 키로 진척 시각 추적
 * ============================================================
 * v4 변경사항 (2026-05-18):
 *   - 503 복원력 대폭 강화: 지수 백오프 + 지터, 최대 5회 재시도
 *   - 503(재시도 가능) vs 4xx(영구 실패) 에러 구분
 *   - 행 간 쿨다운(1.5초) 추가로 연속 호출 부하 완화
 *   - 연속 503 감지 시 배치 내 1분 대기 (서버 회복 대기)
 *   - 배치 간 간격 3초→10초로 확대
 *   - API_CALL_RESERVE_MS 65초→45초로 현실화
 * ============================================================
 */

/* ─── 설정 ─── */
const VCONFIG = {
  DATA_SHEET: 'Data_DS',
  PMT_SHEET:  'pmt',

  GEMINI_MODEL: 'gemini-2.5-pro',
  TEMPERATURE:  0.1,

  MAX_EXEC_MS:    1000 * 60 * 3.5,   // 3.5분
  MAX_RETRIES:    5,                   // v4: 2→5 (503 대응)
  RETRY_DELAY_MS: 3000,               // v4: 2000→3000 (지수 백오프 base)

  INITIAL_BATCH: 5,    // 2.5-pro + thinking 감안, 안전하게 축소
  MIN_BATCH:     2,
  MAX_BATCH:     15,

  /* v3: 워치독/시간예산 설정 */
  WATCHDOG_STALE_MIN:  20,        // 20분 무진척 → 멈춤 판정
  ROW_TIME_RESERVE_MS: 90000,     // 한 행 처리에 최소 확보할 시간(90초)
  API_CALL_RESERVE_MS: 45000,     // v4: 65000→45000 (실측 기반 현실화)

  /* v4: 503 복원력 설정 */
  INTER_ROW_COOLDOWN_MS:    1500,   // 행 간 쿨다운 (1.5초)
  CONSECUTIVE_503_THRESHOLD: 3,     // 연속 503 이 횟수 초과 시 일시 중단
  CONSECUTIVE_503_PAUSE_MS:  60000, // 연속 503 시 대기 시간 (1분)
  BATCH_INTERVAL_MS:         10000, // v4: 3000→10000 (배치 간 간격)

  /* Data_DS 열 번호 */
  COL: {
    STEM:        5,    // E  정규화된 문제
    SOLUTION:    3,    // C  풀이
    ANSWER_TYPE: 11,   // K  answer_type
    P_VERDICT:   14,   // N  문제검증 verdict
    P_DERIVED:   15,   // O  derived_answer
    P_NOTE:      16,   // P  solution_note
    S_VERDICT:   17,   // Q  해설검증 verdict
    S_ERROR:     18,   // R  error_report
    THINKING_TOKENS: 19, // S  STEP1 thinking 토큰 수 (난이도 지표)
  },

  /* ScriptProperties 키 (통합) */
  PROP: {
    CURRENT:   'V_CURRENT_ROW',
    END:       'V_END_ROW',
    START:     'V_START_ROW',
    STOP:      'V_STOP',
    BATCH:     'V_BATCH_SIZE',
    RUNNING:   'V_RUNNING',
    HEARTBEAT: 'V_LAST_HEARTBEAT',  // v3: 마지막 진척 시각(ms)
  },

  TRIGGER_FN: 'processVerificationQueue',
};


/* ═══════════════════════════════════════════════
   1. 시작 / 중단 / 상태
   ═══════════════════════════════════════════════ */

/** 메뉴 호출: 통합 문항 검증 시작 */
function startItemVerification() {
  const ui = SpreadsheetApp.getUi();

  // ── v3: 이전 작업 멈춤 감지 (lazy watchdog) ──
  const staleResult = checkAndHandleStaleRun_(ui);
  if (staleResult === 'cancel' || staleResult === 'resumed') return;
  // 'continue'이면 새 작업 진행

  const input = ui.prompt(
    '문항 검증 (문제 + 해설)',
    '검증할 행 범위를 입력하세요 (예: 2-100)',
    ui.ButtonSet.OK_CANCEL
  );
  if (input.getSelectedButton() !== ui.Button.OK) return;

  const range = parseRowRange(input.getResponseText());
  if (!range || range.startRow < 2) {
    ui.alert('유효하지 않은 범위입니다. (예: 2-100)');
    return;
  }

  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) { ui.alert('GEMINI_API_KEY가 설정되지 않았습니다.'); return; }

  deleteVerifyTriggers_();

  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    [VCONFIG.PROP.CURRENT]:   String(range.startRow),
    [VCONFIG.PROP.END]:       String(range.endRow),
    [VCONFIG.PROP.START]:     String(range.startRow),
    [VCONFIG.PROP.STOP]:      'false',
    [VCONFIG.PROP.BATCH]:     String(VCONFIG.INITIAL_BATCH),
    [VCONFIG.PROP.RUNNING]:   'true',
    [VCONFIG.PROP.HEARTBEAT]: String(Date.now()),  // v3: 시작 시 heartbeat
  });

  ui.alert(
    `Gemini로 행 ${range.startRow} ~ ${range.endRow} 검증을 시작합니다.\n` +
    `(문제검증 + 해설검증 순차 실행)`
  );
  processVerificationQueue();
}

/** 메뉴 호출: 작업 중단 */
function stopItemVerification() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(VCONFIG.PROP.STOP, 'true');
  SpreadsheetApp.getUi().alert('중단 요청됨. 현재 행 완료 후 중단됩니다.');
}

/** 메뉴 호출: 진행 상태 확인 */
function checkVerificationStatus() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  // ── v3: 멈춤 감지 먼저 ──
  const staleResult = checkAndHandleStaleRun_(ui);
  if (staleResult === 'cancel' || staleResult === 'resumed') return;
  // 'continue'이면 정상 상태 표시

  const current = parseInt(props.getProperty(VCONFIG.PROP.CURRENT), 10);
  const end     = parseInt(props.getProperty(VCONFIG.PROP.END), 10);
  const start   = parseInt(props.getProperty(VCONFIG.PROP.START), 10);
  const batch   = props.getProperty(VCONFIG.PROP.BATCH) || VCONFIG.INITIAL_BATCH;
  const running = props.getProperty(VCONFIG.PROP.RUNNING);
  const heartbeat = parseInt(props.getProperty(VCONFIG.PROP.HEARTBEAT), 10);

  if (!current || !end || running !== 'true') {
    ui.alert('현재 실행 중인 작업이 없습니다.');
    return;
  }

  const progress = (((current - start) / (end - start + 1)) * 100).toFixed(1);
  const lastBeat = heartbeat
    ? `${Math.floor((Date.now() - heartbeat) / 60000)}분 전`
    : '기록 없음';

  ui.alert(
    `현재 진행 상황 (통합 문항 검증)\n\n` +
    `모델: Gemini (${VCONFIG.GEMINI_MODEL})\n` +
    `현재 행: ${current} / ${end}\n` +
    `진행률: ${progress}%\n` +
    `배치 크기: ${batch}\n` +
    `마지막 진척: ${lastBeat}`
  );
}


/* ═══════════════════════════════════════════════
   2. 메인 큐 처리 루프
   ═══════════════════════════════════════════════ */

function processVerificationQueue() {
  const props = PropertiesService.getScriptProperties();

  if (props.getProperty(VCONFIG.PROP.STOP) === 'true') {
    finishVerification_('사용자에 의해 중단됨');
    return;
  }

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(VCONFIG.DATA_SHEET);
  if (!sheet) { finishVerification_('Data_DS 시트 없음'); return; }

  let currentRow = parseInt(props.getProperty(VCONFIG.PROP.CURRENT), 10);
  const endRow   = parseInt(props.getProperty(VCONFIG.PROP.END), 10);
  const batchSize = Math.min(
    parseInt(props.getProperty(VCONFIG.PROP.BATCH) || VCONFIG.INITIAL_BATCH, 10),
    endRow - currentRow + 1
  );

  if (currentRow > endRow) { finishVerification_('모든 검증이 완료되었습니다.'); return; }

  // ── 프롬프트 로드 ──
  const pPrompts = getPromptSet('gemini_problem_verify');
  const sPrompts = getPromptSet('gemini_solution_verify');

  if (!pPrompts.system) { finishVerification_('gemini_problem_verify 프롬프트 없음'); return; }
  if (!sPrompts.system) { finishVerification_('gemini_solution_verify 프롬프트 없음'); return; }

  // ── 배치 데이터 일괄 읽기 (A~R) ──
  const batchData = sheet.getRange(currentRow, 1, batchSize, 18).getValues();

  const startTime = Date.now();
  let rowsProcessed = 0;
  let totalApiTime  = 0;
  let consecutive503 = 0;   // v4: 연속 503 카운터

  for (let i = 0; i < batchSize; i++) {
    if (currentRow > endRow) break;
    if (props.getProperty(VCONFIG.PROP.STOP) === 'true') break;

    // ── v3: 행 시작 전 시간 예산 체크 ──
    const elapsed   = Date.now() - startTime;
    const remaining = VCONFIG.MAX_EXEC_MS - elapsed;
    if (remaining < VCONFIG.ROW_TIME_RESERVE_MS) {
      props.setProperty(VCONFIG.PROP.CURRENT, String(currentRow));
      scheduleNextBatch_();
      ss.toast(`시간 제한 근접. ${currentRow}행부터 재개됩니다.`);
      return;
    }

    // ── v4: 연속 503 감지 시 배치 내 일시 중단 ──
    if (consecutive503 >= VCONFIG.CONSECUTIVE_503_THRESHOLD) {
      Logger.log(`연속 503 ${consecutive503}회 감지. ${VCONFIG.CONSECUTIVE_503_PAUSE_MS / 1000}초 대기...`);
      ss.toast(`서버 과부하 감지. ${VCONFIG.CONSECUTIVE_503_PAUSE_MS / 1000}초 대기 중...`);

      // 대기 후에도 시간이 남는지 체크
      const afterPause = (Date.now() - startTime) + VCONFIG.CONSECUTIVE_503_PAUSE_MS;
      if (afterPause + VCONFIG.ROW_TIME_RESERVE_MS > VCONFIG.MAX_EXEC_MS) {
        // 대기하면 시간 초과 → 다음 배치로 넘김
        props.setProperty(VCONFIG.PROP.CURRENT, String(currentRow));
        scheduleNextBatch_();
        ss.toast(`503 연속 발생 + 시간 부족. ${currentRow}행부터 다음 배치에서 재개.`);
        return;
      }

      Utilities.sleep(VCONFIG.CONSECUTIVE_503_PAUSE_MS);
      consecutive503 = 0;  // 카운터 리셋
    }

    // ── v3: 행 시작 시 heartbeat 갱신 ──
    props.setProperty(VCONFIG.PROP.HEARTBEAT, String(Date.now()));

    const row = batchData[i];
    const stem       = String(row[VCONFIG.COL.STEM - 1]        || '').trim();   // E
    const solution   = String(row[VCONFIG.COL.SOLUTION - 1]    || '').trim();   // C
    const answerType = String(row[VCONFIG.COL.ANSWER_TYPE - 1] || '').trim();   // K

    try {
      // 상태 표시
      sheet.getRange(currentRow, VCONFIG.COL.P_NOTE).setValue(
        `검증중... [${i + 1}/${batchSize}]`
      );
      if (i % 3 === 0) SpreadsheetApp.flush();

      // ───── STEP 1: 문제 검증 ─────
      if (stem === '') {
        sheet.getRange(currentRow, VCONFIG.COL.P_VERDICT, 1, 3)
          .setValues([['skip', '', 'E열(문제) 비어있음']]);
      } else {
        const t1 = Date.now();
        const formatGuide = getFormatGuide(answerType);
        const userContent = pPrompts.user
          .replace('{problem}', stem)
          .replace('{format}', formatGuide);

        // v3: 남은 시간의 절반을 STEP 1 예산으로
        const stepBudget = (VCONFIG.MAX_EXEC_MS - (Date.now() - startTime)) / 2;
        const pResult = callGeminiWithRetry_(pPrompts.system, userContent, pPrompts.assistant, stepBudget);
        totalApiTime += (Date.now() - t1);

        // v4: 성공 시 연속 503 카운터 리셋
        consecutive503 = 0;

        // 결과 정규화
        const verdict = String(pResult.verdict || 'error').toLowerCase();
        const derived = String(pResult.derived_answer || '').trim();
        const note    = String(pResult.solution_note || '').trim();

        sheet.getRange(currentRow, VCONFIG.COL.P_VERDICT, 1, 3)
          .setValues([[verdict, derived, note]]);

        // S열: STEP 1 thinking 토큰 수 기록 (난이도 지표)
        const thinkingTokens = pResult._usage?.thoughtsTokenCount || 0;
        sheet.getRange(currentRow, VCONFIG.COL.THINKING_TOKENS)
          .setValue(thinkingTokens);
      }

      // ── v4: STEP 1 → STEP 2 사이 쿨다운 ──
      Utilities.sleep(VCONFIG.INTER_ROW_COOLDOWN_MS);

      // ───── STEP 2: 해설 검증 ─────
      if (solution === '') {
        sheet.getRange(currentRow, VCONFIG.COL.S_VERDICT, 1, 2)
          .setValues([['SKIP', 'C열(풀이) 비어있음']]);
      } else {
        const t2 = Date.now();
        const userContent2 = sPrompts.user
          .replace(/\{problem\}/g, stem)
          .replace(/\{solution\}/g, solution);

        // v3: 남은 시간 전체를 STEP 2 예산으로
        const stepBudget = VCONFIG.MAX_EXEC_MS - (Date.now() - startTime);
        const sResult = callGeminiWithRetry_(sPrompts.system, userContent2, sPrompts.assistant, stepBudget);
        totalApiTime += (Date.now() - t2);

        // v4: 성공 시 연속 503 카운터 리셋
        consecutive503 = 0;

        const sVerdict = String(sResult.verdict || 'error').toLowerCase();
        const sError   = String(sResult.error_report || '').trim();

        sheet.getRange(currentRow, VCONFIG.COL.S_VERDICT, 1, 2)
          .setValues([[sVerdict, sError]]);
      }

      // ── v3: 행 완료 시 heartbeat 갱신 ──
      props.setProperty(VCONFIG.PROP.HEARTBEAT, String(Date.now()));
      rowsProcessed++;

    } catch (e) {
      Logger.log(`Row ${currentRow} error: ${e.message}`);
      sheet.getRange(currentRow, VCONFIG.COL.P_VERDICT).setValue('error');
      sheet.getRange(currentRow, VCONFIG.COL.P_NOTE).setValue(`[Error] ${e.message}`);

      // v4: 503 에러인 경우 연속 카운터 증가
      if (e.message && e.message.includes('503')) {
        consecutive503++;
        Logger.log(`연속 503 카운터: ${consecutive503}/${VCONFIG.CONSECUTIVE_503_THRESHOLD}`);
      } else {
        consecutive503 = 0;  // 503이 아닌 에러면 카운터 리셋
      }
    }

    currentRow++;
    props.setProperty(VCONFIG.PROP.CURRENT, String(currentRow));

    // ── v4: 다음 행 시작 전 쿨다운 (마지막 행이 아닐 때만) ──
    if (i < batchSize - 1 && currentRow <= endRow) {
      Utilities.sleep(VCONFIG.INTER_ROW_COOLDOWN_MS);
    }
  }

  SpreadsheetApp.flush();

  if (currentRow > endRow) {
    finishVerification_('모든 검증이 완료되었습니다.');
  } else {
    // 적응형 배치 크기 조정
    if (rowsProcessed > 0) {
      const avgMs = totalApiTime / rowsProcessed;
      const newBatch = calcAdaptiveBatch_(avgMs);
      props.setProperty(VCONFIG.PROP.BATCH, String(newBatch));
      Logger.log(`Batch done. avg ${avgMs.toFixed(0)}ms/row → next batch ${newBatch}`);
    }
    props.setProperty(VCONFIG.PROP.CURRENT, String(currentRow));
    scheduleNextBatch_();
    ss.toast(`${rowsProcessed}행 처리 완료. ${currentRow}행부터 재개됩니다.`);
  }
}


/* ═══════════════════════════════════════════════
   3. 단일 행 테스트
   ═══════════════════════════════════════════════ */

function testSingleRowVerification() {
  const ui = SpreadsheetApp.getUi();
  const rowInput = ui.prompt('단일 행 테스트', '테스트할 행 번호:', ui.ButtonSet.OK_CANCEL);
  if (rowInput.getSelectedButton() !== ui.Button.OK) return;

  const rowNum = parseInt(rowInput.getResponseText().trim(), 10);
  if (isNaN(rowNum) || rowNum < 2) { ui.alert('유효하지 않은 행 번호입니다.'); return; }

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(VCONFIG.DATA_SHEET);
  if (!sheet) { ui.alert('Data_DS 시트 없음'); return; }

  const stem       = String(sheet.getRange(rowNum, VCONFIG.COL.STEM).getValue() || '').trim();
  const solution   = String(sheet.getRange(rowNum, VCONFIG.COL.SOLUTION).getValue() || '').trim();
  const answerType = String(sheet.getRange(rowNum, VCONFIG.COL.ANSWER_TYPE).getValue() || '').trim();

  Logger.log(`=== 단일 행 테스트: Row ${rowNum} ===`);
  Logger.log(`E열(문제): ${stem.substring(0, 200)}`);
  Logger.log(`C열(풀이): ${solution.substring(0, 200)}`);
  Logger.log(`K열(유형): ${answerType}`);

  const pPrompts = getPromptSet('gemini_problem_verify');
  const sPrompts = getPromptSet('gemini_solution_verify');

  try {
    // ── 문제 검증 ──
    if (stem) {
      const formatGuide = getFormatGuide(answerType);
      const userContent = pPrompts.user
        .replace('{problem}', stem)
        .replace('{format}', formatGuide);

      const t1 = Date.now();
      // 단일 행 테스트는 충분한 예산(3분) 부여
      const pResult = callGeminiWithRetry_(pPrompts.system, userContent, pPrompts.assistant, 180000);
      Logger.log(`문제검증 (${Date.now() - t1}ms): ${JSON.stringify(pResult)}`);

      sheet.getRange(rowNum, VCONFIG.COL.P_VERDICT, 1, 3).setValues([[
        String(pResult.verdict || 'error').toLowerCase(),
        String(pResult.derived_answer || ''),
        `[TEST] ${String(pResult.solution_note || '')}`
      ]]);

      // S열: thinking 토큰 수 기록
      const thinkingTokens = pResult._usage?.thoughtsTokenCount || 0;
      sheet.getRange(rowNum, VCONFIG.COL.THINKING_TOKENS).setValue(thinkingTokens);
      Logger.log(`thinking_tokens: ${thinkingTokens}`);
    }

    // ── 해설 검증 ──
    if (solution) {
      const userContent2 = sPrompts.user
        .replace(/\{problem\}/g, stem)
        .replace(/\{solution\}/g, solution);

      const t2 = Date.now();
      const sResult = callGeminiWithRetry_(sPrompts.system, userContent2, sPrompts.assistant, 180000);
      Logger.log(`해설검증 (${Date.now() - t2}ms): ${JSON.stringify(sResult)}`);

      sheet.getRange(rowNum, VCONFIG.COL.S_VERDICT, 1, 2).setValues([[
        String(sResult.verdict || 'error').toLowerCase(),
        `[TEST] ${String(sResult.error_report || '')}`
      ]]);
    } else {
      sheet.getRange(rowNum, VCONFIG.COL.S_VERDICT, 1, 2)
        .setValues([['SKIP', 'C열(풀이) 비어있음']]);
    }

    ui.alert(`행 ${rowNum} 테스트 완료. 로그를 확인하세요.`);

  } catch (e) {
    Logger.log(`❌ Error: ${e.message}\n${e.stack}`);
    ui.alert(`오류 발생: ${e.message}`);
  }
}


/* ═══════════════════════════════════════════════
   4. 프롬프트 & 포맷 가이드
   ═══════════════════════════════════════════════ */

/**
 * pmt 시트에서 프롬프트 세트를 로드
 * @param {string} prefix  예: 'gemini_problem_verify'
 * @return {{ system:string, user:string, assistant:string }}
 */
function getPromptSet(prefix) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(VCONFIG.PMT_SHEET);
  if (!sheet) return { system: '', user: '', assistant: '' };

  const data = sheet.getDataRange().getValues();
  const set  = { system: '', user: '', assistant: '' };

  for (let i = 1; i < data.length; i++) {
    const [key, role, content, enabled] = data[i];
    const isEnabled = (enabled === true) || (String(enabled).toUpperCase() === 'TRUE');
    if (key && String(key).startsWith(prefix) && isEnabled) {
      const r = String(role).toLowerCase();
      if (r === 'system')    set.system    = String(content || '');
      if (r === 'user')      set.user      = String(content || '');
      if (r === 'assistant') set.assistant  = String(content || '');
    }
  }
  return set;
}

/**
 * K열(answer_type) → 정답 형식 안내 문자열
 */
function getFormatGuide(type) {
  const t = String(type).toLowerCase();
  if (t.includes('combo')) return "옳은 선택지 조합 (예: 'ㄱ' 또는 'ㄱ, ㄴ' 등)";
  if (t.includes('math'))  return "설명 없는 단일 수치 (LaTeX $...$ 사용 가능)";
  if (t.includes('int'))   return "1~999 사이의 자연수";
  return "표준 수치 형식";
}


/* ═══════════════════════════════════════════════
   5. Gemini API
   ═══════════════════════════════════════════════ */

/**
 * v4: 503 복원력 강화 — 지수 백오프 + 지터, 영구/재시도 에러 구분
 *
 * @param {string} sys   시스템 프롬프트
 * @param {string} usr   사용자 프롬프트
 * @param {string} ast   어시스턴트 프롬프트
 * @param {number} timeBudgetMs  이 호출에 허용된 총 시간(ms). undefined면 무제한
 * @return {Object} 파싱된 Gemini 응답
 */
function callGeminiWithRetry_(sys, usr, ast, timeBudgetMs) {
  const startedAt = Date.now();

  for (let attempt = 0; attempt < VCONFIG.MAX_RETRIES; attempt++) {
    try {
      return callGeminiUnified_(sys, usr, ast);
    } catch (e) {
      const errorMsg = e.message || '';
      const isRetryable = is503Error_(errorMsg);
      const isLastAttempt = (attempt === VCONFIG.MAX_RETRIES - 1);

      // v4: 영구 에러(400, 401, 403, 404)는 즉시 포기
      if (!isRetryable) {
        Logger.log(`영구 에러, 재시도 안함: ${errorMsg.substring(0, 150)}`);
        throw e;
      }

      if (isLastAttempt) {
        Logger.log(`최대 재시도(${VCONFIG.MAX_RETRIES}회) 소진: ${errorMsg.substring(0, 150)}`);
        throw e;
      }

      // v4: 지수 백오프 + 지터 (base * 2^attempt + random jitter)
      const baseDelay = VCONFIG.RETRY_DELAY_MS * Math.pow(2, attempt);
      const jitter    = Math.floor(Math.random() * 2000);  // 0~2초 지터
      const sleepMs   = Math.min(baseDelay + jitter, 60000); // 최대 60초 캡

      // v4: 시간 예산 체크 (API_CALL_RESERVE_MS 축소 반영)
      const elapsed = Date.now() - startedAt;
      const needed  = elapsed + sleepMs + VCONFIG.API_CALL_RESERVE_MS;

      if (timeBudgetMs && needed > timeBudgetMs) {
        Logger.log(`시간 예산 부족으로 재시도 스킵 (attempt ${attempt + 1}/${VCONFIG.MAX_RETRIES}, ` +
                   `elapsed=${elapsed}ms, sleep=${sleepMs}ms, budget=${timeBudgetMs}ms)`);
        throw new Error(`시간 예산 초과로 재시도 포기: ${errorMsg}`);
      }

      Logger.log(`Gemini 503 재시도 ${attempt + 1}/${VCONFIG.MAX_RETRIES}: ` +
                 `${sleepMs}ms 대기 (base=${baseDelay}, jitter=${jitter})`);
      Utilities.sleep(sleepMs);
    }
  }
}

/**
 * v4: HTTP 에러 코드가 재시도 가능한지 판별
 * 503, 429, 500, 502, 504 → 재시도 가능
 * 400, 401, 403, 404 등 → 영구 실패
 */
function is503Error_(errorMsg) {
  // 명시적 재시도 가능 코드
  const retryableCodes = ['503', '429', '500', '502', '504'];
  for (const code of retryableCodes) {
    if (errorMsg.includes(`(${code})`)) return true;
  }
  // "high demand", "UNAVAILABLE" 등의 키워드도 재시도 대상
  if (errorMsg.includes('UNAVAILABLE') || errorMsg.includes('high demand')) return true;
  // content 없음 (간헐적 빈 응답)도 재시도
  if (errorMsg.includes('content를 찾을 수 없습니다')) return true;
  return false;
}

function callGeminiUnified_(sys, usr, ast) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');

  const contents = [{ role: 'user', parts: [{ text: usr }] }];
  if (ast && ast.trim() !== '') {
    contents.push({ role: 'model', parts: [{ text: ast }] });
  }

  const payload = {
    system_instruction: { parts: [{ text: sys }] },
    contents: contents,
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: VCONFIG.TEMPERATURE,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VCONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error(`Gemini API (${code}): ${resp.getContentText().slice(0, 300)}`);
  }

  const json    = JSON.parse(resp.getContentText());
  const content = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!content) throw new Error('Gemini 응답에서 content를 찾을 수 없습니다.');

  // 디버그: 원본 응답 로깅 (최초 500자)
  Logger.log('[Gemini Raw] ' + content.substring(0, 500));

  // usageMetadata에서 thinking 토큰 수 추출 (난이도 지표)
  const usage = json?.usageMetadata || {};
  const parsed = safeParseGeminiJson_(content);
  parsed._usage = {
    thoughtsTokenCount: usage.thoughtsTokenCount || 0,
    totalTokenCount:    usage.totalTokenCount || 0,
  };
  return parsed;
}


/* ═══════════════════════════════════════════════
   6. 강건한 JSON 파싱 (다단계 폴백)
   ═══════════════════════════════════════════════ */

/**
 * Gemini가 반환한 텍스트를 안전하게 JSON 파싱
 * LaTeX 백슬래시(\frac, \begin 등)와 JSON 이스케이프 충돌을 처리
 *
 * 전략:
 *  1) 직접 파싱
 *  2) 간단한 이스케이프 수정 후 파싱
 *  3) JSON 문자열 값 내부의 백슬래시를 문자 단위로 처리 후 파싱
 *  4) 정규식으로 주요 필드만 추출 (최후의 수단)
 */
function safeParseGeminiJson_(raw) {
  // ── 전처리: 코드 펜스 제거 ──
  let text = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  // JSON 객체 부분만 추출 (앞뒤 잡음 제거)
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) text = objMatch[0];

  // ── 1단계: 직접 파싱 ──
  try {
    return JSON.parse(text);
  } catch (e1) {
    Logger.log('[Parse Step1 실패] ' + e1.message);
  }

  // ── 2단계: 명백히 잘못된 이스케이프만 수정 ──
  //    \X 에서 X가 JSON 유효 이스케이프(", \, /, b, f, n, r, t, u)가 아닌 경우
  let fixed2 = text.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
  try {
    return JSON.parse(fixed2);
  } catch (e2) {
    Logger.log('[Parse Step2 실패] ' + e2.message);
  }

  // ── 3단계: JSON 문자열 내부를 문자 단위로 처리 ──
  //    JSON 유효 이스케이프(\b, \f, \n, \r, \t)가 LaTeX와 충돌하는 경우도 처리
  //    예: \frac → \f(formfeed)+rac 으로 해석되는 문제
  let fixed3 = fixJsonStringEscapes_(text);
  try {
    return JSON.parse(fixed3);
  } catch (e3) {
    Logger.log('[Parse Step3 실패] ' + e3.message);
    Logger.log('[Parse Step3 입력] ' + fixed3.substring(0, 300));
  }

  // ── 4단계: 정규식으로 필드 추출 (최후의 수단) ──
  Logger.log('[Parse Step4] 정규식 추출 시도');
  return extractFieldsByRegex_(text);
}


/**
 * JSON 문자열 값 내부의 백슬래시를 문자 단위로 처리
 *
 * 핵심 문제: \frac, \begin, \ne, \right, \text 등에서
 * \f, \b, \n, \r, \t 가 JSON 유효 이스케이프로 오인됨
 *
 * 해결: \b, \f, \n, \r, \t 뒤에 알파벳이 바로 이어지면
 * LaTeX 명령으로 판단 → \\ 로 이스케이프
 */
function fixJsonStringEscapes_(text) {
  let result = '';
  let inStr = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // 문자열 열기/닫기 추적 (이전 문자가 \ 가 아닌 경우만)
    if (ch === '"') {
      // 앞의 연속 백슬래시 개수 세기 (짝수면 이스케이프 아님)
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && text[j] === '\\') { backslashCount++; j--; }
      if (backslashCount % 2 === 0) {
        inStr = !inStr;
      }
      result += ch;
      i++;
      continue;
    }

    if (!inStr) {
      result += ch;
      i++;
      continue;
    }

    // ── 문자열 내부에서 백슬래시 처리 ──
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];

      // Case A: 이미 이스케이프된 백슬래시 \\
      if (next === '\\') {
        result += '\\\\';
        i += 2;
        continue;
      }

      // Case B: \" — 유효한 이스케이프, 그대로
      if (next === '"') {
        result += '\\"';
        i += 2;
        continue;
      }

      // Case C: \/ — 유효한 이스케이프, 그대로
      if (next === '/') {
        result += '\\/';
        i += 2;
        continue;
      }

      // Case D: \u + 4 hex → 유니코드, 그대로
      if (next === 'u') {
        const hex4 = text.substring(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex4)) {
          result += text.substring(i, i + 6);
          i += 6;
          continue;
        }
        // \u 뒤가 4자리 hex가 아님 → LaTeX 명령 (예: \underset)
        result += '\\\\' + next;
        i += 2;
        continue;
      }

      // Case E: \b, \f, \n, \r, \t — 유효한 JSON 이스케이프이지만
      //         뒤에 알파벳이 이어지면 LaTeX 명령일 가능성 높음
      if ('bfnrt'.includes(next)) {
        const afterNext = (i + 2 < text.length) ? text[i + 2] : '';
        if (/[a-zA-Z]/.test(afterNext)) {
          // \frac, \begin, \ne, \right, \text 등 → LaTeX
          result += '\\\\' + next;
          i += 2;
          continue;
        }
        // \n 뒤에 공백/숫자/특수문자 → 진짜 줄바꿈/탭 등
        result += '\\' + next;
        i += 2;
        continue;
      }

      // Case F: 그 외 → 무조건 이스케이프 추가
      result += '\\\\' + next;
      i += 2;
      continue;
    }

    // 일반 문자
    result += ch;
    i++;
  }

  return result;
}


/**
 * 정규식으로 주요 필드 추출 (파싱 최후의 수단)
 * verdict, derived_answer, solution_note, error_report
 */
function extractFieldsByRegex_(text) {
  Logger.log('[extractFieldsByRegex_] 원본 앞부분: ' + text.substring(0, 200));

  const getField = (key) => {
    // "key" : "value" 또는 "key": "value" 패턴
    const re = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', 's');
    const m = text.match(re);
    return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
  };

  const verdict = getField('verdict') || 'check';
  const derived = getField('derived_answer');
  const note    = getField('solution_note');
  const errRpt  = getField('error_report');

  const result = {
    verdict: verdict,
    derived_answer: derived || '',
    solution_note: note || '',
    error_report: errRpt || '',
  };

  Logger.log('[extractFieldsByRegex_] 추출 결과: verdict=' + verdict);
  return result;
}

/** 적응형 배치 크기 계산 (행당 2회 API 호출 기준) */
function calcAdaptiveBatch_(avgMsPerRow) {
  // v4: 쿨다운 시간도 포함하여 계산
  const cooldownPerRow = VCONFIG.INTER_ROW_COOLDOWN_MS * 2; // STEP간 + 행간
  const effectivePerRow = Math.max(avgMsPerRow + cooldownPerRow, 1000);
  const available = VCONFIG.MAX_EXEC_MS - 30000; // 안전 마진 30초
  let ideal = Math.floor(available / effectivePerRow);
  ideal = Math.max(VCONFIG.MIN_BATCH, Math.min(VCONFIG.MAX_BATCH, ideal));
  return ideal;
}

/** 다음 배치를 위한 트리거 설정 */
function scheduleNextBatch_() {
  deleteVerifyTriggers_();
  ScriptApp.newTrigger(VCONFIG.TRIGGER_FN)
    .timeBased()
    .after(VCONFIG.BATCH_INTERVAL_MS)   // v4: 3초→10초
    .create();
}

/** 기존 검증 트리거 제거 */
function deleteVerifyTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === VCONFIG.TRIGGER_FN) {
      ScriptApp.deleteTrigger(t);
    }
  }
}

/** 검증 완료/중단 시 정리 */
function finishVerification_(message) {
  deleteVerifyTriggers_();

  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(VCONFIG.PROP.CURRENT);
  props.deleteProperty(VCONFIG.PROP.END);
  props.deleteProperty(VCONFIG.PROP.START);
  props.deleteProperty(VCONFIG.PROP.BATCH);
  props.deleteProperty(VCONFIG.PROP.HEARTBEAT);  // v3: heartbeat도 정리
  props.setProperty(VCONFIG.PROP.STOP, 'false');
  props.setProperty(VCONFIG.PROP.RUNNING, 'false');

  SpreadsheetApp.getActiveSpreadsheet().toast(message, '문항 검증', 5);
  Logger.log(`검증 종료: ${message}`);
}


/* ═══════════════════════════════════════════════
   7. v3: Lazy Watchdog (메뉴 액션 시 멈춤 감지)
   ═══════════════════════════════════════════════ */

/**
 * 이전 검증 작업이 멈춘 상태인지 검사하고 사용자에게 처리 옵션 제공
 *
 * @param {GoogleAppsScript.Base.Ui} ui
 * @return {'continue'|'resumed'|'cancel'}
 *   - 'continue': 멈춤 없음 또는 사용자가 NO 선택 후 정리 완료 → 새 작업 진행 가능
 *   - 'resumed':  사용자가 YES 선택 → 자동 재개 시작됨 → 호출자는 종료
 *   - 'cancel':   사용자가 CANCEL → 호출자는 종료
 */
function checkAndHandleStaleRun_(ui) {
  const props = PropertiesService.getScriptProperties();
  const running   = props.getProperty(VCONFIG.PROP.RUNNING);
  const heartbeat = parseInt(props.getProperty(VCONFIG.PROP.HEARTBEAT), 10);
  const current   = parseInt(props.getProperty(VCONFIG.PROP.CURRENT), 10);
  const end       = parseInt(props.getProperty(VCONFIG.PROP.END), 10);

  // 진행 중인 작업이 없거나 정보 부족 → 멈춤 검사 불가
  if (running !== 'true' || !heartbeat || !current || !end) {
    return 'continue';
  }

  const minutesSince = Math.floor((Date.now() - heartbeat) / 60000);
  if (minutesSince < VCONFIG.WATCHDOG_STALE_MIN) {
    return 'continue';   // 임계치 미만 — 정상 진행 중
  }

  // ── 멈춤 감지 ──
  const choice = ui.alert(
    '⚠️ 이전 작업 멈춤 감지',
    `이전 검증 작업이 ${minutesSince}분 전부터 진척이 없습니다.\n` +
    `(현재 행: ${current}, 종료 행: ${end})\n\n` +
    `→ YES: 행 ${current}을(를) 'timeout'으로 마킹하고 ${current + 1}행부터 자동 재개\n` +
    `→ NO: 이 작업을 정리(중단)\n` +
    `→ CANCEL: 아무 동작 없이 닫기`,
    ui.ButtonSet.YES_NO_CANCEL
  );

  if (choice === ui.Button.CANCEL || choice === ui.Button.CLOSE) {
    return 'cancel';
  }

  if (choice === ui.Button.YES) {
    markRowAsTimeout_(current, minutesSince);

    // 다음 행부터 재개
    const nextRow = current + 1;
    if (nextRow > end) {
      finishVerification_(`행 ${current} timeout 처리 후 종료(범위 끝)`);
      ui.alert(`행 ${current}을(를) timeout으로 마킹했습니다. 범위가 끝나서 작업을 종료합니다.`);
      return 'resumed';
    }

    props.setProperty(VCONFIG.PROP.CURRENT, String(nextRow));
    props.setProperty(VCONFIG.PROP.HEARTBEAT, String(Date.now()));
    props.setProperty(VCONFIG.PROP.STOP, 'false');
    props.setProperty(VCONFIG.PROP.RUNNING, 'true');

    deleteVerifyTriggers_();
    scheduleNextBatch_();

    ui.alert(
      `행 ${current}을(를) timeout으로 마킹했습니다.\n` +
      `${nextRow}행부터 약 ${VCONFIG.BATCH_INTERVAL_MS / 1000}초 뒤 자동 재개됩니다.`
    );
    return 'resumed';
  }

  // NO: 정리하고 새 작업 진행 가능 상태로
  finishVerification_('이전 작업이 사용자에 의해 정리되었습니다.');
  return 'continue';
}

/**
 * 행에 timeout 마킹 (이미 채워진 칸은 건드리지 않음)
 */
function markRowAsTimeout_(row, minutesSince) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(VCONFIG.DATA_SHEET);
  if (!sheet) return;

  const note = `[Watchdog] ${minutesSince}분 무진척으로 자동 스킵`;

  // N열(P_VERDICT) 비어있으면 timeout 마킹
  const nVal = String(sheet.getRange(row, VCONFIG.COL.P_VERDICT).getValue() || '').trim();
  if (nVal === '') {
    sheet.getRange(row, VCONFIG.COL.P_VERDICT).setValue('timeout');
    sheet.getRange(row, VCONFIG.COL.P_NOTE).setValue(note);
  }

  // Q열(S_VERDICT) 비어있으면 timeout 마킹
  const qVal = String(sheet.getRange(row, VCONFIG.COL.S_VERDICT).getValue() || '').trim();
  if (qVal === '') {
    sheet.getRange(row, VCONFIG.COL.S_VERDICT).setValue('timeout');
    sheet.getRange(row, VCONFIG.COL.S_ERROR).setValue(note);
  }

  SpreadsheetApp.flush();
  Logger.log(`행 ${row} timeout 마킹 완료 (${minutesSince}분 무진척)`);
}


/* ═══════════════════════════════════════════════
   8. v3: Error/Timeout 행 재검증 (retryErrorRows)
   ═══════════════════════════════════════════════ */

/**
 * 메뉴 호출: 지정 범위 내 N열 또는 Q열이 'error'/'timeout'인 행만 재검증
 *
 * - N열만 error/timeout이면 STEP 1만 재실행
 * - Q열만 error/timeout이면 STEP 2만 재실행
 * - 둘 다이면 둘 다 재실행
 * - 동기 실행: 시간 초과 시 사용자에게 안내 후 다시 메뉴 실행 권장
 */
function retryErrorRows() {
  const ui = SpreadsheetApp.getUi();

  // 멈춤 감지 먼저
  const staleResult = checkAndHandleStaleRun_(ui);
  if (staleResult === 'cancel' || staleResult === 'resumed') return;

  const input = ui.prompt(
    'Error/Timeout 행 재검증',
    '재검증할 행 범위를 입력하세요 (예: 2-100)\n' +
    'N열 또는 Q열이 error 또는 timeout인 행만 재검증됩니다.',
    ui.ButtonSet.OK_CANCEL
  );
  if (input.getSelectedButton() !== ui.Button.OK) return;

  const range = parseRowRange(input.getResponseText());
  if (!range || range.startRow < 2) {
    ui.alert('유효하지 않은 범위입니다. (예: 2-100)');
    return;
  }

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(VCONFIG.DATA_SHEET);
  if (!sheet) { ui.alert('Data_DS 시트 없음'); return; }

  // 범위 데이터 일괄 읽기
  const numRows = range.endRow - range.startRow + 1;
  const data = sheet.getRange(range.startRow, 1, numRows, 18).getValues();

  // error/timeout 행 추출
  const targets = [];
  for (let i = 0; i < numRows; i++) {
    const nVal = String(data[i][VCONFIG.COL.P_VERDICT - 1] || '').toLowerCase().trim();
    const qVal = String(data[i][VCONFIG.COL.S_VERDICT - 1] || '').toLowerCase().trim();

    const nIsErr = (nVal === 'error' || nVal === 'timeout');
    const qIsErr = (qVal === 'error' || qVal === 'timeout');

    if (nIsErr || qIsErr) {
      targets.push({
        row: range.startRow + i,
        retryProblem: nIsErr,
        retrySolution: qIsErr,
      });
    }
  }

  if (targets.length === 0) {
    ui.alert(`범위 내에 error 또는 timeout 행이 없습니다. (행 ${range.startRow}~${range.endRow})`);
    return;
  }

  const previewRows = targets.slice(0, 10).map(t => t.row).join(', ');
  const previewMore = targets.length > 10 ? ` 외 ${targets.length - 10}개` : '';

  const confirm = ui.alert(
    'Error/Timeout 행 재검증 확인',
    `재검증 대상: ${targets.length}개 행\n` +
    `행 번호: ${previewRows}${previewMore}\n\n` +
    `재검증을 시작하시겠습니까?`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) { ui.alert('GEMINI_API_KEY가 설정되지 않았습니다.'); return; }

  // 프롬프트 로드
  const pPrompts = getPromptSet('gemini_problem_verify');
  const sPrompts = getPromptSet('gemini_solution_verify');
  if (!pPrompts.system || !sPrompts.system) {
    ui.alert('프롬프트 로드 실패. pmt 시트를 확인하세요.');
    return;
  }

  const startTime = Date.now();
  let processed = 0;
  let errors    = 0;
  let lastDoneRow = 0;

  for (let k = 0; k < targets.length; k++) {
    const t = targets[k];

    // ── 시간 예산 체크 ──
    const remaining = VCONFIG.MAX_EXEC_MS - (Date.now() - startTime);
    if (remaining < VCONFIG.ROW_TIME_RESERVE_MS) {
      ui.alert(
        `시간 제한 근접으로 중단됩니다.\n\n` +
        `처리 완료: ${processed} / ${targets.length}\n` +
        `실패: ${errors}\n` +
        `마지막 처리 행: ${lastDoneRow || '없음'}\n\n` +
        `남은 행은 메뉴를 다시 실행하면 처리됩니다.`
      );
      return;
    }

    try {
      const stem       = String(sheet.getRange(t.row, VCONFIG.COL.STEM).getValue() || '').trim();
      const solution   = String(sheet.getRange(t.row, VCONFIG.COL.SOLUTION).getValue() || '').trim();
      const answerType = String(sheet.getRange(t.row, VCONFIG.COL.ANSWER_TYPE).getValue() || '').trim();

      // ── STEP 1: 문제 검증 (필요 시) ──
      if (t.retryProblem) {
        if (stem === '') {
          sheet.getRange(t.row, VCONFIG.COL.P_VERDICT, 1, 3)
            .setValues([['skip', '', 'E열(문제) 비어있음']]);
        } else {
          const formatGuide = getFormatGuide(answerType);
          const userContent = pPrompts.user
            .replace('{problem}', stem)
            .replace('{format}', formatGuide);

          // STEP 1에 남은 시간의 절반 할당 (둘 다 재시도면)
          const split = (t.retryProblem && t.retrySolution) ? 2 : 1;
          const stepBudget = (VCONFIG.MAX_EXEC_MS - (Date.now() - startTime)) / split;
          const pResult = callGeminiWithRetry_(pPrompts.system, userContent, pPrompts.assistant, stepBudget);

          sheet.getRange(t.row, VCONFIG.COL.P_VERDICT, 1, 3).setValues([[
            String(pResult.verdict || 'error').toLowerCase(),
            String(pResult.derived_answer || '').trim(),
            String(pResult.solution_note || '').trim(),
          ]]);

          const thinkingTokens = pResult._usage?.thoughtsTokenCount || 0;
          sheet.getRange(t.row, VCONFIG.COL.THINKING_TOKENS).setValue(thinkingTokens);
        }
      }

      // ── v4: STEP 간 쿨다운 ──
      if (t.retryProblem && t.retrySolution) {
        Utilities.sleep(VCONFIG.INTER_ROW_COOLDOWN_MS);
      }

      // ── STEP 2: 해설 검증 (필요 시) ──
      if (t.retrySolution) {
        if (solution === '') {
          sheet.getRange(t.row, VCONFIG.COL.S_VERDICT, 1, 2)
            .setValues([['SKIP', 'C열(풀이) 비어있음']]);
        } else {
          const userContent2 = sPrompts.user
            .replace(/\{problem\}/g, stem)
            .replace(/\{solution\}/g, solution);

          const stepBudget = VCONFIG.MAX_EXEC_MS - (Date.now() - startTime);
          const sResult = callGeminiWithRetry_(sPrompts.system, userContent2, sPrompts.assistant, stepBudget);

          sheet.getRange(t.row, VCONFIG.COL.S_VERDICT, 1, 2).setValues([[
            String(sResult.verdict || 'error').toLowerCase(),
            String(sResult.error_report || '').trim(),
          ]]);
        }
      }

      processed++;
      lastDoneRow = t.row;

    } catch (e) {
      Logger.log(`retryErrorRows row ${t.row} error: ${e.message}`);
      errors++;
      // 실패해도 N/Q열은 그대로 두어 다음 재시도 시 다시 잡히게 함
    }

    // ── v4: 행 간 쿨다운 ──
    if (k < targets.length - 1) {
      Utilities.sleep(VCONFIG.INTER_ROW_COOLDOWN_MS);
    }

    if (k % 3 === 0) SpreadsheetApp.flush();
  }

  SpreadsheetApp.flush();

  ui.alert(
    `Error/Timeout 행 재검증 완료\n\n` +
    `대상: ${targets.length}개\n` +
    `성공: ${processed}\n` +
    `실패: ${errors}`
  );
}