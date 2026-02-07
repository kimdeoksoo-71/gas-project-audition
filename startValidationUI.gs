/**
* Configuration
*/
const CONFIG = {
 SHEET_NAME: "Data_DS",
 PROMPT_SHEET_NAME: "prompt",
 TARGET_PROMPT_KEY: "math_validation",


 MODEL: "gpt-5.2",
 TEMPERATURE: 0.15,


 MAX_EXECUTION_TIME_MS: 1000 * 60 * 5,
 API_KEY_PROPERTY: "OPENAI_API_KEY"
};




/**
* 1. UI를 통해 검증할 범위 입력 및 초기화 (정리된 버전)
*/
function startValidationUI() {
 const ui = SpreadsheetApp.getUi();


 const input = ui.prompt(
   '검증할 행 범위를 입력하세요 (예: 2:100)',
   ui.ButtonSet.OK_CANCEL
 );
 if (input.getSelectedButton() === ui.Button.CANCEL) return;


 const rangeStr = (input.getResponseText() || "").trim();
 const parts = rangeStr.split(':').map(s => s.trim());


 if (parts.length !== 2) {
   ui.alert('형식이 올바르지 않습니다. 예: 2:100');
   return;
 }


 const startRow = parseInt(parts[0], 10);
 const endRow   = parseInt(parts[1], 10);


 if (!Number.isInteger(startRow) || !Number.isInteger(endRow)) {
   ui.alert('숫자를 입력해주세요.');
   return;
 }
 if (startRow < 2 || endRow < 2) {
   ui.alert('행 번호는 2 이상으로 입력해주세요. (헤더 제외)');
   return;
 }
 if (startRow > endRow) {
   ui.alert('시작 행이 끝 행보다 클 수 없습니다.');
   return;
 }


 // ✅ (중요) 이전 실행에서 남은 트리거가 있으면 먼저 정리
 deleteQueueTriggers_();


 // ✅ 새 실행 상태 초기화
 const props = PropertiesService.getScriptProperties();
 props.setProperty('STOP_REQUESTED', 'false');
 props.setProperty('CURRENT_ROW', String(startRow));
 props.setProperty('END_ROW', String(endRow));


 // ✅ 디버그: 시작 상태 확인 (원하면 나중에 지워도 됨)
 SpreadsheetApp.getActiveSpreadsheet().toast(
   'DEBUG start: STOP_REQUESTED=' + props.getProperty('STOP_REQUESTED')
 );


 ui.alert(`행 ${startRow}부터 ${endRow}까지 풀이/검증을 시작합니다. (모델: ${CONFIG.MODEL})`);


 // 바로 실행
 processValidationQueue();
}




