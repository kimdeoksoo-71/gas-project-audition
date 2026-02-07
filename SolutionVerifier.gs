/**
 * Gemini 2.5 Pro - 자동 재개형 수학 검증 (안정성 개선 버전)
 */

const API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
const MODEL_NAME = 'gemini-2.5-pro'; 

const SHEET_NAME_DATA = 'Data_DS';
const SHEET_NAME_PROMPT = 'prompt';
const PROMPT_KEY_TARGET = 'solution_verify_gemini'; 

const PROP_CURRENT_ROW = 'AUTO_CURRENT_ROW';
const PROP_END_ROW = 'AUTO_END_ROW';
const PROP_STOP_SIGNAL = 'AUTO_STOP_SIGNAL';
const PROP_RUNNING = 'AUTO_RUNNING';
const PROP_LAST_TRIGGER_TIME = 'AUTO_LAST_TRIGGER';

function startAutomaticProcess() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  if (!API_KEY) { 
    ui.alert('API 키가 설정되지 않았습니다.'); 
    return; 
  }

  // 이미 실행 중인지 확인
  if (props.getProperty(PROP_RUNNING) === 'true') {
    ui.alert('이미 작업이 실행 중입니다.');
    return;
  }

  // 모든 상태 초기화
  props.setProperty(PROP_STOP_SIGNAL, 'false');
  props.deleteProperty(PROP_LAST_TRIGGER_TIME);
  deleteAllTriggers();

  const input = ui.prompt('범위 입력', '전체 범위를 입력하세요 (예: 2-200)', ui.ButtonSet.OK_CANCEL);
  if (input.getSelectedButton() !== ui.Button.OK) return;

  const range = parseRowRange(input.getResponseText());
  if (!range) { 
    ui.alert('형식이 잘못되었습니다.'); 
    return; 
  }

  props.setProperties({
    [PROP_CURRENT_ROW]: String(range.startRow),
    [PROP_END_ROW]: String(range.endRow),
    [PROP_RUNNING]: 'true'
  });

  ss.toast(`${range.startRow}행부터 자동 검수를 시작합니다.`, '자동화 시작');
  mainLoop();
}

function forceStopProcess() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_STOP_SIGNAL, 'true');
  props.deleteProperty(PROP_RUNNING);
  props.deleteProperty(PROP_LAST_TRIGGER_TIME);
  deleteAllTriggers();
  SpreadsheetApp.getActiveSpreadsheet().toast('작업을 완전히 중단했습니다.', '중단 알림');
}

