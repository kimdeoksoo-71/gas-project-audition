/**
 * ============================================================
 * MoveToStack.gs — 처리결과를 Stack 시트에 저장  v4
 * ============================================================
 * Data_DS의 A~AC(29열) 데이터를 Stack 시트 하단에 이어붙이고,
 * Data_DS의 2행 이하를 비웁니다 (서식 유지).
 *
 * [v4 변경사항 — 2026-09-03, 체크리스트 ④·패치 13]
 *  - 세트명·문항그룹 열 이전: Y(25)/Z(26) → AD(30)/AE(31).
 *    Y~AC(25~29) 5열은 행 단위 데이터용 여유 열이 됨.
 *    · Y(25) = fig_info (패치 13: 그림 첨부/누락 내역, Data_DS에서 그대로 이관)
 *    · Z~AC(26~29) = 향후 확장용 (Data_DS 같은 위치의 값이 그대로 이관됨)
 *  - 이관 폭 24열(A~X) → 29열(A~AC)
 *  - 기존 Stack의 Y/Z 값을 AD/AE로 옮기는 1회성 마이그레이션 메뉴
 *    (mts_migrateSetCols) 추가 — ⚠️ v4 첫 사용 전 반드시 1회 실행할 것.
 *    실행 전까지는 난이도 통계(StatCalc v4)가 과거 세트를 보지 못한다.
 *
 * [v3 — 2026-09-01]
 *  - UI 껍데기 + 헤드리스 코어(mts_core_) 분리 (파이프라인 재사용)
 *  - 세트명·문항그룹 자동 기입: A열 key를 마지막 '_' 기준 분해
 *    (예: S팀모의6회(260722)_1공통14 → 세트명/문항그룹). 분해 실패 시
 *    세트명=key 전체, 문항그룹 빈칸 + 결과에 기록.
 *
 * 안전장치는 기존대로 N열(문제검증)만 검사 — STEP3(U열) 빈칸은
 * 선택적 단계이므로 경고 대상에 넣지 않음 (과경고 방지).
 * ============================================================
 */

const MTS = {
  SRC_SHEET: 'Data_DS',
  DST_SHEET: 'Stack',
  NUM_COLS: 29,        // A~AC (v4: fig_info Y + 여유 Z~AC 포함)
  COL_N_IDX: 13,       // N열 = index 13 (문제검증 verdict)
  COL_SET: 30,         // AD  세트명   (v4: Y→AD 이전)
  COL_GROUP: 31,       // AE  문항그룹 (v4: Z→AE 이전)

  /* v4 마이그레이션용: 구(舊) 위치 */
  OLD_COL_SET: 25,     // Y
  OLD_COL_GROUP: 26,   // Z
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

  // ── v4: 구 위치(Y/Z)에 세트명이 남아 있으면 마이그레이션 먼저 안내 ──
  if (mts_needsMigration_(dstSheet)) {
    ui.alert(
      '⚠️ Stack 열 이전 필요',
      'Stack의 Y/Z열에 구(舊) 세트명·문항그룹 데이터가 남아 있습니다.\n' +
      'v4부터 세트명은 AD열, 문항그룹은 AE열을 사용합니다.\n\n' +
      '먼저 메뉴 [📦 Stack 세트열 이전(1회)]을 실행해 주세요.',
      ui.ButtonSet.OK
    );
    return;
  }

  // ── 안전장치: N열(문제검증) 비어있는 행 사전 확인 ──
  const nVals = srcSheet.getRange(2, MTS.COL_N_IDX + 1, srcLastRow - 1, 1).getValues();
  const aVals = srcSheet.getRange(2, 1, srcLastRow - 1, Math.min(MTS.NUM_COLS, srcSheet.getMaxColumns())).getValues();
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
    `세트명(AD)·문항그룹(AE)을 A열 key에서 자동 기입했습니다.` +
    (res.keyParseFail.length
      ? `\n⚠️ key 분해 실패 ${res.keyParseFail.length}건 (Stack 행: ${res.keyParseFail.slice(0, 10).join(', ')}${res.keyParseFail.length > 10 ? ' 외' : ''}) — 세트명=key 전체, 문항그룹 빈칸`
      : '') +
    `\n\nData_DS의 2행 이하 내용이 비워졌습니다. (서식 유지)`,
    ui.ButtonSet.OK
  );
}


