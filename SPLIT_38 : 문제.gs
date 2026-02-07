/*************************************************
 * Data_Latex!C 범위를 병합 → split_38!D2
 * 그리고 번호 패턴(줄바꿈 + 1~2자리수 + ". " / " ." / " . ") 기준으로 분절하여
 * split_38!B2~B39에 순서대로 채우기
 * - 범위 입력: "문제Alert 상자" 1회 (예: 2,100 / 2-100 / 2 ~ 100 / 2 100)
 *************************************************/

/** 메인 실행 함수 */
function mergeLatexAndSplit_to_split38() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();

  const src = ss.getSheetByName('Data_Latex');
  const dst = ss.getSheetByName('split_38');

  if (!src) throw new Error('Data_Latex 시트를 찾을 수 없습니다.');
  if (!dst) throw new Error('split_38 시트를 찾을 수 없습니다.');

  // ===== 1) 행 범위 입력 받기 (문제Alert 상자 1회) =====
  const range = promptRange_(
    '문제Alert 상자',
    '첫 행과 마지막 행을 입력하세요 (예: 2,100  /  2-100  /  2 ~ 100  /  2 100)'
  );
  if (range === null) return; // 취소
  let { startRow, endRow } = range;

  // 보정: 뒤집혀 입력된 경우 자동 교환
  if (endRow < startRow) [startRow, endRow] = [endRow, startRow];

  if (startRow <= 0 || endRow <= 0) {
    ui.alert('행 번호는 양의 정수여야 합니다.');
    return;
  }

  // ===== 2) Data_Latex!C에서 병합 =====
  const numRows = endRow - startRow + 1;
  const values = src.getRange(startRow, 3, numRows, 1).getValues()  // 3 = C열
    .map(r => (r[0] == null ? '' : String(r[0])));

  const combined = values.join('\n');         // 위에서부터 순서대로 줄바꿈으로 합침
  dst.getRange('D2').setValue(combined);      // split_38!D2에 기록

  // ===== 3) D2 텍스트를 패턴으로 split → B2~B39 =====
  // 분할 기준(세 가지 변형을 모두 허용):
  //  (1) 줄바꿈 + 1~2자리수 + ". "
  //  (2) 줄바꿈 + 1~2자리수 + " ."
  //  (3) 줄바꿈 + 1~2자리수 + " . "
  //
  // 토큰 정의:  \d{1,2}(?:\.\s+|\s+\.(?:\s+)?)
  //   - \.\s+           : ". " (점 뒤에 1칸 이상 공백)
  //   - \s+\.(?:\s+)?   : " ." (점 앞에 1칸 이상 공백, 점 뒤 공백 0개 이상 → " ." / " . ")
  //
  // 시작/다음 토큰에 동일 규칙을 적용하여 구간을 캡처
  const re = /(?:^|\r?\n)(\d{1,2}\s*\.\s*[\s\S]*?)(?=(?:\r?\n)\d{1,2}\s*\.\s*|$)/g;

  const segments = [];
  let m;
  while ((m = re.exec(combined)) !== null) {
    const seg = (m[1] || '').trim();
    if (seg) segments.push(seg);
  }

  // B2~B39 초기화 후 채우기
  const MAX_ROWS = 38; // B2~B39
  dst.getRange(2, 2, MAX_ROWS, 1).clearContent();

  const toWrite = segments.slice(0, MAX_ROWS).map(s => [s]);
  if (toWrite.length > 0) {
    dst.getRange(2, 2, toWrite.length, 1).setValues(toWrite);
  }

  // 알림
  const info =
    `병합 범위: C${startRow}~C${endRow}\n` +
    `추출된 블록 개수: ${segments.length}\n` +
    (segments.length > MAX_ROWS
      ? `주의: 최대 ${MAX_ROWS}개까지만 B2~B${MAX_ROWS + 1}에 기록되었습니다.`
      : `기록 범위: B2~B${toWrite.length + 1}`);
  ui.alert('완료', info, ui.ButtonSet.OK);
}

/** 범위를 한 번에 입력받아 파싱 (취소 시 null) */
function promptRange_(title, message) {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(title, message, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return null;

  // 쉼표, 하이픈, 물결, 콜론, 공백 등 다양한 구분자 허용
  const raw = (res.getResponseText() || '').trim();
  // 숫자 2개를 추출 (예: "2,100", "2 - 100", "2 ~ 100", "2 100")
  const nums = raw.split(/[\s,;:~\-]+/).filter(Boolean).map(v => parseInt(v, 10));

  if (nums.length < 2 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[1])) {
    ui.alert('형식이 올바르지 않습니다. 예: 2,100  /  2-100  /  2 ~ 100  /  2 100');
    return null;
  }

  return { startRow: nums[0], endRow: nums[1] };
}
