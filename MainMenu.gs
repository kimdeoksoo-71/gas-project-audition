function onOpen() {
  const ui = SpreadsheetApp.getUi();

  const mainMenu = ui.createMenu('🥝 앱메뉴');

  // 2. 단일 항목
  mainMenu.addItem('선택셀 보기', 'lv_openDialog');
  mainMenu.addItem('오류 보기', 'openErrorViewer');

  // 3. 구분선 + 기타
  mainMenu.addSeparator();
  mainMenu.addItem('첫번째 셀로 합치기','mergeSelectedCellsToTopAndClearRest');
  mainMenu.addSeparator();

  // 4. 서브메뉴 A
  const subMenuA = ui.createMenu('검토')
    .addItem('⏺️ 문항 정규화', 'ds_runNormalizeAndValidate_byRowInput')
    .addSeparator()
    .addItem('▶️ 문제검증 GPT', 'runWithGpt')
    .addItem('▶️ 문제검증 Gemini', 'runWithGemini')
    .addItem('✅ 진행 상태 확인', 'checkExecutionStatus')
    .addItem('🧪 단일 행 테스트', 'testSingleRowUI')
    .addItem('⛔ 작업 중단', 'stopValidation')
    .addSeparator()
    .addItem('▶️ 해설검증 GPT', 'startProcessGPT')
    .addItem('▶️ 해설검증 Gemini', 'startProcessGemini')
    .addItem('✅ 진행 상황 확인 (자동 감지)', 'checkProgressAuto')
    .addItem('⛔ 강제 중단 (전체)', 'forceStopAll')

  // 5. 서브메뉴 B
  const subMenuB = ui.createMenu('Latex 변환')
    .addItem('❇️ Latex 초기화', 'clear_Data1_and_Data_Latex_rows2down')
    .addSeparator()
    .addItem('✳️ 문항찾기 : 키워드', 'runSearchAndAppend')
    .addItem('✅ Latex 변환 : 행범위', 'mpb_runRange')
    .addItem('➕ CRUX 홀짝행 번호추가','addQuestionNumberPrefixToColumnC_byOddEven_InRangeIndex');

  // 6. 서브메뉴 C
  const subMenuC = ui.createMenu('문항해설 분리/병합')
    .addItem('Split38 문제', 'mergeLatexAndSplit_to_split38')
    .addItem('Split38 해설', 'mergeSolutionAndSplit_to_split38')
    .addItem('Split38 을 Data_DS로','append_split38_to_DataDS')
    .addSeparator()
    .addItem('Split12 문제', 'mergeLatexAndSplit_to_split12')
    .addItem('Split12 해설', 'mergeSolutionAndSplit_to_split12')
    .addItem('Split12 을 Data_DS로','append_split12_to_DataDS')
    .addSeparator()
    .addItem('Split46 문제','mergeLatexAndSplit_to_split46')
    .addItem('Split46 해설','mergeSolutionAndSplit_to_split46')
    .addItem('Split46을 Data_DS로','append_split46_to_DataDS')
    .addSeparator()
    .addItem('SplitN 문제&해설','mergeAndSplitLatex');

  // 7. 메인 메뉴에 서브메뉴들 통합 + UI 반영
  mainMenu
    .addSubMenu(subMenuB)
    .addSubMenu(subMenuA)
    .addSubMenu(subMenuC)
    .addToUi();
} // ✅ onOpen은 여기서 끝!

/***************
 * 아래는 전부 onOpen 밖!
 * (유틸/검증기 함수 등)
 ***************/
function parseRowRange(text) {
  const t = String(text || "").trim();
  const m = t.match(/^(\d+)-(\d+)$/) || t.match(/^(\d+)$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start;
  return { startRow: start, endRow: end };
}


/**
 * 작업 중단 함수
 */
function stopValidation() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('STOP_REQUESTED', 'true');
  
  SpreadsheetApp.getUi().alert(
    '작업 중단 요청됨',
    '현재 처리 중인 행이 완료되면 중단됩니다.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/**
 * 단일 행 테스트 UI
 */
function testSingleRowUI() {
  const ui = SpreadsheetApp.getUi();
  
  // 모델 선택
  const modelChoice = ui.alert(
    '테스트할 모델 선택',
    'GPT는 "예", Gemini는 "아니오"를 클릭하세요.',
    ui.ButtonSet.YES_NO
  );
  
  const model = (modelChoice === ui.Button.YES) ? 'GPT' : 'GEMINI';
  
  // 행 번호 입력
  const rowInput = ui.prompt(
    `${model} 단일 행 테스트`,
    '테스트할 행 번호를 입력하세요:',
    ui.ButtonSet.OK_CANCEL
  );
  
  if (rowInput.getSelectedButton() === ui.Button.CANCEL) return;
  
  const rowNumber = parseInt(rowInput.getResponseText().trim(), 10);
  
  if (isNaN(rowNumber) || rowNumber < 2) {
    ui.alert('유효하지 않은 행 번호입니다.');
    return;
  }
  
  ui.alert(`${model} 모델로 행 ${rowNumber}을 테스트합니다. 로그를 확인하세요.`);
  
  testSingleRow(rowNumber, model);
  
  ui.alert('테스트 완료! 보기 > 로그에서 결과를 확인하세요.');
}

/**
 * 개선된 단일 행 테스트 함수
 */
function testSingleRow(rowNumber, model) {
  model = model || 'GPT'; // 기본값
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(CONFIG.DATA_SHEET_NAME);
  
  const stem = dataSheet.getRange(rowNumber, 5).getValue();
  const answerType = dataSheet.getRange(rowNumber, 11).getValue();
  
  Logger.log(`=== Testing Row ${rowNumber} with ${model} ===`);
  Logger.log(`Problem: ${String(stem).substring(0, 200)}`);
  
  // 특수 문자 체크
  if (String(stem).includes('\\')) Logger.log('⚠️ Contains backslash');
  if (String(stem).includes('"')) Logger.log('⚠️ Contains double quote');
  if (String(stem).includes('\n')) Logger.log('⚠️ Contains newline');
  
  const prefix = model.toLowerCase() + "_problem_verify";
  const promptSet = getPromptSet(prefix);
  const formatGuide = getFormatGuide(answerType);
  const finalUserContent = promptSet.user
    .replace("{problem}", stem)
    .replace("{format}", formatGuide);
  
  try {
    const startTime = Date.now();
    let result;
    
    if (model === 'GPT') {
      result = callGptAPIWithRetry(promptSet.system, finalUserContent, promptSet.assistant);
    } else {
      result = callGeminiAPIWithRetry(promptSet.system, finalUserContent, promptSet.assistant);
    }
    
    const duration = Date.now() - startTime;
    
    Logger.log("✅ Success!");
    Logger.log(`Duration: ${duration}ms`);
    Logger.log(JSON.stringify(result, null, 2));
    
    // 결과를 시트에도 기록
    dataSheet.getRange(rowNumber, 14).setValue(result.verdict);
    dataSheet.getRange(rowNumber, 15).setValue(result.derived_answer);
    dataSheet.getRange(rowNumber, 16).setValue(`[TEST] ${result.solution_note}`);
    
  } catch (e) {
    Logger.log(`❌ Error: ${e.message}`);
    Logger.log(e.stack);
  }
}