/* ═══════════════════════════════════════════════
   헤드리스 코어 — UI 없음, 확인창 없음
   ═══════════════════════════════════════════════ */

/**
 * Data_DS(A~AC) → Stack append + AD/AE 자동 기입 + Data_DS 클리어
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

  // v4: 구 위치(Y/Z)에 세트명이 남아 있으면 통계 이중 기준이 되므로 저장 거부
  if (mts_needsMigration_(dstSheet)) {
    return fail('Stack Y/Z열에 구 세트명 데이터가 남아 있습니다. 먼저 [📦 Stack 세트열 이전(1회)]을 실행하세요.');
  }

  const srcLastRow = srcSheet.getLastRow();
  if (srcLastRow < 2) return fail('Data_DS에 이동할 데이터가 없습니다. (2행 이하 비어있음)');

  // v4: 양쪽 시트 열 폭 보장 (Data_DS A~AC, Stack A~AE)
  if (srcSheet.getMaxColumns() < MTS.NUM_COLS) {
    srcSheet.insertColumnsAfter(srcSheet.getMaxColumns(), MTS.NUM_COLS - srcSheet.getMaxColumns());
  }
  if (dstSheet.getMaxColumns() < MTS.COL_GROUP) {
    dstSheet.insertColumnsAfter(dstSheet.getMaxColumns(), MTS.COL_GROUP - dstSheet.getMaxColumns());
  }

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

  // ── Stack 헤더 보장 (Y=fig_info, AD/AE=세트명/문항그룹) ──
  mts_ensureHeaders_(dstSheet);

  // ── Stack에 이어붙이기 (A~AC) ──
  const dstLastRow = dstSheet.getLastRow();
  const appendRow  = (dstLastRow >= 1) ? dstLastRow + 1 : 2;
  dstSheet.getRange(appendRow, 1, validData.length, MTS.NUM_COLS).setValues(validData);

  // ── AD/AE 자동 기입: A열 key를 마지막 '_' 기준 분해 ──
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
  Logger.log(`MoveToStack v4: ${validData.length}rows → Stack:${appendRow}~${endRow}` +
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

/** v4: Stack 헤더 보장 — Y1 'fig_info', AD1 '세트명', AE1 '문항그룹' (빈 칸일 때만) */
function mts_ensureHeaders_(dstSheet) {
  const put = (col, name) => {
    const cell = dstSheet.getRange(1, col);
    if (!String(cell.getValue() || '').trim()) cell.setValue(name);
  };
  put(MTS.OLD_COL_SET, 'fig_info');   // Y (구 세트명 자리 — 마이그레이션 후 비어 있음)
  put(MTS.COL_SET, '세트명');          // AD
  put(MTS.COL_GROUP, '문항그룹');      // AE
}

/** v4: 구 위치(Y열) 2행 이하에 값이 남아 있는지 (= 마이그레이션 필요) */
function mts_needsMigration_(dstSheet) {
  const last = dstSheet.getLastRow();
  if (last < 2 || dstSheet.getMaxColumns() < MTS.OLD_COL_SET) return false;
  const yHeader = String(dstSheet.getRange(1, MTS.OLD_COL_SET).getValue() || '').trim();
  if (yHeader === 'fig_info') return false;   // 이미 이전 완료 표식
  const yVals = dstSheet.getRange(2, MTS.OLD_COL_SET, last - 1, 1).getValues();
  return yVals.some(r => String(r[0] || '').trim() !== '');
}

/**
 * v4: 1회성 마이그레이션 메뉴 — Stack Y/Z(구 세트명·문항그룹)를 AD/AE로 이동.
 * AD에 이미 값이 있는 행은 건너뜀(재실행 안전). 이동 후 Y/Z 클리어, 헤더 갱신.
 */
