/**
 * Configuration
 */
const CONFIG = {
  DATA_SHEET_NAME: "Data_DS",
  PMT_SHEET_NAME: "pmt",
  
  // 실제 존재하는 모델
  GPT_MODEL: "gpt-5.2",
  GEMINI_MODEL: "gemini-2.5-pro",
  
  TEMPERATURE: 0.0,
  MAX_EXECUTION_TIME_MS: 1000 * 60 * 4.5, // 4.5분
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 2000,
  BATCH_SIZE: 50, // 한 번에 처리할 행 수
};

/**
 * Mainmenu.gs에서 호출할 전용 함수들
 */
function runWithGpt() { startProblemValidation("GPT"); }
function runWithGemini() { startProblemValidation("GEMINI"); }

/**
 * 1. 실행 시작 함수
 */
function startProblemValidation(selectedModel) {
  const ui = SpreadsheetApp.getUi();

  const rangeInput = ui.prompt(
    `[${selectedModel} 모드] 검증할 행 범위를 입력하세요 (예: 2-100)`,
    ui.ButtonSet.OK_CANCEL
  );
  if (rangeInput.getSelectedButton() === ui.Button.CANCEL) return;

  const rangeStr = rangeInput.getResponseText().trim();
  const parts = rangeStr.split('-').map(s => s.trim());
  if (parts.length !== 2) { 
    ui.alert('행 범위 형식이 올바르지 않습니다. (예: 2-100)'); 
    return; 
  }

  const startRow = parseInt(parts[0], 10);
  const endRow = parseInt(parts[1], 10);

  if (isNaN(startRow) || isNaN(endRow) || startRow < 2 || endRow < startRow) {
    ui.alert('유효하지 않은 행 범위입니다.');
    return;
  }

  // 트리거 및 상태 초기화
  deleteQueueTriggers_();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('STOP_REQUESTED', 'false');
  props.setProperty('SELECTED_MODEL', selectedModel); 
  props.setProperty('CURRENT_ROW', String(startRow));
  props.setProperty('END_ROW', String(endRow));
  props.setProperty('START_ROW', String(startRow));

  ui.alert(`${selectedModel} 모델로 행 ${startRow} ~ ${endRow} 검증을 시작합니다.`);
  processValidationQueue();
}

/**
 * 2. 메인 큐 처리 로직 (배치 처리)
 */
function processValidationQueue() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('STOP_REQUESTED') === 'true') {
    deleteQueueTriggers_();
    SpreadsheetApp.getActiveSpreadsheet().toast('작업이 사용자에 의해 중단되었습니다.');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(CONFIG.DATA_SHEET_NAME);
  if (!dataSheet) {
    ss.toast(`에러: '${CONFIG.DATA_SHEET_NAME}' 시트를 찾을 수 없습니다.`);
    return;
  }
  
  const startTime = Date.now();
  const activeModel = props.getProperty('SELECTED_MODEL');
  let currentRow = parseInt(props.getProperty('CURRENT_ROW'), 10);
  const endRow = parseInt(props.getProperty('END_ROW'), 10);

  const prefix = activeModel.toLowerCase() + "_problem_verify";
  const promptSet = getPromptSet(prefix);
  
  if (!promptSet.system || !promptSet.user) {
    ss.toast(`에러: pmt 시트에서 '${prefix}' 설정을 찾을 수 없습니다.`);
    return;
  }

  // 배치 크기 계산
  const batchSize = Math.min(CONFIG.BATCH_SIZE, endRow - currentRow + 1);
  
  // 필요한 열만 읽기: E열(5)과 K열(11)
  const stemRange = dataSheet.getRange(currentRow, 5, batchSize, 1); // E열: 문제
  const answerTypeRange = dataSheet.getRange(currentRow, 11, batchSize, 1); // K열: 답안 유형
  
  const stemData = stemRange.getValues();
  const answerTypeData = answerTypeRange.getValues();

  let rowsProcessed = 0;

  for (let i = 0; i < batchSize && currentRow <= endRow; i++) {
    if (props.getProperty('STOP_REQUESTED') === 'true') break;

    if (Date.now() - startTime > CONFIG.MAX_EXECUTION_TIME_MS) {
      props.setProperty('CURRENT_ROW', String(currentRow));
      setContinueTrigger();
      ss.toast(`시간 제한으로 일시 중지. ${currentRow}행부터 재개됩니다.`);
      return;
    }

    try {
      // 상태 업데이트 (P열)
      dataSheet.getRange(currentRow, 16).setValue(`RUNNING (${activeModel})...`);
      SpreadsheetApp.flush();

      const stem = String(stemData[i][0] || "").trim(); // E열 문제
      const answerTypeRaw = String(answerTypeData[i][0] || "").trim(); // K열 답안 유형
      
      // 문제가 비어있는지 확인
      if (stem === "") {
        throw new Error(`E열(문제)이 비어있습니다.`);
      }
      
      const formatGuide = getFormatGuide(answerTypeRaw);

      // {problem}과 {format} 치환 (중괄호 1개)
      const finalUserContent = promptSet.user
        .replace("{problem}", stem)
        .replace("{format}", formatGuide);

      let result;
      if (activeModel === "GPT") {
        result = callGptAPIWithRetry(promptSet.system, finalUserContent, promptSet.assistant);
      } else {
        result = callGeminiAPIWithRetry(promptSet.system, finalUserContent, promptSet.assistant);
      }

      // 결과 기록 (N, O, P열)
      dataSheet.getRange(currentRow, 14).setValue(result.verdict); // N열: 판정
      dataSheet.getRange(currentRow, 15).setValue(result.derived_answer); // O열: 도출된 답
      dataSheet.getRange(currentRow, 16).setValue(result.solution_note); // P열: 해설

      rowsProcessed++;

    } catch (e) {
      Logger.log(`Row ${currentRow} error: ${e.message}`);
      dataSheet.getRange(currentRow, 14).setValue("error");
      dataSheet.getRange(currentRow, 16).setValue(`[${activeModel} Error]: ` + e.message);
    }

    currentRow++;
    props.setProperty('CURRENT_ROW', String(currentRow));
  }
  
  if (currentRow > endRow) {
    finishRun_();
  } else {
    props.setProperty('CURRENT_ROW', String(currentRow));
    setContinueTrigger();
  }
}

