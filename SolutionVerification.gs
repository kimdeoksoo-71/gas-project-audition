/***********************
 * Dual Engine Runner
 ***********************/
const SHEET_NAME_DATA = 'Data_DS';
const SHEET_NAME_PROMPT = 'pmt';  // ✅ 'prompt' → 'pmt'로 변경

// ✅ prompt key 분리
const PROMPT_KEY_GPT = 'gpt_solution_verify';      // ✅ '_system' 제거
const PROMPT_KEY_GEMINI = 'gemini_solution_verify'; // ✅ '_system' 제거

// ✅ 상태키
const PROP_CURRENT_ROW = 'AUTO_CURRENT_ROW';
const PROP_END_ROW = 'AUTO_END_ROW';
const PROP_STOP_SIGNAL = 'AUTO_STOP_SIGNAL';
const PROP_RUNNING = 'AUTO_RUNNING';
const PROP_LAST_TRIGGER_TIME = 'AUTO_LAST_TRIGGER';
const PROP_PROVIDER = 'AUTO_PROVIDER'; // "gpt" | "gemini"
const PROP_LAST_ACTIVITY = 'AUTO_LAST_ACTIVITY';  // 마지막 활동 시각 (ms)

// ✅ API KEY (스크립트 속성)
const OPENAI_API_KEY = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

// ✅ 모델명
const OPENAI_MODEL = 'gpt-5.2';
const GEMINI_MODEL = 'gemini-2.5-pro';

function startProcessGPT() {
  startAutomaticProcess_('gpt');
}

function startProcessGemini() {
  startAutomaticProcess_('gemini');
}

function startAutomaticProcess_(provider) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  // 키 체크
  if (provider === 'gpt' && !OPENAI_API_KEY) return ui.alert('OPENAI_API_KEY가 설정되지 않았습니다.');
  if (provider === 'gemini' && !GEMINI_API_KEY) return ui.alert('GEMINI_API_KEY가 설정되지 않았습니다.');

  if (props.getProperty(PROP_RUNNING) === 'true') {
    ui.alert('이미 작업이 실행 중입니다.');
    return;
  }

  props.setProperty(PROP_STOP_SIGNAL, 'false');
  props.deleteProperty(PROP_LAST_TRIGGER_TIME);
  deleteAllTriggers();

  const input = ui.prompt('범위 입력', '전체 범위를 입력하세요 (예: 2-200)', ui.ButtonSet.OK_CANCEL);
  if (input.getSelectedButton() !== ui.Button.OK) return;

  const range = parseRowRange(input.getResponseText());
  if (!range) return ui.alert('형식이 잘못되었습니다.');

  props.setProperties({
    [PROP_PROVIDER]: provider,
    [PROP_CURRENT_ROW]: String(range.startRow),
    [PROP_END_ROW]: String(range.endRow),
    [PROP_RUNNING]: 'true'
  });

  ss.toast(`${range.startRow}행부터 자동 검수 시작 (${provider.toUpperCase()})`, '자동화 시작');
  startWatchdog();  // ✅ 워치독 자동 시작
  mainLoop();
}


