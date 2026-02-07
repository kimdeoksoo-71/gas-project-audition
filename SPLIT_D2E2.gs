/*************************************************
 * 공용: 특정 셀의 병합 텍스트를 "번호 패턴"으로 분할해서
 *       원하는 (시작행, 열, 최대개수)에 채우기
 *************************************************/

function splitNumberedText_toRange_(sheetName, sourceA1, outStartRow, outCol, maxRows, clearFirst = true) {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error(`${sheetName} 시트를 찾을 수 없습니다.`);

  const combined = String(sh.getRange(sourceA1).getValue() ?? '').trim();
  if (!combined) {
    ui.alert('중단', `원본 텍스트가 비어있습니다: ${sheetName}!${sourceA1}`, ui.ButtonSet.OK);
    return { segments: [], written: 0 };
  }

  // 기준(2종):
  //  A) "줄바꿈 + 1~2자리 숫자 + '.' + 공백(1개 이상)"
  //  B) "줄바꿈 + 1~2자리 숫자 + ')' + 공백(1개 이상)"

  const re = /(?:^|\r?\n)(\d{1,2}\s*(?:\.\s+|\)\s+)[\s\S]*?)(?=(?:\r?\n)\d{1,2}\s*(?:\.\s+|\)\s+)|$)/g;

  const segments = [];
  let m;
  while ((m = re.exec(combined)) !== null) {
    const seg = (m[1] || '').trim();
    if (seg) segments.push(seg);
  }

  // 출력
  if (clearFirst) sh.getRange(outStartRow, outCol, maxRows, 1).clearContent();

  const toWrite = segments.slice(0, maxRows).map(s => [s]);
  if (toWrite.length > 0) {
    sh.getRange(outStartRow, outCol, toWrite.length, 1).setValues(toWrite);
  }

  // 알림
  const endRow = outStartRow + maxRows - 1;
  const written = toWrite.length;
  ui.alert(
    '완료',
    `원본: ${sheetName}!${sourceA1}\n` +
    `출력: ${sheetName}!${colToA1_(outCol)}${outStartRow}~${colToA1_(outCol)}${endRow}\n` +
    `추출: ${segments.length}개 / 기록: ${written}개` +
    (segments.length > maxRows ? `\n주의: 상위 ${maxRows}개만 기록됨` : ''),
    ui.ButtonSet.OK
  );

  return { segments, written };
}

/** 열 번호(1=A, 2=B, ...) → A1 문자 */
function colToA1_(col) {
  let n = col;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/*************************************************
 * 래퍼(원하는 케이스별로 바로 실행용)
 *************************************************/

// split_12: D2 → B2~B13
function split12_D2_to_B2_B13() {
  splitNumberedText_toRange_('split_12', 'D2', 2, 2, 12, true);
}

// split_12: E2 → B14~B25
function split12_E2_to_B14_B25() {
  splitNumberedText_toRange_('split_12', 'E2', 14, 2, 12, true);
}

// split_38: D2 → B2~B39
function split38_D2_to_B2_B39() {
  splitNumberedText_toRange_('split_38', 'D2', 2, 2, 38, true);
}

// split_38: E2 → B40~B77
function split38_E2_to_B40_B77() {
  splitNumberedText_toRange_('split_38', 'E2', 40, 2, 38, true);
}