/**
 * 3. pmt 시트 로드
 */
function getPromptSet(prefix) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PMT_SHEET_NAME);
  if (!sheet) {
    throw new Error(`'${CONFIG.PMT_SHEET_NAME}' 시트를 찾을 수 없습니다.`);
  }
  
  const data = sheet.getDataRange().getValues();
  let set = { system: "", user: "", assistant: "" };

  for (let i = 1; i < data.length; i++) {
    const [key, role, content, enabled] = data[i];
    const isEnabled = (enabled === true) || (String(enabled).toUpperCase() === "TRUE");

    if (key && String(key).startsWith(prefix) && isEnabled) {
      const roleStr = String(role).toLowerCase();
      if (roleStr === "system") set.system = String(content || "");
      if (roleStr === "user") set.user = String(content || "");
      if (roleStr === "assistant") set.assistant = String(content || "");
    }
  }
  
  return set;
}

/**
 * 4. K열 유형에 따른 동적 정답 가이드
 */
function getFormatGuide(type) {
  const t = String(type).toLowerCase();
  if (t.includes("combo")) return "옳은 선택지 조합 (예: 'ㄱ' 또는 'ㄱ, ㄴ' 등)";
  if (t.includes("math")) return "설명 없는 단일 수치 (LaTeX $...$ 사용 가능)";
  if (t.includes("int")) return "1~999 사이의 자연수";
  return "표준 수치 형식";
}

/**
 * 5. GPT API 인터페이스 (재시도 로직 포함)
 */