/**
* 2. 실제 검증 로직 (반복 실행)
* - P열에 RUNNING 흔적 먼저 기록
* - verdict=error이면 답(O)은 비우고, P에 로그만 기록
* - verdict=ok일 때만 답 형식 검증 수행
*/
function processValidationQueue() {
 const props = PropertiesService.getScriptProperties();


 // 이미 중단 요청 상태면 트리거만 정리하고 종료
 if (props.getProperty('STOP_REQUESTED') === 'true') {
   deleteQueueTriggers_();
   return;
 }


 const ss = SpreadsheetApp.getActiveSpreadsheet();
 const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
 if (!sheet) {
   SpreadsheetApp.getUi().alert(`에러: 시트 '${CONFIG.SHEET_NAME}' 를 찾을 수 없습니다.`);
   deleteQueueTriggers_();
   return;
 }


 const systemPrompt = getPromptFromSheet(CONFIG.TARGET_PROMPT_KEY);
 if (!systemPrompt) {
   SpreadsheetApp.getUi().alert(
     `에러: prompt 시트에서 Key='${CONFIG.TARGET_PROMPT_KEY}', Enabled=TRUE 항목을 찾을 수 없습니다.`
   );
   deleteQueueTriggers_();
   return;
 }


 const startTime = Date.now();
 let currentRow = parseInt(props.getProperty('CURRENT_ROW'), 10);
 const endRow = parseInt(props.getProperty('END_ROW'), 10);


 if (!currentRow || !endRow || currentRow > endRow) {
   finishRun_();
   return;
 }


 // ✅ 디버그: 루프 진입 전 상태 표시
 ss.toast(`DEBUG loop: row ${currentRow}..${endRow}, STOP=${props.getProperty('STOP_REQUESTED')}`);


 while (currentRow <= endRow) {
   if (props.getProperty('STOP_REQUESTED') === 'true') {
     ss.toast('사용자 요청으로 작업을 중단합니다.');
     stopRun_();
     return;
   }


   if (Date.now() - startTime > CONFIG.MAX_EXECUTION_TIME_MS) {
     props.setProperty('CURRENT_ROW', String(currentRow));
     setContinueTrigger();
     ss.toast(`시간 초과로 이어서 실행 예약: 다음 시작 행 ${currentRow}`);
     return;
   }


   try {
     // ✅ (핵심) 처리 시작 흔적 먼저 남기기: P열
     sheet.getRange(currentRow, 16).setValue(`RUNNING @ ${new Date().toISOString()}`);


     const stem = sheet.getRange(currentRow, 5).getValue();            // E열
     const answerTypeRaw = sheet.getRange(currentRow, 11).getValue();  // K열
     const answerType = normalizeAnswerType_(answerTypeRaw);


     const gptResult = callGptAPI(systemPrompt, stem, answerType);


     const verdict = (gptResult.verdict || "").toString().trim().toLowerCase();
     const solutionNote = gptResult.solution_note || "";
     const derivedAnswer = gptResult.derived_answer || "";


     if (verdict === "error") {
       sheet.getRange(currentRow, 14).setValue("error"); // N
       sheet.getRange(currentRow, 15).setValue("");      // O
       sheet.getRange(currentRow, 16).setValue(
         "MODEL_FAILED_TO_SOLVE\n" + (solutionNote ? solutionNote : "")
       ); // P
     } else if (verdict === "ok") {
       const v = validateAnswerFormat_(answerType, derivedAnswer);
       if (!v.ok) {
         sheet.getRange(currentRow, 14).setValue("skip"); // N
         sheet.getRange(currentRow, 15).setValue("");     // O
         sheet.getRange(currentRow, 16).setValue(`FORMAT_ERROR: ${v.msg}\n` + solutionNote); // P
       } else {
         sheet.getRange(currentRow, 14).setValue("ok");          // N
         sheet.getRange(currentRow, 15).setValue(derivedAnswer); // O
         sheet.getRange(currentRow, 16).setValue(solutionNote);  // P
       }
     } else {
       sheet.getRange(currentRow, 14).setValue("skip"); // N
       sheet.getRange(currentRow, 15).setValue("");     // O
       sheet.getRange(currentRow, 16).setValue(
         `FORMAT_ERROR: verdict must be "ok" or "error"\n` + solutionNote
       ); // P
     }


   } catch (e) {
     console.error(`Row ${currentRow} Error: ${e.message}`);
     sheet.getRange(currentRow, 14).setValue("skip"); // N
     sheet.getRange(currentRow, 15).setValue("");     // O
     sheet.getRange(currentRow, 16).setValue(`System Error: ${e.message}`); // P
   }


   currentRow++;
   props.setProperty('CURRENT_ROW', String(currentRow));
 }


 finishRun_();
}




/**
* 3. 프롬프트 시트에서 데이터 가져오기
*  - A: key, B: content, C: enabled (TRUE)
*  - enabled가 TRUE(boolean) 또는 "TRUE"(string) 모두 허용
*/
function getPromptFromSheet(targetKey) {
 const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.PROMPT_SHEET_NAME);
 if (!sheet) return null;


 const data = sheet.getDataRange().getValues();
 for (let i = 1; i < data.length; i++) {
   const rowKey = data[i][0];
   const rowContent = data[i][1];
   const rowEnabled = data[i][2];


   const enabled = (rowEnabled === true) || (String(rowEnabled).toUpperCase() === "TRUE");


   if (rowKey === targetKey && enabled) {
     return rowContent;
   }
 }
 return null;
}




/**
* 4. GPT API 호출 함수
* - user 메시지는 문제 + answerType만
* - response_format=json_object
*/
function callGptAPI(systemPrompt, stem, answerType) {
 const apiKey = PropertiesService.getScriptProperties().getProperty(CONFIG.API_KEY_PROPERTY);
 if (!apiKey) throw new Error("API Key is missing in Script Properties.");


 const userContent = `
[Problem Stem]
${stem}


[Answer Type]
${answerType}
`.trim();


 const payload = {
   model: CONFIG.MODEL,
   messages: [
     { role: "system", content: systemPrompt },
     { role: "user", content: userContent }
   ],
   response_format: { type: "json_object" },
   temperature: CONFIG.TEMPERATURE
 };


 const options = {
   method: "post",
   contentType: "application/json",
   headers: { "Authorization": "Bearer " + apiKey },
   payload: JSON.stringify(payload),
   muteHttpExceptions: true
 };


 const response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", options);
 const code = response.getResponseCode();
 const text = response.getContentText();
 if (code !== 200) throw new Error(`API Request Failed (${code}): ${text}`);


 const json = JSON.parse(text);
 let cleanContent = json.choices?.[0]?.message?.content || "";


 // 코드펜스 제거(혹시 섞여 나오면)
 cleanContent = cleanContent.replace(/```json/g, "").replace(/```/g, "").trim();


 let parsed;
 try {
   parsed = JSON.parse(cleanContent);
 } catch (e) {
   console.error("JSON Parse Error Content:", cleanContent);
   throw new Error("Failed to parse JSON response from GPT");
 }


 // LaTeX 백슬래시 청소 (\\ -> \)
 if (parsed.solution_note) parsed.solution_note = String(parsed.solution_note).replace(/\\\\/g, '\\');
 if (parsed.derived_answer) parsed.derived_answer = String(parsed.derived_answer).replace(/\\\\/g, '\\');


 // verdict 정리
 parsed.verdict = (parsed.verdict || "").toString().trim().toLowerCase();


 // error면 derived_answer 강제 비우기
 if (parsed.verdict === "error") parsed.derived_answer = "";


 if (!parsed.solution_note) parsed.solution_note = "";
 if (!parsed.derived_answer) parsed.derived_answer = "";


 return parsed;
}




