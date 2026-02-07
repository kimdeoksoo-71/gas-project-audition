/*************************************************
 * split_12!F2:H13 → Data_DS!A:C 로 이어붙이기
 * - F→A, G→B, H→C
 * - Data_DS의 2행 이하가 비어있으면 2행부터, 아니면 마지막 데이터 다음 행부터
 * - 완전히 빈 행(F,G,H 모두 공백)은 건너뜀
 * - 완료 후 split_12의 B, D, E열의 2행 이하 모든 셀 내용 지우기
 *************************************************/

function append_split12_to_DataDS() {
  const ss  = SpreadsheetApp.getActive();
  const src = ss.getSheetByName('split_12');
  const dst = ss.getSheetByName('Data_DS');
  if (!src) throw new Error('split_12 시트를 찾을 수 없습니다.');
  if (!dst) throw new Error('Data_DS 시트를 찾을 수 없습니다.');

  // 1) 소스 범위: split_12!F2:H13 (12행, 3열)
  const sourceRange = src.getRange(2, 6, 12, 3); // row 2, col F(6), 12 rows, 3 cols (F,G,H)
  const rawValues = sourceRange.getValues();

  // 2) 완전히 빈 행 제거 (F,G,H 모두 공백)
  const values = rawValues.filter(r => r.some(v => String(v).trim() !== ''));
  if (values.length === 0) {
    SpreadsheetApp.getUi().alert('붙여넣을 데이터가 없습니다. (F2~H13이 모두 비어있음)');
    return;
  }

  // 3) Data_DS의 A:C 기준 마지막 데이터 행 계산
  const lastDataRow = getLastDataRowInColsABC_(dst);
  const startRow = (lastDataRow >= 2) ? lastDataRow + 1 : 2;

  // 4) 대상 범위에 쓰기
  dst.getRange(startRow, 1, values.length, 3).setValues(values);

  // 5) split_12의 B/D/E 열(2행 이하) 내용 지우기
  clearSplit12ColsBDE_(src);

  // 6) 안내
  SpreadsheetApp.getUi().alert(
    `총 ${values.length}개 행을 Data_DS!A:C에 추가했습니다.\n` +
    `시작행: ${startRow}  / 종료행: ${startRow + values.length - 1}\n` +
    `추가 후 split_12 시트의 B/D/E열 2행 이하 내용을 모두 삭제했습니다.`
  );
}

/** split_12 시트의 B, D, E 열의 2행 이하 모든 셀 내용 지우기 */
function clearSplit12ColsBDE_(sheet) {
  const maxRows = sheet.getMaxRows();
  if (maxRows < 2) return; // 2행 자체가 없으면 스킵

  sheet.getRange(2, 2, maxRows - 1, 1).clearContent(); // B2:B
  sheet.getRange(2, 4, maxRows - 1, 1).clearContent(); // D2:D
  sheet.getRange(2, 5, maxRows - 1, 1).clearContent(); // E2:E
}

/** Data_DS의 A:C에서 마지막 데이터가 있는 행 번호를 반환 (없으면 1) */
function getLastDataRowInColsABC_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;

  const rng = sheet.getRange(2, 1, lastRow - 1, 3).getValues(); // A2:C(lastRow)
  for (let i = rng.length - 1; i >= 0; i--) {
    const row = rng[i];
    if (row.some(v => String(v).trim() !== '')) {
      return i + 2; // 실제 행 번호 (배열 인덱스 보정)
    }
  }
  return 1;
}
