/**
 * ============================================================
 * MoveToStack.gs — 처리결과를 Stack 시트에 저장
 * ============================================================
 * Data_DS의 A~R 데이터를 Stack 시트 하단에 이어붙이고,
 * Data_DS의 2행 이하를 비웁니다 (서식 유지).
 * ============================================================
 */

function moveResultsToStack() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const srcSheet = ss.getSheetByName('Data_DS');
  const dstSheet = ss.getSheetByName('Stack');

  if (!srcSheet) { ui.alert('Data_DS 시트를 찾을 수 없습니다.'); return; }
  if (!dstSheet) { ui.alert('Stack 시트를 찾을 수 없습니다.'); return; }

  // ── 1. Data_DS에 데이터가 있는지 확인 ──
  const srcLastRow = srcSheet.getLastRow();
  if (srcLastRow < 2) {
    ui.alert('Data_DS에 이동할 데이터가 없습니다. (2행 이하 비어있음)');
    return;
  }

  const numRows = srcLastRow - 1;   // 2행부터 마지막행까지
  const numCols = 19;                // A~S = 19열 (S열: thinking_tokens 추가)
  const srcData = srcSheet.getRange(2, 1, numRows, numCols).getValues();

  // 완전히 빈 행 제거
  const validData = srcData.filter(row =>
    row.some(cell => String(cell).trim() !== '')
  );

  if (validData.length === 0) {
    ui.alert('Data_DS에 유효한 데이터가 없습니다.');
    return;
  }

  // ── 2. 안전장치: N열(문제검증) 비어있는 행 체크 ──
  const emptyNRows = [];
  for (let i = 0; i < validData.length; i++) {
    const nValue = String(validData[i][13] || '').trim();   // N열 = index 13
    if (nValue === '') {
      emptyNRows.push(i + 2);  // 실제 행번호 (2행 기준)
    }
  }

  if (emptyNRows.length > 0) {
    const preview = emptyNRows.length > 10
      ? emptyNRows.slice(0, 10).join(', ') + ` 외 ${emptyNRows.length - 10}개`
      : emptyNRows.join(', ');

    const confirm = ui.alert(
      '⚠️ 미검증 행 발견',
      `N열(문제검증 결과)이 비어있는 행이 ${emptyNRows.length}개 있습니다.\n` +
      `(행: ${preview})\n\n` +
      `검증이 완료되지 않았을 수 있습니다.\n그래도 Stack에 저장하시겠습니까?`,
      ui.ButtonSet.YES_NO
    );
    if (confirm !== ui.Button.YES) {
      ui.alert('작업이 취소되었습니다.');
      return;
    }
  }

  // ── 3. Stack 시트에 이어붙이기 ──
  const dstLastRow = dstSheet.getLastRow();
  const appendRow  = (dstLastRow >= 1) ? dstLastRow + 1 : 2;  // 헤더 다음부터

  dstSheet.getRange(appendRow, 1, validData.length, numCols).setValues(validData);

  // ── 4. Data_DS 2행 이하 비우기 (서식 유지) ──
  const maxRows = srcSheet.getMaxRows();
  if (maxRows >= 2) {
    srcSheet.getRange(2, 1, maxRows - 1, numCols).clearContent();
  }

  // ── 5. 완료 안내 ──
  ui.alert(
    '✅ Stack 저장 완료',
    `${validData.length}개 행을 Stack 시트에 저장했습니다.\n` +
    `Stack 기록 위치: ${appendRow}행 ~ ${appendRow + validData.length - 1}행\n\n` +
    `Data_DS의 2행 이하 내용이 비워졌습니다. (서식 유지)`,
    ui.ButtonSet.OK
  );

  Logger.log(`MoveToStack: ${validData.length}rows → Stack:${appendRow}~${appendRow + validData.length - 1}`);
}