/**
* AnswerType 정규화
*/
function normalizeAnswerType_(v) {
 const s = (v ?? "").toString().trim();
 const low = s.toLowerCase();


 if (low === "mcq_combo") return "mcq_combo";
 if (low === "mcq_math") return "mcq_math";
 if (low === "short_integer") return "short_integer";


 if (low === "short_int" || low === "shortint") return "short_integer";
 if (low.includes("combo")) return "mcq_combo";
 if (low.includes("mcq") && low.includes("math")) return "mcq_math";


 return "mcq_math";
}




/**
* 답 형식 검증 (verdict=ok일 때만 호출)
*/
function validateAnswerFormat_(answerType, derivedAnswerRaw) {
 const ans = (derivedAnswerRaw ?? "").toString().trim();
 if (!ans) return { ok: false, msg: "derived_answer is empty" };


 if (answerType === "mcq_combo") {
   const parts = ans.split(",").map(s => s.trim()).filter(Boolean);
   if (parts.length === 0) return { ok: false, msg: "mcq_combo: empty" };


   const re = /^[ㄱ-ㅎ]$/;
   for (const p of parts) {
     if (!re.test(p)) return { ok: false, msg: `mcq_combo: invalid token '${p}'` };
   }
   const set = new Set(parts);
   if (set.size !== parts.length) return { ok: false, msg: "mcq_combo: duplicate choices" };
   if (parts.join(", ") !== ans) return { ok: false, msg: 'mcq_combo: must be formatted like "ㄱ, ㄴ"' };


   return { ok: true, msg: "" };
 }


 if (answerType === "short_integer") {
   let s = ans.replace(/\s+/g, "");
   if (s.startsWith("$") && s.endsWith("$")) s = s.slice(1, -1);


   if (!/^\d+$/.test(s)) return { ok: false, msg: "short_integer: digits only (optionally $...$)" };
   const n = parseInt(s, 10);
   if (!(1 <= n && n <= 999)) return { ok: false, msg: "short_integer: must be 1..999" };


   return { ok: true, msg: "" };
 }


 // mcq_math: 최소 금지 규칙
 if (/[ㄱ-ㅎ]/.test(ans)) return { ok: false, msg: "mcq_math: must not include choice letters" };
 if (ans.includes("=")) return { ok: false, msg: "mcq_math: must be a value, not an equation" };
 if (/[가-힣]/.test(ans)) return { ok: false, msg: "mcq_math: must not include Korean text" };


 return { ok: true, msg: "" };
}




/**
* 유틸: 연속 실행 트리거
*/
function setContinueTrigger() {
 // 기존 트리거(동일 핸들러) 제거
 deleteQueueTriggers_();


 ScriptApp.newTrigger('processValidationQueue')
   .timeBased()
   .after(1000 * 60)
   .create();
}




/**
* 트리거만 삭제 (STOP 플래그 건드리지 않음)
*/
function deleteQueueTriggers_() {
 const triggers = ScriptApp.getProjectTriggers();
 for (const trigger of triggers) {
   if (trigger.getHandlerFunction() === 'processValidationQueue') {
     ScriptApp.deleteTrigger(trigger);
   }
 }
}


/**
* 중단 요청 플래그만 세팅 (트리거는 그대로 두고, 루프에서 자연 종료하도록)
*/
function requestStop_() {
 PropertiesService.getScriptProperties().setProperty('STOP_REQUESTED', 'true');
}


/**
* 정상 완료 처리: 트리거 삭제 + 완료 토스트
* (STOP_REQUESTED는 건드리지 않음)
*/
function finishRun_() {
 deleteQueueTriggers_();
 try {
   SpreadsheetApp.getActiveSpreadsheet().toast('모든 작업이 완료되었습니다.');
 } catch (e) {}
}


/**
* 사용자 중단 처리: STOP=true + 트리거 삭제 + 중단 토스트
*/
function stopRun_() {
 requestStop_();
 deleteQueueTriggers_();
 try {
   SpreadsheetApp.getActiveSpreadsheet().toast('작업이 중단되었습니다. (현재 처리 중인 건이 끝나면 멈춥니다)');
 } catch (e) {}
}



