/**
 * 디버깅: pmt 시트와 데이터 읽기 확인
 */
function debugEverything() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. pmt 시트 확인
  Logger.log("=== PMT 시트 확인 ===");
  const pmtSheet = ss.getSheetByName(CONFIG.PMT_SHEET_NAME);
  if (!pmtSheet) {
    Logger.log("ERROR: pmt 시트를 찾을 수 없습니다!");
    return;
  }
  
  const pmtData = pmtSheet.getDataRange().getValues();
  Logger.log(`pmt 시트 행 수: ${pmtData.length}`);
  
  // 헤더 확인
  Logger.log(`헤더: ${pmtData[0].join(" | ")}`);
  
  // gpt_problem_verify 찾기
  for (let i = 1; i < pmtData.length; i++) {
    const [key, role, content, enabled] = pmtData[i];
    if (key && String(key).startsWith("gpt_problem_verify")) {
      Logger.log(`\n--- Row ${i + 1} ---`);
      Logger.log(`Key: ${key}`);
      Logger.log(`Role: ${role}`);
      Logger.log(`Enabled: ${enabled} (type: ${typeof enabled})`);
      Logger.log(`Content preview: ${String(content).substring(0, 200)}`);
      Logger.log(`Contains {problem}: ${String(content).includes("{problem}")}`);
      Logger.log(`Contains {format}: ${String(content).includes("{format}")}`);
    }
  }
  
  // 2. getPromptSet 함수 테스트
  Logger.log("\n=== getPromptSet 테스트 ===");
  const promptSet = getPromptSet("gpt_problem_verify");
  Logger.log(`System length: ${promptSet.system.length}`);
  Logger.log(`User length: ${promptSet.user.length}`);
  Logger.log(`Assistant length: ${promptSet.assistant.length}`);
  Logger.log(`\nUser prompt preview:\n${promptSet.user.substring(0, 300)}`);
  
  // 3. Data_DS 시트 확인
  Logger.log("\n=== Data_DS 시트 확인 ===");
  const dataSheet = ss.getSheetByName(CONFIG.DATA_SHEET_NAME);
  if (!dataSheet) {
    Logger.log("ERROR: Data_DS 시트를 찾을 수 없습니다!");
    return;
  }
  
  // 2행 E열과 K열 읽기
  const testRow = 2;
  const stemValue = dataSheet.getRange(testRow, 5).getValue();
  const answerTypeValue = dataSheet.getRange(testRow, 11).getValue();
  
  Logger.log(`\n행 ${testRow} 데이터:`);
  Logger.log(`E열 (문제) length: ${String(stemValue).length}`);
  Logger.log(`E열 preview: ${String(stemValue).substring(0, 100)}`);
  Logger.log(`K열 (답안유형): ${answerTypeValue}`);
  
  // 4. 치환 테스트
  Logger.log("\n=== 치환 테스트 ===");
  const formatGuide = getFormatGuide(answerTypeValue);
  const testContent = promptSet.user
    .replace("{problem}", stemValue)
    .replace("{format}", formatGuide);
  
  Logger.log(`치환 후 길이: ${testContent.length}`);
  Logger.log(`치환 후 preview:\n${testContent.substring(0, 300)}`);
  Logger.log(`여전히 {problem} 포함?: ${testContent.includes("{problem}")}`);
  Logger.log(`여전히 {format} 포함?: ${testContent.includes("{format}")}`);
}