/*************************************************
 * Data1, Data_Latex 시트의 2행 이하 내용 지우기
 * - Data1: 모든 열(A~)의 2행 이하 clear
 * - Data_Latex: A열은 보존, B열~마지막 열의 2행 이하만 clear
 *************************************************/

function clear_Data1_and_Data_Latex_rows2down() {
  const ss = SpreadsheetApp.getActive();

  // Data1: 2행 이하 전체 열 삭제
  clearBelowHeader_(ss, 'Data1');

  // Data_Latex: A열은 제외하고 B~마지막 열만 2행 이하 삭제
  clearBelowHeader_(ss, 'Data_Latex', { excludeFirstCol: true });

  SpreadsheetApp.getUi().alert('완료: Data1과 Data_Latex의 내용을 삭제했습니다. ');
}

/**
 * 지정한 시트에서 2행 이하의 내용을 지움
 * options.excludeFirstCol === true 이면 A열은 보존하고 B~마지막 열만 지움
 */
function clearBelowHeader_(ss, sheetName, options = {}) {
  const sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error(`${sheetName} 시트를 찾을 수 없습니다.`);

  const maxRows = sh.getMaxRows();
  const maxCols = sh.getMaxColumns();
  if (maxRows <= 1 || maxCols <= 0) return; // 2행이 없거나 컬럼이 없으면 종료

  const excludeFirstCol = options.excludeFirstCol === true;

  if (!excludeFirstCol) {
    // A열 포함 전체 열의 2행 이하
    sh.getRange(2, 1, maxRows - 1, maxCols).clearContent();
  } else {
    // A열 보존: B열부터 마지막 열까지 2행 이하만
    if (maxCols >= 2) {
      sh.getRange(2, 2, maxRows - 1, maxCols - 1).clearContent();
    }
    // A열은 건드리지 않음 (A2:AmaxRows 보존)
  }
}