function mainLoop() {
  const lock = LockService.getScriptLock();
  const props = PropertiesService.getScriptProperties();

  // 중복 실행 방지
  const now = Date.now();
  const lastTrigger = parseInt(props.getProperty(PROP_LAST_TRIGGER_TIME) || '0', 10);
  if (now - lastTrigger < 30000) return;
  props.setProperty(PROP_LAST_TRIGGER_TIME, String(now));

  if (!lock.tryLock(5000)) return;

  const startTime = Date.now();
  const MAX_RUNTIME = 270000;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME_DATA);

  let shouldContinue = false;

  try {
    const provider = (props.getProperty(PROP_PROVIDER) || 'gpt').toLowerCase();
    const promptKey = provider === 'gemini' ? PROMPT_KEY_GEMINI : PROMPT_KEY_GPT;

    const prompts = getPromptsByKey_(ss, promptKey);

    if (!prompts || !prompts.system) {
      props.deleteProperty(PROP_RUNNING);
      ss.toast('프롬프트를 찾을 수 없습니다.', '오류');
      return;
    }

    let currentRow = parseInt(props.getProperty(PROP_CURRENT_ROW), 10);
    const endRow = parseInt(props.getProperty(PROP_END_ROW), 10);

    while (currentRow <= endRow) {
      // 정지 신호 체크
      if (props.getProperty(PROP_STOP_SIGNAL) === 'true') {
        sheet.getRange(currentRow, 17).setValue("STOP (USER)");
        props.deleteProperty(PROP_RUNNING);
        props.deleteProperty(PROP_LAST_TRIGGER_TIME);
        SpreadsheetApp.flush();
        return;
      }

      Utilities.sleep(1000);
      sheet.getRange(currentRow, 17).setValue("RUN");
      SpreadsheetApp.flush();

      // ✅ 워치독용 활동 타임스탬프 기록
      props.setProperty(PROP_LAST_ACTIVITY, String(Date.now()));

      // ✅✅✅ 핵심 수정: 행 단위 try-catch ✅✅✅
      try {
        const rowData = sheet.getRange(currentRow, 1, 1, 5).getValues()[0];
        const solution = rowData[2]; // C
        const problem = rowData[4];  // E

        if (problem && solution) {
          const result = (provider === 'gemini')
            ? callGemini_(prompts, problem, solution)
            : callOpenAI_(prompts, problem, solution);

          sheet.getRange(currentRow, 17, 1, 2).setValues([[result.verdict, result.error_report]]);
        } else {
          sheet.getRange(currentRow, 17).setValue("SKIP");
        }

      } catch (rowError) {
        // ✅ API 타임아웃/에러 발생 시: 해당 행만 에러 기록하고 다음 행으로
        Logger.log(`행 ${currentRow} 처리 실패: ${rowError.message}`);
        sheet.getRange(currentRow, 17, 1, 2).setValues([
          ["error", `Exception: ${rowError.message.slice(0, 200)}`]
        ]);
      }

      currentRow++;
      props.setProperty(PROP_CURRENT_ROW, String(currentRow));
      SpreadsheetApp.flush();

      // 실행 시간 초과 체크
      if (Date.now() - startTime > MAX_RUNTIME) {
        sheet.getRange(currentRow, 17).setValue("PAUSED");
        SpreadsheetApp.flush();
        shouldContinue = true;
        break;
      }
    }

    if (!shouldContinue) {
      ss.toast('모든 검수가 완료되었습니다.', '완료');
      stopWatchdog();  // ✅ 워치독 자동 종료
      props.deleteProperty(PROP_CURRENT_ROW);
      props.deleteProperty(PROP_END_ROW);
      props.deleteProperty(PROP_RUNNING);
      props.deleteProperty(PROP_LAST_TRIGGER_TIME);
      props.deleteProperty(PROP_LAST_ACTIVITY);
      props.deleteProperty(PROP_PROVIDER);
      deleteAllTriggers();
    } else {
      ss.toast(`${props.getProperty(PROP_CURRENT_ROW)}행에서 일시정지. 60초 후 재개`, '시간 보호');
    }

  } finally {
    try { lock.releaseLock(); } catch(e) {}

    if (shouldContinue) {
      deleteAllTriggers();
      ScriptApp.newTrigger('mainLoop').timeBased().after(60000).create();
    }
  }
}

/***************
 * Provider Calls
 ***************/
