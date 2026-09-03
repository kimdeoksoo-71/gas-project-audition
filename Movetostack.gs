/**
 * ============================================================
 * MoveToStack.gs — 처리결과를 Stack 시트에 저장  v3
 * ============================================================
 * Data_DS의 A~X(24열) 데이터를 Stack 시트 하단에 이어붙이고,
 * Data_DS의 2행 이하를 비웁니다 (서식 유지).
 *
 * [v3 변경사항 — 2026-09-01]
 *  - UI 껍데기(moveResultsToStack) + 헤드리스 코어(mts_core_) 분리
 *    → 원클릭 파이프라인(PipelineVerify.gs)에서 확인창 없이 호출 가능
 *  - Stack Y열(세트명)·Z열(문항그룹) 자동 기입:
 *    A열 key를 마지막 '_' 기준으로 분해 (예: S팀모의6회(260722)_1공통14
 *    → Y='S팀모의6회(260722)', Z='1공통14'). 분해 실패 시 Y=key 전체,
 *    Z 빈칸으로 두고 결과에 기록.
 *    수동 메뉴 실행 시에도 동일 적용 (Y/Z 수동 입력 누락 문제 해소)
 *  - Stack 1행에 Y/Z 헤더가 없으면 자동 기입 ('세트명', '문항그룹')
 *
 * 안전장치는 기존대로 N열(문제검증)만 검사 — STEP3(U열) 빈칸은
 * 선택적 단계이므로 경고 대상에 넣지 않음 (과경고 방지).
 * ============================================================
 */

const MTS = {
  SRC_SHEET: 'Data_DS',
  DST_SHEET: 'Stack',
  NUM_COLS: 24,        // A~X
  COL_N_IDX: 13,       // N열 = index 13 (문제검증 verdict)
  COL_SET: 25,         // Y  세트명
  COL_GROUP: 26,       // Z  문항그룹
};

/* ═══════════════════════════════════════════════
   메뉴 진입점 (UI 껍데기) — 기존 동작 유지
   ═══════════════════════════════════════════════ */
function moveResultsToStack() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const srcSheet = ss.getSheetByName(MTS.SRC_SHEET);
  const dstSheet = ss.getSheetByName(MTS.DST_SHEET);
  if (!srcSheet) { ui.alert('Data_DS 시트를 찾을 수 없습니다.'); return; }
  if (!dstSheet) { ui.alert('Stack 시트를 찾을 수 없습니다.'); return; }

  const srcLastRow = srcSheet.getLastRow();
  if (srcLastRow < 2) {
    ui.alert('Data_DS에 이동할 데이터가 없습니다. (2행 이하 비어있음)');
    return;
  }

  // ── 안전장치: N열(문제검증) 비어있는 행 사전 확인 ──
  const nVals = srcSheet.getRange(2, MTS.COL_N_IDX + 1, srcLastRow - 1, 1).getValues();
  const aVals = srcSheet.getRange(2, 1, srcLastRow - 1, MTS.NUM_COLS).getValues();
  const emptyNRows = [];
  for (let i = 0; i < aVals.length; i++) {
    const isValid = aVals[i].some(cell => String(cell).trim() !== '');
    if (isValid && String(nVals[i][0] || '').trim() === '') emptyNRows.push(i + 2);
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

  // ── 코어 실행 ──
  const res = mts_core_();
  if (!res.ok) { ui.alert(res.message); return; }

  ui.alert(
    '✅ Stack 저장 완료',
    `${res.rows}개 행을 Stack 시트에 저장했습니다.\n` +
    `Stack 기록 위치: ${res.appendRow}행 ~ ${res.endRow}행\n` +
    `Y(세트명)·Z(문항그룹)을 A열 key에서 자동 기입했습니다.` +
    (res.keyParseFail.length
      ? `\n⚠️ key 분해 실패 ${res.keyParseFail.length}건 (Stack 행: ${res.keyParseFail.slice(0, 10).join(', ')}${res.keyParseFail.length > 10 ? ' 외' : ''}) — Y=key 전체, Z 빈칸`
      : '') +
    `\n\nData_DS의 2행 이하 내용이 비워졌습니다. (서식 유지)`,
    ui.ButtonSet.OK
  );
}


