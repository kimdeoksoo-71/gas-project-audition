function removePrefixAndPointsInB() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();

  // 1) 범위 입력
  const res = ui.prompt(
    '행 범위 입력',
    '예: 2-50 (B열 앞번호 + [2점][3점][4점] 삭제)',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const m = res.getResponseText().trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) {
    ui.alert('형식 오류. 예: 2-50');
    return;
  }

  let startRow = Number(m[1]);
  let endRow = Number(m[2]);
  if (startRow > endRow) [startRow, endRow] = [endRow, startRow];

  // 2) B열 처리
  const numRows = endRow - startRow + 1;
  const range = sheet.getRange(startRow, 2, numRows, 1);
  const values = range.getValues();

  let changed = 0;
  for (let i = 0; i < values.length; i++) {
    const s = values[i][0];
    if (typeof s !== 'string') continue;

    let t = s;

    // (1) 맨 앞 "1~2자리숫자. 공백" 삭제
    t = t.replace(/^\d{1,2}\.\s+/, '');

    // (2) [2점], [3점], [4점] 삭제
    t = t.replace(/\[(2|3|4)점\]/g, '');

    // (3) 앞뒤 공백 정리
    t = t.replace(/\s{2,}/g, ' ').trim();

    if (t !== s) {
      values[i][0] = t;
      changed++;
    }
  }

  range.setValues(values);
  ui.alert(`완료: ${changed}개 셀 정리됨`);
}