function mts_migrateSetCols() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dstSheet = ss.getSheetByName(MTS.DST_SHEET);
  if (!dstSheet) { ui.alert('Stack 시트를 찾을 수 없습니다.'); return; }

  if (dstSheet.getMaxColumns() < MTS.COL_GROUP) {
    dstSheet.insertColumnsAfter(dstSheet.getMaxColumns(), MTS.COL_GROUP - dstSheet.getMaxColumns());
  }

  const last = dstSheet.getLastRow();
  if (last < 2) {
    mts_finishMigrationHeaders_(dstSheet);
    ui.alert('Stack에 데이터가 없어 헤더만 정리했습니다. (Y=fig_info, AD=세트명, AE=문항그룹)');
    return;
  }

  const n = last - 1;
  const oldVals = dstSheet.getRange(2, MTS.OLD_COL_SET, n, 2).getValues();   // Y, Z
  const newVals = dstSheet.getRange(2, MTS.COL_SET, n, 2).getValues();       // AD, AE

  let moved = 0, skipped = 0;
  for (let i = 0; i < n; i++) {
    const oldSet = String(oldVals[i][0] || '').trim();
    if (!oldSet) continue;
    if (String(newVals[i][0] || '').trim() !== '') { skipped++; continue; }   // AD에 이미 값
    newVals[i][0] = oldVals[i][0];
    newVals[i][1] = oldVals[i][1];
    oldVals[i][0] = '';
    oldVals[i][1] = '';
    moved++;
  }

  if (moved === 0 && skipped === 0) {
    mts_finishMigrationHeaders_(dstSheet);
    ui.alert('이동할 구 세트명 데이터가 없습니다. 헤더만 정리했습니다.');
    return;
  }

  const confirm = ui.alert(
    '📦 Stack 세트열 이전 (1회성)',
    `Y/Z열의 세트명·문항그룹 ${moved}행을 AD/AE열로 이동합니다.` +
    (skipped ? `\n(AD에 이미 값이 있는 ${skipped}행은 건너뜀)` : '') +
    `\n이동 후 Y/Z열은 비워지고 Y열은 fig_info 용도가 됩니다.\n\n` +
    `⚠️ Stack의 Y/Z열을 참조하는 별도 수식·차트가 있다면 취소 후 먼저 정리하세요.\n계속할까요?`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) { ui.alert('취소되었습니다.'); return; }

  dstSheet.getRange(2, MTS.COL_SET, n, 2).setValues(newVals);
  dstSheet.getRange(2, MTS.OLD_COL_SET, n, 2).setValues(oldVals);
  mts_finishMigrationHeaders_(dstSheet);
  SpreadsheetApp.flush();

  ui.alert(
    '✅ 이전 완료',
    `${moved}행의 세트명·문항그룹을 AD/AE열로 옮겼습니다.` +
    (skipped ? `\n건너뜀(AD에 기존 값): ${skipped}행` : '') +
    `\n\n이제 [📊 난이도 통계 계산]을 실행하면 새 열 기준으로 재집계됩니다.`,
    ui.ButtonSet.OK
  );
  Logger.log(`mts_migrateSetCols: moved=${moved}, skipped=${skipped}`);
}

/** 마이그레이션 마무리: 헤더 교체 (Y1 '세트명'→'fig_info', Z1 '문항그룹'→'', AD/AE 헤더) */
function mts_finishMigrationHeaders_(dstSheet) {
  const y1 = dstSheet.getRange(1, MTS.OLD_COL_SET);
  const z1 = dstSheet.getRange(1, MTS.OLD_COL_GROUP);
  if (String(y1.getValue() || '').trim() === '세트명' || !String(y1.getValue() || '').trim()) y1.setValue('fig_info');
  if (String(z1.getValue() || '').trim() === '문항그룹') z1.setValue('');
  const ad = dstSheet.getRange(1, MTS.COL_SET);
  const ae = dstSheet.getRange(1, MTS.COL_GROUP);
  if (!String(ad.getValue() || '').trim()) ad.setValue('세트명');
  if (!String(ae.getValue() || '').trim()) ae.setValue('문항그룹');
}