function callGptAPIWithRetry(sys, usr, ast) {
  for (let attempt = 0; attempt < CONFIG.MAX_RETRIES; attempt++) {
    try {
      return callGptAPI(sys, usr, ast);
    } catch (e) {
      if (attempt === CONFIG.MAX_RETRIES - 1) throw e;
      Logger.log(`GPT API retry ${attempt + 1}/${CONFIG.MAX_RETRIES}: ${e.message}`);
      Utilities.sleep(CONFIG.RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

function callGptAPI(sys, usr, ast) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");
  
  const messages = [
    { role: "system", content: sys },
    { role: "user", content: usr }
  ];
  if (ast && ast.trim() !== "") {
    messages.push({ role: "assistant", content: ast });
  }

  const payload = {
    model: CONFIG.GPT_MODEL,
    messages: messages,
    response_format: { type: "json_object" },
    temperature: CONFIG.TEMPERATURE
  };

  const options = {
    method: "post", 
    contentType: "application/json",
    headers: { Authorization: "Bearer " + apiKey },
    payload: JSON.stringify(payload), 
    muteHttpExceptions: true
  };

  const resp = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", options);
  const code = resp.getResponseCode();
  
  if (code !== 200) {
    const errorText = resp.getContentText();
    throw new Error(`GPT API Error (${code}): ${errorText}`);
  }
  
  return parseResponse(resp.getContentText(), "gpt");
}

/**
 * 6. Gemini API 인터페이스 (재시도 로직 포함)
 */
function callGeminiAPIWithRetry(sys, usr, ast) {
  for (let attempt = 0; attempt < CONFIG.MAX_RETRIES; attempt++) {
    try {
      return callGeminiAPI(sys, usr, ast);
    } catch (e) {
      if (attempt === CONFIG.MAX_RETRIES - 1) throw e;
      Logger.log(`Gemini API retry ${attempt + 1}/${CONFIG.MAX_RETRIES}: ${e.message}`);
      Utilities.sleep(CONFIG.RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

function callGeminiAPI(sys, usr, ast) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");
  
  const contents = [
    { role: "user", parts: [{ text: usr }] }
  ];
  
  if (ast && ast.trim() !== "") {
    contents.push({ role: "model", parts: [{ text: ast }] });
  }

  const payload = {
    system_instruction: { parts: [{ text: sys }] },
    contents: contents,
    generationConfig: { 
      response_mime_type: "application/json", 
      temperature: CONFIG.TEMPERATURE 
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const options = { 
    method: "post", 
    contentType: "application/json", 
    payload: JSON.stringify(payload), 
    muteHttpExceptions: true 
  };
  
  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();
  
  if (code !== 200) {
    const errorText = resp.getContentText();
    throw new Error(`Gemini API Error (${code}): ${errorText}`);
  }
  
  return parseResponse(resp.getContentText(), "gemini");
}

/**
 * 7. 결과 파싱
 */
function parseResponse(text, type) {
  try {
    const json = JSON.parse(text);
    let content;
    
    if (type === "gpt") {
      content = json.choices?.[0]?.message?.content;
    } else {
      content = json.candidates?.[0]?.content?.parts?.[0]?.text;
    }
    
    if (!content) throw new Error("응답에서 content를 찾을 수 없습니다.");
    
    // JSON 코드 블록 제거
    const cleanContent = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleanContent);
    
    // 필드 정규화
    parsed.verdict = (parsed.verdict || "error").toLowerCase();
    parsed.derived_answer = String(parsed.derived_answer || "");
    parsed.solution_note = String(parsed.solution_note || "");
    
    // verdict가 error인데 derived_answer가 있으면 경고
    if (parsed.verdict === "error" && parsed.derived_answer !== "") {
      Logger.log(`Warning: verdict=error but derived_answer is not empty. Clearing derived_answer.`);
      parsed.derived_answer = "";
    }
    
    // verdict가 error인데 solution_note가 없으면 기본 메시지
    if (parsed.verdict === "error" && parsed.solution_note === "") {
      parsed.solution_note = "문제 해결 실패 또는 답 확정 불가";
    }
    
    return parsed;
  } catch (e) {
    Logger.log(`Parse error: ${e.message}, Raw text: ${text}`);
    return {
      verdict: "error",
      derived_answer: "",
      solution_note: `JSON 파싱 실패: ${e.message}`
    };
  }
}

/**
 * 8. 유틸리티 함수들
 */
function setContinueTrigger() {
  deleteQueueTriggers_();
  ScriptApp.newTrigger('processValidationQueue')
    .timeBased()
    .after(60 * 1000) // 1분 후
    .create();
}

function deleteQueueTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'processValidationQueue') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}

function finishRun_() {
  deleteQueueTriggers_();
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty('SELECTED_MODEL');
  const startRow = props.getProperty('START_ROW');
  const endRow = props.getProperty('END_ROW');
  
  SpreadsheetApp.getActiveSpreadsheet().toast(
    `${model} 검증 작업이 완료되었습니다! (행 ${startRow} ~ ${endRow})`
  );
  
  // 상태 초기화
  props.deleteProperty('CURRENT_ROW');
  props.deleteProperty('END_ROW');
  props.deleteProperty('START_ROW');
  props.deleteProperty('SELECTED_MODEL');
  props.deleteProperty('STOP_REQUESTED');
}

/**
 * 9. 디버깅 함수
 */
function debugPromptAndData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  Logger.log("=== PMT 시트 확인 ===");
  const promptSet = getPromptSet("gpt_problem_verify");
  Logger.log(`System length: ${promptSet.system.length}`);
  Logger.log(`User length: ${promptSet.user.length}`);
  Logger.log(`Assistant length: ${promptSet.assistant.length}`);
  Logger.log(`\nUser prompt contains {problem}: ${promptSet.user.includes("{problem}")}`);
  Logger.log(`User prompt contains {format}: ${promptSet.user.includes("{format}")}`);
  
  Logger.log("\n=== Data_DS 시트 확인 ===");
  const dataSheet = ss.getSheetByName(CONFIG.DATA_SHEET_NAME);
  const testRow = 2;
  const stem = dataSheet.getRange(testRow, 5).getValue();
  const answerType = dataSheet.getRange(testRow, 11).getValue();
  
  Logger.log(`행 ${testRow} E열 (문제): ${String(stem).substring(0, 100)}`);
  Logger.log(`행 ${testRow} K열 (답안유형): ${answerType}`);
  
  Logger.log("\n=== 치환 테스트 ===");
  const formatGuide = getFormatGuide(answerType);
  const finalContent = promptSet.user
    .replace("{problem}", stem)
    .replace("{format}", formatGuide);
  
  Logger.log(`치환 전 길이: ${promptSet.user.length}`);
  Logger.log(`치환 후 길이: ${finalContent.length}`);
  Logger.log(`치환 후 {problem} 포함 여부: ${finalContent.includes("{problem}")}`);
  Logger.log(`치환 후 preview:\n${finalContent.substring(0, 200)}`);
}