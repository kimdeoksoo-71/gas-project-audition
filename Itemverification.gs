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
 */

/* ─── 설정 ─── */
const VCONFIG = {
  DATA_SHEET: 'Data_DS',
  PMT_SHEET:  'pmt',

  GEMINI_MODEL: 'gemini-2.5-pro',
  TEMPERATURE:  0.0,

  MAX_EXEC_MS:    1000 * 60 * 3.5,   // 3.5분
  MAX_RETRIES:    3,
  RETRY_DELAY_MS: 2000,

  INITIAL_BATCH: 10,   // 문제+해설 2회 호출이므로 기존(20)의 절반
  MIN_BATCH:     3,
  MAX_BATCH:     25,

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
  },

  /* ScriptProperties 키 (통합) */
  PROP: {
    CURRENT: 'V_CURRENT_ROW',
    END:     'V_END_ROW',
    START:   'V_START_ROW',
    STOP:    'V_STOP',
    BATCH:   'V_BATCH_SIZE',
    RUNNING: 'V_RUNNING',
  },

  TRIGGER_FN: 'processVerificationQueue',
};


/* ═══════════════════════════════════════════════
   1. 시작 / 중단 / 상태
   ═══════════════════════════════════════════════ */

/** 메뉴 호출: 통합 문항 검증 시작 */
function startItemVerification() {
  const ui = SpreadsheetApp.getUi();
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
    [VCONFIG.PROP.CURRENT]: String(range.startRow),
    [VCONFIG.PROP.END]:     String(range.endRow),
    [VCONFIG.PROP.START]:   String(range.startRow),
    [VCONFIG.PROP.STOP]:    'false',
    [VCONFIG.PROP.BATCH]:   String(VCONFIG.INITIAL_BATCH),
    [VCONFIG.PROP.RUNNING]: 'true',
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
  const props = PropertiesService.getScriptProperties();
  const current = parseInt(props.getProperty(VCONFIG.PROP.CURRENT), 10);
  const end     = parseInt(props.getProperty(VCONFIG.PROP.END), 10);
  const start   = parseInt(props.getProperty(VCONFIG.PROP.START), 10);
  const batch   = props.getProperty(VCONFIG.PROP.BATCH) || VCONFIG.INITIAL_BATCH;
  const running = props.getProperty(VCONFIG.PROP.RUNNING);

  if (!current || !end || running !== 'true') {
    SpreadsheetApp.getUi().alert('현재 실행 중인 작업이 없습니다.');
    return;
  }

  const progress = (((current - start) / (end - start + 1)) * 100).toFixed(1);
  SpreadsheetApp.getUi().alert(
    `현재 진행 상황 (통합 문항 검증)\n\n` +
    `모델: Gemini (${VCONFIG.GEMINI_MODEL})\n` +
    `현재 행: ${current} / ${end}\n` +
    `진행률: ${progress}%\n` +
    `배치 크기: ${batch}`
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

  for (let i = 0; i < batchSize; i++) {
    if (currentRow > endRow) break;
    if (props.getProperty(VCONFIG.PROP.STOP) === 'true') break;

    // 시간 초과 체크
    if (Date.now() - startTime > VCONFIG.MAX_EXEC_MS) {
      props.setProperty(VCONFIG.PROP.CURRENT, String(currentRow));
      scheduleNextBatch_();
      ss.toast(`시간 제한 근접. ${currentRow}행부터 재개됩니다.`);
      return;
    }

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

        const pResult = callGeminiWithRetry_(pPrompts.system, userContent, pPrompts.assistant);
        totalApiTime += (Date.now() - t1);

        // 결과 정규화
        const verdict = String(pResult.verdict || 'error').toLowerCase();
        const derived = String(pResult.derived_answer || '').trim();
        const note    = String(pResult.solution_note || '').trim();

        sheet.getRange(currentRow, VCONFIG.COL.P_VERDICT, 1, 3)
          .setValues([[verdict, derived, note]]);
      }

      // ───── STEP 2: 해설 검증 ─────
      if (solution === '') {
        sheet.getRange(currentRow, VCONFIG.COL.S_VERDICT, 1, 2)
          .setValues([['SKIP', 'C열(풀이) 비어있음']]);
      } else {
        const t2 = Date.now();
        const userContent2 = sPrompts.user
          .replace(/\{problem\}/g, stem)
          .replace(/\{solution\}/g, solution);

        const sResult = callGeminiWithRetry_(sPrompts.system, userContent2, sPrompts.assistant);
        totalApiTime += (Date.now() - t2);

        const sVerdict = String(sResult.verdict || 'error').toLowerCase();
        const sError   = String(sResult.error_report || '').trim();

        sheet.getRange(currentRow, VCONFIG.COL.S_VERDICT, 1, 2)
          .setValues([[sVerdict, sError]]);
      }

      rowsProcessed++;

    } catch (e) {
      Logger.log(`Row ${currentRow} error: ${e.message}`);
      sheet.getRange(currentRow, VCONFIG.COL.P_VERDICT).setValue('error');
      sheet.getRange(currentRow, VCONFIG.COL.P_NOTE).setValue(`[Error] ${e.message}`);
    }

    currentRow++;
    props.setProperty(VCONFIG.PROP.CURRENT, String(currentRow));
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
      const pResult = callGeminiWithRetry_(pPrompts.system, userContent, pPrompts.assistant);
      Logger.log(`문제검증 (${Date.now() - t1}ms): ${JSON.stringify(pResult)}`);

      sheet.getRange(rowNum, VCONFIG.COL.P_VERDICT, 1, 3).setValues([[
        String(pResult.verdict || 'error').toLowerCase(),
        String(pResult.derived_answer || ''),
        `[TEST] ${String(pResult.solution_note || '')}`
      ]]);
    }

    // ── 해설 검증 ──
    if (solution) {
      const userContent2 = sPrompts.user
        .replace(/\{problem\}/g, stem)
        .replace(/\{solution\}/g, solution);

      const t2 = Date.now();
      const sResult = callGeminiWithRetry_(sPrompts.system, userContent2, sPrompts.assistant);
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

function callGeminiWithRetry_(sys, usr, ast) {
  for (let attempt = 0; attempt < VCONFIG.MAX_RETRIES; attempt++) {
    try {
      return callGeminiUnified_(sys, usr, ast);
    } catch (e) {
      if (attempt === VCONFIG.MAX_RETRIES - 1) throw e;
      Logger.log(`Gemini retry ${attempt + 1}/${VCONFIG.MAX_RETRIES}: ${e.message}`);
      Utilities.sleep(VCONFIG.RETRY_DELAY_MS * (attempt + 1));
    }
  }
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

  return safeParseGeminiJson_(content);
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
  // 남은 시간에 맞춰 배치 크기 결정 (안전 마진 30초)
  const available = VCONFIG.MAX_EXEC_MS - 30000;
  let ideal = Math.floor(available / Math.max(avgMsPerRow, 1000));
  ideal = Math.max(VCONFIG.MIN_BATCH, Math.min(VCONFIG.MAX_BATCH, ideal));
  return ideal;
}

/** 다음 배치를 위한 트리거 설정 */
function scheduleNextBatch_() {
  deleteVerifyTriggers_();
  ScriptApp.newTrigger(VCONFIG.TRIGGER_FN)
    .timeBased()
    .after(3000)   // 3초 후 재개
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
  props.setProperty(VCONFIG.PROP.STOP, 'false');
  props.setProperty(VCONFIG.PROP.RUNNING, 'false');

  SpreadsheetApp.getActiveSpreadsheet().toast(message, '문항 검증', 5);
  Logger.log(`검증 종료: ${message}`);
}