/* ═══════════════════════════════════════════════
   헤드리스 코어 — UI 없음, 확인창 없음
   ═══════════════════════════════════════════════ */

/**
 * Data_DS(A~X) → Stack append + Y/Z 자동 기입 + Data_DS 클리어
 * @return {{ok:boolean, message:string, rows:number, appendRow:number,
 *           endRow:number, emptyNRows:number[], keyParseFail:number[]}}
 */
function mts_core_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const srcSheet = ss.getSheetByName(MTS.SRC_SHEET);
  const dstSheet = ss.getSheetByName(MTS.DST_SHEET);

  const fail = (msg) => ({ ok: false, message: msg, rows: 0, appendRow: 0, endRow: 0, emptyNRows: [], keyParseFail: [] });

  if (!srcSheet) return fail('Data_DS 시트를 찾을 수 없습니다.');
  if (!dstSheet) return fail('Stack 시트를 찾을 수 없습니다.');

  const srcLastRow = srcSheet.getLastRow();
  if (srcLastRow < 2) return fail('Data_DS에 이동할 데이터가 없습니다. (2행 이하 비어있음)');

  const numRows = srcLastRow - 1;
  const srcData = srcSheet.getRange(2, 1, numRows, MTS.NUM_COLS).getValues();

  // 완전히 빈 행 제거
  const validData = srcData.filter(row => row.some(cell => String(cell).trim() !== ''));
  if (validData.length === 0) return fail('Data_DS에 유효한 데이터가 없습니다.');

  // N열 빈 행 기록 (경고용 — 저장은 진행, D2 결정)
  const emptyNRows = [];
  for (let i = 0; i < validData.length; i++) {
    if (String(validData[i][MTS.COL_N_IDX] || '').trim() === '') emptyNRows.push(i + 2);
  }

  // ── Stack Y/Z 열·헤더 보장 ──
  if (dstSheet.getMaxColumns() < MTS.COL_GROUP) {
    dstSheet.insertColumnsAfter(dstSheet.getMaxColumns(), MTS.COL_GROUP - dstSheet.getMaxColumns());
  }
  if (String(dstSheet.getRange(1, MTS.COL_SET).getValue() || '').trim() === '') {
    dstSheet.getRange(1, MTS.COL_SET).setValue('세트명');
  }
  if (String(dstSheet.getRange(1, MTS.COL_GROUP).getValue() || '').trim() === '') {
    dstSheet.getRange(1, MTS.COL_GROUP).setValue('문항그룹');
  }

  // ── Stack에 이어붙이기 (A~X) ──
  const dstLastRow = dstSheet.getLastRow();
  const appendRow  = (dstLastRow >= 1) ? dstLastRow + 1 : 2;
  dstSheet.getRange(appendRow, 1, validData.length, MTS.NUM_COLS).setValues(validData);

  // ── Y/Z 자동 기입: A열 key를 마지막 '_' 기준 분해 ──
  const yz = [];
  const keyParseFail = [];   // Stack 실제 행 번호
  for (let i = 0; i < validData.length; i++) {
    const key = String(validData[i][0] || '').trim();
    const idx = key.lastIndexOf('_');
    if (idx > 0 && idx < key.length - 1) {
      yz.push([key.slice(0, idx), key.slice(idx + 1)]);
    } else {
      yz.push([key, '']);
      if (key) keyParseFail.push(appendRow + i);
    }
  }
  dstSheet.getRange(appendRow, MTS.COL_SET, yz.length, 2).setValues(yz);

  // ── Data_DS 2행 이하 비우기 (서식 유지) ──
  const maxRows = srcSheet.getMaxRows();
  if (maxRows >= 2) {
    srcSheet.getRange(2, 1, maxRows - 1, MTS.NUM_COLS).clearContent();
  }
  SpreadsheetApp.flush();

  const endRow = appendRow + validData.length - 1;
  Logger.log(`MoveToStack v3: ${validData.length}rows → Stack:${appendRow}~${endRow}` +
             ` (emptyN=${emptyNRows.length}, keyParseFail=${keyParseFail.length})`);

  return {
    ok: true,
    message: '',
    rows: validData.length,
    appendRow: appendRow,
    endRow: endRow,
    emptyNRows: emptyNRows,
    keyParseFail: keyParseFail,
  };
}