/*************************************************
 * LaTeX 뷰어 (Dialog) — 메뉴는 mainmenu에서만
 * 기능:
 * - 현재 활성 셀 내용 렌더링
 * - 뷰어에서 A1 입력으로 셀 이동
 * - 뷰어에서 ↑↓←→, 다음/이전 버튼으로 셀 이동
 *************************************************/
const LV = (function () {
  const TITLE = 'LaTeX 뷰어 (큰 창)';

  function openDialog() {
    const html = HtmlService.createHtmlOutputFromFile('ViewerDialog')
      .setTitle(TITLE)
      .setWidth(800)
      .setHeight(850);
    SpreadsheetApp.getUi().showModalDialog(html, TITLE);
  }

  function getActiveCellContent() {
    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getActiveSheet();
    const cell = sheet.getActiveCell();
    return {
      sheetName: sheet.getName(),
      a1: cell.getA1Notation(),
      row: cell.getRow(),
      col: cell.getColumn(),
      text: String(cell.getDisplayValue() ?? '')
    };
  }

  function gotoA1(a1) {
    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getActiveSheet();
    const range = sheet.getRange(a1);
    range.activate();                 // ✅ 활성셀 변경
    sheet.setActiveRange(range);
    return getActiveCellContent();
  }

  function move(dr, dc) {
    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getActiveSheet();
    const cell = sheet.getActiveCell();
    const r = Math.max(1, cell.getRow() + (dr || 0));
    const c = Math.max(1, cell.getColumn() + (dc || 0));
    const range = sheet.getRange(r, c);
    range.activate();                 // ✅ 활성셀 변경
    sheet.setActiveRange(range);
    return getActiveCellContent();
  }

  return { openDialog, getActiveCellContent, gotoA1, move };
})();

// 전역 노출(뷰어에서 google.script.run으로 호출)
function lv_openDialog() { LV.openDialog(); }
function lv_getActiveCellContent() { return LV.getActiveCellContent(); }
function lv_gotoA1(a1) { return LV.gotoA1(a1); }
function lv_move(dr, dc) { return LV.move(dr, dc); }