function callOpenAI_(prompts, problem, solution) {
  // ✅ system, user, assistant 프롬프트를 messages에 배열로 구성
  const messages = [
    { role: "system", content: prompts.system }
  ];
  
  // user 프롬프트에 {problem}과 {solution} 플레이스홀더 치환
  const userContent = (prompts.user || '')
    .replace(/\{problem\}/g, problem)
    .replace(/\{solution\}/g, solution);
  messages.push({ role: "user", content: userContent });
  
  // assistant 프롬프트가 있으면 추가 (옵션)
  if (prompts.assistant) {
    messages.push({ role: "assistant", content: prompts.assistant });
  }

  const payload = {
    model: OPENAI_MODEL,
    store: false,
    reasoning: { effort: "none" },
    input: messages,
    text: {
      format: {
        type: "json_schema",
        name: "solution_verification",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            verdict: { type: "string", enum: ["ok", "error", "check", "skip"] },
            error_report: { type: "string" }
          },
          required: ["verdict", "error_report"]
        }
      }
    }
  };

  const res = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + OPENAI_API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    return { verdict: "error", error_report: `HTTP ${res.getResponseCode()}: ${res.getContentText().slice(0, 200)}` };
  }

  const obj = JSON.parse(res.getContentText());
  const text = extractResponseText_(obj);
  try {
    const j = JSON.parse(text);
    return { verdict: j.verdict || "check", error_report: j.error_report || "" };
  } catch (e) {
    return { verdict: "check", error_report: "JSON parse 실패" };
  }
}

function extractResponseText_(resObj) {
  const out = resObj && resObj.output;
  if (!Array.isArray(out)) return "";
  for (const item of out) {
    const content = item && item.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c && typeof c.text === "string") return c.text;
    }
  }
  return "";
}

function callGemini_(prompts, problem, solution) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  
  // ✅ user 프롬프트에 {problem}과 {solution} 플레이스홀더 치환
  let userContent = (prompts.user || '')
    .replace(/\{problem\}/g, problem)
    .replace(/\{solution\}/g, solution);
  
  // ✅ assistant 프롬프트가 있으면 user 프롬프트 뒤에 붙임
  if (prompts.assistant) {
    userContent += '\n\n' + prompts.assistant;
  }
  
  const payload = {
    system_instruction: { parts: [{ text: prompts.system }] },
    contents: [{ parts: [{ text: userContent }] }],
    generationConfig: { response_mime_type: "application/json", temperature: 0.1 }
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    return { verdict: "error", error_report: `HTTP ${res.getResponseCode()}: ${res.getContentText().slice(0, 200)}` };
  }

  const txt = JSON.parse(res.getContentText())?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const match = txt.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: "check", error_report: "JSON 없음" };

  try {
    const j = JSON.parse(match[0].replace(/```json|```/g, "").trim());
    return { verdict: j.verdict || "check", error_report: j.error_report || "" };
  } catch (e) {
    return { verdict: "check", error_report: "JSON parse 실패" };
  }
}

/***************
 * Utils
 ***************/
function deleteAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'mainLoop') ScriptApp.deleteTrigger(t);
  }
}

/**
 * ✅ 새로운 함수: key prefix에 해당하는 system, user, assistant 프롬프트를 모두 가져옴
 * @param {SpreadsheetApp.Spreadsheet} ss
 * @param {string} keyPrefix - 'gpt_solution_verify' 또는 'gemini_solution_verify'
 * @return {Object|null} { system: string, user: string, assistant: string }
 */
function getPromptsByKey_(ss, keyPrefix) {
  const sheet = ss.getSheetByName(SHEET_NAME_PROMPT);
  if (!sheet) return null;
  
  const data = sheet.getDataRange().getValues();
  const prompts = {
    system: '',
    user: '',
    assistant: ''
  };
  
  // 헤더 행 제외하고 검색 (row 0은 헤더)
  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][0]).trim();      // A열: key
    const role = String(data[i][1]).trim();     // B열: role
    const content = String(data[i][2]);         // C열: content
    const enabled = (data[i][3] === true || String(data[i][3]).toUpperCase() === 'TRUE' || data[i][3] === 1);  // D열: enabled
    
    // key가 일치하고 enabled가 true인 경우만
    if (key.startsWith(keyPrefix) && enabled) {
      if (key === keyPrefix + '_system' && role === 'system') {
        prompts.system = content;
      } else if (key === keyPrefix + '_user' && role === 'user') {
        prompts.user = content;
      } else if (key === keyPrefix + '_assistant' && role === 'assistant') {
        prompts.assistant = content;
      }
    }
  }
  
  // system은 필수
  if (!prompts.system) return null;
  
  return prompts;
}

