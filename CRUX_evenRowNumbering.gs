function addQuestionNumberPrefixToColumnC_byOddEven_InRangeIndex() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();

  // 1) 첫행/끝행 입력
  // 테스트 주석 추가
  const r1 = ui.prompt('1/3', '첫행,끝행을 입력하세요 (예: 2,100 또는 2-100)', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;

  const t = (r1.getResponseText() || '').trim();
  const m = t.match(/^\s*(\d+)\s*[,~:-]\s*(\d+)\s*$/) || t.match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
  if (!m) {
    ui.alert('형식 오류', '예: 2,100 또는 2-100 처럼 입력해줘', ui.ButtonSet.OK);
    return;
  }
  let startRow = Number(m[1]);
  let endRow = Number(m[2]);
  if (startRow > endRow) [startRow, endRow] = [endRow, startRow];

  // 2) 홀수/짝수 선택 (구간 내 1번째 기준)
  const r2 = ui.prompt('2/3', '홀수(구간 1번째,3번째...)=1 / 짝수(구간 2번째,4번째...)=2 입력', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;

  const oe = (r2.getResponseText() || '').trim();
  let targetParity = null; // 1=odd, 0=even
  if (oe === '1' || /홀/.test(oe)) targetParity = 1;
  if (oe === '2' || /짝/.test(oe)) targetParity = 0;
  if (targetParity === null) {
    ui.alert('입력 오류', '홀수면 1, 짝수면 2 로 입력해줘', ui.ButtonSet.OK);
    return;
  }

  // 3) 시작 문항번호 입력
  const r3 = ui.prompt('3/3', '시작 문항번호를 입력하세요 (예: 1)', ui.ButtonSet.OK_CANCEL);
  if (r3.getSelectedButton() !== ui.Button.OK) return;

  let qNum = Number((r3.getResponseText() || '').trim());
  if (!Number.isFinite(qNum) || qNum <= 0) {
    ui.alert('입력 오류', '양의 정수로 입력해줘', ui.ButtonSet.OK);
    return;
  }

  // 작업 범위(C열)
  const numRows = endRow - startRow + 1;
  const range = sheet.getRange(startRow, 3, numRows, 1); // C열=3
  const values = range.getValues();

  // 4~7) "구간 내 인덱스" 기준 홀/짝에만 문항번호 추가
  // i=0 => 1번째(홀수), i=1 => 2번째(짝수) ...
  for (let i = 0; i < values.length; i++) {
    const indexInRange = i + 1;
    const isOddInRange = (indexInRange % 2 === 1);

    if ((targetParity === 1 && !isOddInRange) || (targetParity === 0 && isOddInRange)) continue;

    const oldText = values[i][0] == null ? '' : String(values[i][0]);
    const prefix = `${qNum}. `;

    values[i][0] = oldText ? `${prefix}\n${oldText}` : prefix;
    qNum++;
  }

  range.setValues(values);
  ui.alert('완료', `C열에 문항번호를 추가했어. (마지막 문항번호: ${qNum - 1})`, ui.ButtonSet.OK);
}
