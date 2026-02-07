/*************************************************
 * Data_Latex 시트 → split 시트로 문제·해설 병합 및 분할
 *************************************************/

function mergeAndSplitLatex() {
  const ss = SpreadsheetApp.getActive();
  const dataSheet = ss.getSheetByName('Data_Latex');
  const splitSheet = ss.getSheetByName('split');
  if (!dataSheet || !splitSheet) {
    SpreadsheetApp.getUi().alert('⚠️ Data_Latex 또는 split 시트를 찾을 수 없습니다.');
    return;
  }

  const ui = SpreadsheetApp.getUi();

  // --- (1) 문제 범위 입력 ---
  const qRange = ui.prompt('문제 범위 입력', '예: 2-15', ui.ButtonSet.OK_CANCEL);
  if (qRange.getSelectedButton() !== ui.Button.OK) return;
  const [qStart, qEnd] = parseRangeInput(qRange.getResponseText());
  if (!qStart || !qEnd) return ui.alert('⚠️ 범위 입력이 잘못되었습니다.');

  // --- (2) 해설 범위 입력 ---
  const sRange = ui.prompt('해설 범위 입력', '예: 20-35', ui.ButtonSet.OK_CANCEL);
  if (sRange.getSelectedButton() !== ui.Button.OK) return;
  const [sStart, sEnd] = parseRangeInput(sRange.getResponseText());
  if (!sStart || !sEnd) return ui.alert('⚠️ 범위 입력이 잘못되었습니다.');

  // --- (3) 문제·해설 병합 ---
  const qData = dataSheet.getRange(qStart, 3, qEnd - qStart + 1, 1).getValues().flat().join('\n');
  const sData = dataSheet.getRange(sStart, 3, sEnd - sStart + 1, 1).getValues().flat().join('\n');

  splitSheet.getRange('E2').setValue(qData);
  splitSheet.getRange('F2').setValue(sData);

  // --- (4) 기존 분할 내용 초기화 ---
  const lastRow = splitSheet.getLastRow();
  if (lastRow > 1) splitSheet.getRange(2, 3, lastRow, 2).clearContent();

  // --- (5) 번호 포함 상태로 분리 (첫 줄 번호 포함, 번호 토큰 원문 유지) ---
  const qParts = splitWithNumber(qData);
  const sParts = splitWithNumber(sData);

  // --- (6) 결과 쓰기 ---
  if (qParts.length) splitSheet.getRange(2, 3, qParts.length, 1).setValues(qParts.map(v => [v]));
  if (sParts.length) splitSheet.getRange(2, 4, sParts.length, 1).setValues(sParts.map(v => [v]));

  ui.alert('✅ 문제·해설 병합 및 분할 완료!');
}

/*************************************************
 * 도우미 함수들
 *************************************************/

// "2-15", "2,15", "2 15" 등 지원
function parseRangeInput(text) {
  const match = (text || '').trim().match(/(\d+)\D+(\d+)/);
  if (!match) return [null, null];
  const a = parseInt(match[1], 10);
  const b = parseInt(match[2], 10);
  return [Math.min(a, b), Math.max(a, b)];
}

/**
 * 번호를 포함한 상태로 분리 (번호 토큰을 원문 그대로 보존)
 *
 * 허용 구분자:
 *  (시작(^) 또는 \n) + 1~3자리 숫자 + ". "  (1)
 *  (시작(^) 또는 \n) + 1~3자리 숫자 + " "   (2)
 *  (시작(^) 또는 \n) + 1~3자리 숫자 + "."   (3)
 *
 * 결과: 각 조각이 "번호토큰 + 본문" 형태로 반환됨.
 */
function splitWithNumber(text) {
  if (!text) return [];

  // 그룹1: "번호토큰" 자체를 캡처 (예: "1. " / "2 " / "3.")
  const regex = /(?:^|\n)(\d{1,3}(?:\.\s+|\s+|\.))\s*/g;

  const out = [];
  let match;

  let lastToken = null;
  let lastIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    if (lastToken !== null) {
      const body = text.slice(lastIndex, match.index).trim();
      out.push(lastToken + body);
    }
    lastToken = match[1];      // 토큰 원문 그대로
    lastIndex = regex.lastIndex;
  }

  if (lastToken !== null) {
    const body = text.slice(lastIndex).trim();
    out.push(lastToken + body);
  }

  // 번호가 아예 없는 텍스트면 통째로 1개로
  if (!out.length) return [text.trim()].filter(Boolean);

  return out.filter(Boolean);
}