function parseRowRange(text) {
  const t = String(text || "").trim();
  const m = t.match(/^(\d+)-(\d+)$/) || t.match(/^(\d+)$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start;
  return { startRow: start, endRow: end };
}


/*=============================================================================
 * [파트 2] forceResumeFromNext() - 워치독 복구 함수
 *
 * 스크립트가 멈췄을 때 수동으로 또는 워치독이 호출하는 복구 함수
 * - 현재 "RUN" 행을 "TIMEOUT"으로 변경
 * - 다음 행부터 자동 재개
 *=============================================================================*/

function forceResumeFromNext() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME_DATA);

  if (!sheet) {
    Logger.log('Data 시트를 찾을 수 없습니다.');
    return;
  }

  const currentRow = parseInt(props.getProperty(PROP_CURRENT_ROW), 10);
  const endRow = parseInt(props.getProperty(PROP_END_ROW), 10);
  const provider = props.getProperty(PROP_PROVIDER) || 'gpt';

  if (!currentRow || !endRow) {
    Logger.log('진행 중인 작업이 없습니다.');
    return;
  }

  // 현재 행을 TIMEOUT으로 표시
  const currentStatus = sheet.getRange(currentRow, 17).getValue();
  if (currentStatus === 'RUN' || currentStatus === 'PAUSED') {
    sheet.getRange(currentRow, 17).setValue('TIMEOUT');
    sheet.getRange(currentRow, 18).setValue('워치독: API 응답 없음으로 강제 스킵 (' + new Date().toLocaleString() + ')');
    Logger.log('행 ' + currentRow + ': "' + currentStatus + '" → "TIMEOUT"');
  }

  // 기존 트리거 모두 삭제
  deleteAllTriggers();

  const nextRow = currentRow + 1;

  if (nextRow > endRow) {
    props.deleteProperty(PROP_CURRENT_ROW);
    props.deleteProperty(PROP_END_ROW);
    props.deleteProperty(PROP_RUNNING);
    props.deleteProperty(PROP_LAST_TRIGGER_TIME);
    props.deleteProperty(PROP_LAST_ACTIVITY);
    props.deleteProperty(PROP_PROVIDER);
    ss.toast('워치독: 마지막 행이므로 작업 종료', '워치독');
    return;
  }

  // 상태 리셋 후 다음 행부터 재개
  props.setProperties({
    [PROP_CURRENT_ROW]: String(nextRow),
    [PROP_RUNNING]: 'true',
    [PROP_STOP_SIGNAL]: 'false'
  });
  props.deleteProperty(PROP_LAST_TRIGGER_TIME);
  props.deleteProperty(PROP_LAST_ACTIVITY);

  // 5초 후 mainLoop 재시작
  ScriptApp.newTrigger('mainLoop').timeBased().after(5000).create();

  const msg = '워치독: 행 ' + currentRow + ' TIMEOUT → 행 ' + nextRow + '부터 재개 (' + provider.toUpperCase() + ')';
  ss.toast(msg, '워치독 강제 재개');
  Logger.log(msg);
}


/*=============================================================================
 * [파트 3] GAS 자체 워치독 - 20분 간격 감시 트리거
 *
 * 🔑 핵심 원리:
 *   - watchdog_() 함수가 20분마다 실행됨
 *   - mainLoop가 행을 처리할 때마다 PROP_LAST_ACTIVITY를 갱신함
 *   - 만약 LAST_ACTIVITY가 10분 이상 갱신되지 않았으면 → 멈춤으로 판단
 *   - forceResumeFromNext()를 호출하여 복구
 *
 * 🔑 [파트 1]의 행 단위 try-catch와 함께 사용하면 이중 안전장치:
 *   - 1차 방어: try-catch가 대부분의 에러를 잡아서 다음 행으로 넘김
 *   - 2차 방어: 워치독이 try-catch로도 못 잡는 상황을 감시
 *=============================================================================*/