function mainLoop() {
  const lock = LockService.getScriptLock();
  const props = PropertiesService.getScriptProperties();
  
  // 중복 실행 방지: 마지막 트리거 시간 체크
  const now = Date.now();
  const lastTrigger = parseInt(props.getProperty(PROP_LAST_TRIGGER_TIME) || '0');
  
  if (now - lastTrigger < 30000) { // 30초 이내 중복 실행 방지
    console.log("중복 실행 감지. 종료.");
    return;
  }
  
  props.setProperty(PROP_LAST_TRIGGER_TIME, String(now));
  
  // Lock 획득 실패시 조용히 종료
  if (!lock.tryLock(5000)) {
    console.warn("Lock 획득 실패. 이미 다른 인스턴스 실행 중.");
    return;
  }

  const startTime = Date.now(); 
  const MAX_RUNTIME = 270000; // 4.5분
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(SHEET_NAME_DATA);
  const systemInstruction = getSystemPrompt(ss);

  if (!systemInstruction) {
    lock.releaseLock();
    props.deleteProperty(PROP_RUNNING);
    return;
  }

  let shouldContinue = false;

  try {
    let currentRow = parseInt(props.getProperty(PROP_CURRENT_ROW));
    const endRow = parseInt(props.getProperty(PROP_END_ROW));

    while (currentRow <= endRow) {
      
      // 1. 중단 체크
      if (props.getProperty(PROP_STOP_SIGNAL) === 'true') {
        dataSheet.getRange(currentRow, 17).setValue("STOP (USER)");
        props.deleteProperty(PROP_RUNNING);
        props.deleteProperty(PROP_LAST_TRIGGER_TIME);
        SpreadsheetApp.flush();
        lock.releaseLock();
        return;
      }

      // 2. API 안정성을 위한 짧은 대기
      Utilities.sleep(1000);

      dataSheet.getRange(currentRow, 17).setValue("RUN");
      SpreadsheetApp.flush();

      const rowData = dataSheet.getRange(currentRow, 1, 1, 5).getValues()[0];
      const solution = rowData[2]; 
      const problem = rowData[4]; 

      if (problem && solution) {
        try {
          const response = UrlFetchApp.fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${API_KEY}`, 
            {
              method: "post",
              contentType: "application/json",
              payload: JSON.stringify({
                system_instruction: { parts: [{ text: systemInstruction }] },
                contents: [{ parts: [{ text: `[문제]\n${problem}\n[풀이]\n${solution}` }] }],
                generationConfig: { response_mime_type: "application/json", temperature: 0.1 }
              }),
              muteHttpExceptions: true
            }
          );

          if (response.getResponseCode() === 200) {
            const resText = JSON.parse(response.getContentText())?.candidates?.[0]?.content?.parts?.[0]?.text || "";
            const match = resText.match(/\{[\s\S]*\}/); 
            let verdict = "Parse Error", report = resText;

            if (match) {
              try {
                const cleanJson = match[0].replace(/```json|```/g, "").trim();
                const parsed = JSON.parse(cleanJson);
                verdict = parsed.verdict || "Check";
                report = parsed.error_report || "";
              } catch (e) {
                verdict = "JSON Error";
                report = "해석 실패: " + resText.slice(0, 100);
              }
            }
            dataSheet.getRange(currentRow, 17, 1, 2).setValues([[verdict, report]]);
          } else {
            const errorMsg = `HTTP ${response.getResponseCode()}`;
            dataSheet.getRange(currentRow, 17).setValue("FAIL: " + errorMsg);
            console.error(`API Error at row ${currentRow}: ${errorMsg}`);
          }
        } catch (apiError) {
          console.error(`API Error at row ${currentRow}:`, apiError);
          dataSheet.getRange(currentRow, 17).setValue("API_ERR: " + apiError.toString().slice(0, 30));
        }
      } else {
        dataSheet.getRange(currentRow, 17).setValue("SKIP");
      }

      // 3. 현재 행 완료 후 진행
      currentRow++;
      props.setProperty(PROP_CURRENT_ROW, String(currentRow)); 
      SpreadsheetApp.flush();

      // 4. 시간 체크 (행 처리 후에 확인)
      if (Date.now() - startTime > MAX_RUNTIME) {
        dataSheet.getRange(currentRow, 17).setValue("PAUSED");
        SpreadsheetApp.flush();
        shouldContinue = true;
        break;
      }
    }

    // while 루프 종료 후 처리
    if (shouldContinue) {
      ss.toast(`${currentRow}행에서 일시정지. 60초 후 재개됩니다.`, '시간 보호');
    } else {
      ss.toast('모든 검수가 완료되었습니다.', '완료');
      props.deleteProperty(PROP_CURRENT_ROW);
      props.deleteProperty(PROP_END_ROW);
      props.deleteProperty(PROP_RUNNING);
      props.deleteProperty(PROP_LAST_TRIGGER_TIME);
      deleteAllTriggers();
    }

  } catch (e) {
    console.error("Main Loop Error:", e.toString());
    const errRow = props.getProperty(PROP_CURRENT_ROW);
    if (errRow) {
      try {
        dataSheet.getRange(parseInt(errRow), 17).setValue("ERR: " + e.toString().slice(0, 50));
        SpreadsheetApp.flush();
      } catch (sheetError) {
        console.error("Sheet write error:", sheetError);
      }
    }
    shouldContinue = true;
    
  } finally {
    try {
      lock.releaseLock();
    } catch (e) {
      // 이미 해제된 경우 무시
    }
    
    if (shouldContinue) {
      deleteAllTriggers();
      ScriptApp.newTrigger('mainLoop')
        .timeBased()
        .after(60000)
        .create();
    }
  }
}

/**
 * 유틸리티 함수들
 */
function deleteAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'mainLoop') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function getSystemPrompt(ss) {
  const sheet = ss.getSheetByName(SHEET_NAME_PROMPT);
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === PROMPT_KEY_TARGET && 
        (data[i][2] === true || String(data[i][2]).toUpperCase() === 'TRUE')) {
      return data[i][1];
    }
  }
  return null;
}

function parseRowRange(text) {
  const match = text.match(/^(\d+)-(\d+)$/) || text.match(/^(\d+)$/);
  if (!match) return null;
  const start = parseInt(match[1]);
  const end = match[2] ? parseInt(match[2]) : start;
  return { startRow: start, endRow: end };
}