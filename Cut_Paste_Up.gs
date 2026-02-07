function mergeSelectedCellsToTopAndClearRest() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getActiveSheet();
  const range = sheet.getActiveRange();

  if (!range) {
    SpreadsheetApp.getUi().alert("선택된 범위가 없어.");
    return;
  }

  const numCells = range.getNumRows() * range.getNumColumns();
  if (numCells < 2) {
    SpreadsheetApp.getUi().alert("2개 이상의 셀을 선택한 뒤 실행해줘.");
    return;
  }

  // 표시값 기준(원하면 getValues()로 바꿔도 됨)
  const displayValues = range.getDisplayValues(); // 2D
  const flat = [];
  for (let i = 0; i < displayValues.length; i++) {
    for (let j = 0; j < displayValues[0].length; j++) {
      flat.push(displayValues[i][j]);
    }
  }

  // 합치기: 빈 문자열은 제외하고 줄바꿈으로 연결
  const mergedText = flat
    .map(v => (v ?? "").toString())
    .map(v => v.trimEnd())          // 끝 공백만 정리(원치 않으면 지워)
    .filter(v => v !== "")
    .join("\n");

  // 선택 범위의 "가장 위-왼쪽" 셀
  const topCell = range.getCell(1, 1);

  // 1) 맨 위 셀에 합친 텍스트 넣기
  topCell.setValue(mergedText);

  // 2) 나머지 셀 내용 지우기 (topCell 제외)
  const numRows = range.getNumRows();
  const numCols = range.getNumColumns();
  for (let rr = 1; rr <= numRows; rr++) {
    for (let cc = 1; cc <= numCols; cc++) {
      if (rr === 1 && cc === 1) continue;
      range.getCell(rr, cc).clearContent();
    }
  }

  sheet.setActiveRange(topCell);
}
