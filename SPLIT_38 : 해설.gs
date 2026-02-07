/*************************************************
 * 해설 병합+Split
 * - 입력: "해설 Alert 상자" 1회 (예: 2,100 / 2-100 / 2 ~ 100 / 2 100)
 * - 병합: Data_Latex!C[시작~끝] → split_38!E2
 * - 분할: (줄바꿈 + 1~2자리수 + ". ") 패턴 기준
 * - 기록: split_38!B40 ~ B77 (총 38칸)
 *************************************************/

/** 메인 실행 함수 */
function mergeSolutionAndSplit_to_split38() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();

  const src = ss.getSheetByName('Data_Latex');
  const dst = ss.getSheetByName('split_38');

  if (!src) throw new Error('Data_Latex 시트를 찾을 수 없습니다.');
  if (!dst) throw new Error('split_38 시트를 찾을 수 없습니다.');

  // ===== 1) 행 범위 입력 (해설 Alert 상자 1회) =====
  const range = promptRange_(
    '해설 Alert 상자',
    '해설의 시작/끝 행을 입력하세요 (예: 2,100  /  2-100  /  2 ~ 100  /  2 100)'
  );
  if (range === null) return; // 취소
  let { startRow, endRow } = range;

  // 보정: 뒤집힌 입력은 자동 교환
  if (endRow < startRow) [startRow, endRow] = [endRow, startRow];

  if (startRow <= 0 || endRow <= 0) {
    ui.alert('행 번호는 양의 정수여야 합니다.');
    return;
  }

  // ===== 2) Data_Latex!C에서 병합 → split_38!E2 =====
  const numRows = endRow - startRow + 1;
  const values = src.getRange(startRow, 3, numRows, 1).getValues()  // 3 = C열
    .map(r => (r[0] == null ? '' : String(r[0])));

  const combined = values.join('\n');
  dst.getRange('E2').setValue(combined);

  // ===== 3) 같은 기준으로 split → split_38!B40~B77 =====
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

  // 기록 범위: B40 ~ B77 (총 38행)
  const START_ROW = 40;
  const MAX_ROWS  = 38;
  dst.getRange(START_ROW, 2, MAX_ROWS, 1).clearContent();

  const toWrite = segments.slice(0, MAX_ROWS).map(s => [s]);
  if (toWrite.length > 0) {
    dst.getRange(START_ROW, 2, toWrite.length, 1).setValues(toWrite);
  }

  // 완료 안내
  const info =
    `해설 병합 범위: C${startRow}~C${endRow}\n` +
    `추출된 블록 개수: ${segments.length}\n` +
    (segments.length > MAX_ROWS
      ? `주의: 최대 ${MAX_ROWS}개까지만 B${START_ROW}~B${START_ROW + MAX_ROWS - 1}에 기록되었습니다.`
      : `기록 범위: B${START_ROW}~B${START_ROW + toWrite.length - 1}`);
  ui.alert('완료', info, ui.ButtonSet.OK);
}

/** 범위를 한 번에 입력받아 파싱 (취소 시 null) */
function promptRange_(title, message) {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(title, message, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return null;

  // 쉼표, 하이픈, 물결, 콜론, 공백 등 다양한 구분자 허용
  const raw = (res.getResponseText() || '').trim();
  const nums = raw.split(/[\s,;:~\-]+/).filter(Boolean).map(v => parseInt(v, 10));

  if (nums.length < 2 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[1])) {
    ui.alert('형식이 올바르지 않습니다. 예: 2,100  /  2-100  /  2 ~ 100  /  2 100');
    return null;
  }

  return { startRow: nums[0], endRow: nums[1] };
}