/**
 * 워치독 감시 시작 - 이 함수를 한 번 실행하면 20분 간격 감시가 시작됩니다.
 * (startProcessGPT/startProcessGemini 시작 시 자동으로 호출되게 할 수도 있음)
 */
function startWatchdog() {
  stopWatchdog(); // 기존 워치독 트리거 제거

  ScriptApp.newTrigger('watchdog_')
    .timeBased()
    .everyMinutes(15)  // 15분마다 체크 (GAS 최소 간격)
    .create();

  Logger.log('워치독 시작: 15분 간격 감시');
  SpreadsheetApp.getActiveSpreadsheet().toast('워치독 감시 시작 (15분 간격)', '워치독');
}

/**
 * 워치독 감시 중지
 */
function stopWatchdog() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'watchdog_') {
      ScriptApp.deleteTrigger(t);
    }
  }
  Logger.log('워치독 감시 중지');
}

/**
 * 워치독 내부 함수 - 트리거에 의해 자동 호출
 */
function watchdog_() {
  const props = PropertiesService.getScriptProperties();

  // 1. 작업이 실행 중인지 확인
  if (props.getProperty(PROP_RUNNING) !== 'true') {
    Logger.log('워치독: 실행 중인 작업 없음 → 패스');
    return;
  }

  // 2. 마지막 활동 시각 확인
  const lastActivity = parseInt(props.getProperty(PROP_LAST_ACTIVITY) || '0', 10);
  const now = Date.now();
  const elapsedMin = (now - lastActivity) / 60000;

  // 3. 10분 이상 활동 없으면 → 멈춤으로 판단
  const TIMEOUT_MINUTES = 10;

  if (lastActivity === 0) {
    Logger.log('워치독: LAST_ACTIVITY 없음 → 첫 실행이거나 구버전 코드');
    return;
  }

  if (elapsedMin < TIMEOUT_MINUTES) {
    Logger.log('워치독: 정상 동작 중 (마지막 활동 ' + elapsedMin.toFixed(1) + '분 전)');
    return;
  }

  // 4. 멈춤 감지! → 강제 복구
  Logger.log('워치독: ⚠️ ' + elapsedMin.toFixed(1) + '분간 활동 없음 → 강제 복구 실행');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME_DATA);
  const currentRow = props.getProperty(PROP_CURRENT_ROW);

  if (sheet && currentRow) {
    ss.toast(
      '행 ' + currentRow + '에서 ' + elapsedMin.toFixed(0) + '분간 멈춤 감지 → 강제 복구',
      '⚠️ 워치독 경고'
    );
  }

  // 5. forceResumeFromNext 호출
  forceResumeFromNext();
}


/**
 * 현재 상태 확인 (디버깅/모니터링용)
 */
function checkRunStatus() {
  const props = PropertiesService.getScriptProperties();
  const lastActivity = parseInt(props.getProperty(PROP_LAST_ACTIVITY) || '0', 10);
  const status = {
    running: props.getProperty(PROP_RUNNING),
    currentRow: props.getProperty(PROP_CURRENT_ROW),
    endRow: props.getProperty(PROP_END_ROW),
    provider: props.getProperty(PROP_PROVIDER),
    stopSignal: props.getProperty(PROP_STOP_SIGNAL),
    lastTrigger: props.getProperty(PROP_LAST_TRIGGER_TIME),
    lastActivity: lastActivity ? new Date(lastActivity).toLocaleString() : 'N/A',
    elapsedMinutes: lastActivity ? ((Date.now() - lastActivity) / 60000).toFixed(1) : 'N/A'
  };
  Logger.log(JSON.stringify(status, null, 2));
  return status;
}
