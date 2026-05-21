/**
 * ============================================================
 * MainMenu.gs — 메인 메뉴 (개편)
 * ============================================================
 * 변경사항:
 *   - GPT 관련 메뉴 제거
 *   - "문제검증"과 "해설검증"을 "문항 검증(문제+해설)"로 통합
 *   - "처리결과 Stack에 저장" 추가
 *   - parseRowRange를 여기서만 정의 (중복 제거)
 *   - v2: "🔄 Error 행 재검증" 메뉴 추가
 * ============================================================
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const mainMenu = ui.createMenu('🥝 앱메뉴');

  // ── 단일 항목 ──
  mainMenu.addItem('오류 보기', 'openErrorViewer');
  mainMenu.addItem('선택셀 팝업창 보기', 'lv_openDialog');
  mainMenu.addItem('선택셀 사이드바 보기', 'showCellPreviewSidebar');

  mainMenu.addSeparator();
  mainMenu.addItem('첫번째 셀로 합치기', 'mergeSelectedCellsToTopAndClearRest');
  mainMenu.addSeparator();

  // ── 서브메뉴: 검토 (개편 v2) ──
  const subMenuA = ui.createMenu('검토')
    .addItem('⏺️ 문항 정규화', 'ds_runNormalizeAndValidate_byRowInput')
    .addSeparator()
    .addItem('▶️ 문항 검증 (문제+해설)', 'startItemVerification')
    .addItem('🔄 Error 행 재검증', 'retryErrorRows')
    .addItem('✅ 진행 상태 확인', 'checkVerificationStatus')
    .addItem('🧪 단일 행 테스트', 'testSingleRowVerification')
    .addItem('⛔ 작업 중단', 'stopItemVerification')
    .addSeparator()
    .addItem('📦 처리결과 Stack에 저장', 'moveResultsToStack')
    .addSeparator()
    .addItem('프롬프트를 github에 푸시', 'pushPromptCsvToGithub')
    .addSeparator()
    .addItem('🔍 503 에러 진단', 'run503Diagnostic');

  // ── 서브메뉴: Latex 변환 (기존 유지) ──
  const subMenuB = ui.createMenu('Latex 변환')
    .addItem('❇️ Latex 초기화', 'clear_Data1_and_Data_Latex_rows2down')
    .addSeparator()
    .addItem('✳️ 문항찾기 : 키워드', 'runSearchAndAppend')
    .addItem('✅ Latex 변환 : 행범위', 'mpb_runRange')
    .addItem('➕ CRUX 홀짝행 번호추가', 'addQuestionNumberPrefixToColumnC_byOddEven_InRangeIndex');

  // ── 서브메뉴: 문항해설 분리/병합 (기존 유지) ──
  const subMenuC = ui.createMenu('문항해설 분리/병합')
    .addItem('Split38 문제', 'mergeLatexAndSplit_to_split38')
    .addItem('Split38 해설', 'mergeSolutionAndSplit_to_split38')
    .addItem('Split38 을 Data_DS로', 'append_split38_to_DataDS')
    .addSeparator()
    .addItem('Split12 문제', 'mergeLatexAndSplit_to_split12')
    .addItem('Split12 해설', 'mergeSolutionAndSplit_to_split12')
    .addItem('Split12 을 Data_DS로', 'append_split12_to_DataDS')
    .addSeparator()
    .addItem('Split46 문제', 'mergeLatexAndSplit_to_split46')
    .addItem('Split46 해설', 'mergeSolutionAndSplit_to_split46')
    .addItem('Split46을 Data_DS로', 'append_split46_to_DataDS')
    .addSeparator()
    .addItem('SplitN 문제&해설', 'mergeAndSplitLatex');

  // ── 메인 메뉴 조립 ──
  mainMenu
    .addSubMenu(subMenuB)
    .addSubMenu(subMenuA)
    .addSubMenu(subMenuC)
    .addToUi();
}


/* ═══════════════════════════════════════════════
   공용 유틸리티 (parseRowRange — 여기서만 정의)
   ═══════════════════════════════════════════════ */

/**
 * "2-100", "15" 형식의 행 범위 문자열을 파싱
 * @param {string} text
 * @return {{ startRow:number, endRow:number }|null}
 */
function parseRowRange(text) {
  const t = String(text || '').trim();
  const m = t.match(/^(\d+)-(\d+)$/) || t.match(/^(\d+)$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end   = m[2] ? parseInt(m[2], 10) : start;
  return { startRow: start, endRow: end };
}