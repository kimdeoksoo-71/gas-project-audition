function onOpen() {
  const ui = SpreadsheetApp.getUi();

  const mainMenu = ui.createMenu('🥝 앱메뉴');

  // 2. 단일 항목
  mainMenu.addItem('선택셀 보기', 'lv_openDialog');
  mainMenu.addItem('오류 보기', 'openErrorViewer');

  // 3. 구분선 + 기타
  mainMenu.addSeparator();
  mainMenu.addItem('첫번째 셀로 합치기','mergeSelectedCellsToTopAndClearRest');
  mainMenu.addSeparator();

  // 4. 서브메뉴 A
  const subMenuA = ui.createMenu('검토')
    .addItem('⏺️ 문항 정규화', 'ds_runNormalizeAndValidate_byRowInput')
    .addSeparator()
    .addItem('▶️ 문제검증 GPT', 'runWithGpt')
    .addItem('▶️ 문제검증 Gemini', 'runWithGemini')
    .addSeparator()
    .addItem('▶️ 해설검증 GPT', 'startProcessGPT')
    .addItem('▶️ 해설검증 Gemini', 'startProcessGemini')
    .addSeparator()
    .addItem('✅ 진행 상황 확인 (자동 감지)', 'checkProgressAuto')
    .addItem('⛔ 강제 중단 (전체)', 'forceStopAll')

  // 5. 서브메뉴 B
  const subMenuB = ui.createMenu('Latex 변환')
    .addItem('❇️ Latex 초기화', 'clear_Data1_and_Data_Latex_rows2down')
    .addSeparator()
    .addItem('✳️ 문항찾기 : 키워드', 'runSearchAndAppend')
    .addItem('✅ Latex 변환 : 행범위', 'mpb_runRange')
    .addItem('➕ CRUX 홀짝행 번호추가','addQuestionNumberPrefixToColumnC_byOddEven_InRangeIndex');

  // 6. 서브메뉴 C
  const subMenuC = ui.createMenu('문항해설 분리/병합')
    .addItem('Split38 문제', 'mergeLatexAndSplit_to_split38')
    .addItem('Split38 해설', 'mergeSolutionAndSplit_to_split38')
    .addItem('Split38 을 Data_DS로','append_split38_to_DataDS')
    .addSeparator()
    .addItem('Split12 문제', 'mergeLatexAndSplit_to_split12')
    .addItem('Split12 해설', 'mergeSolutionAndSplit_to_split12')
    .addItem('Split12 을 Data_DS로','append_split12_to_DataDS')
    .addSeparator()
    .addItem('Split46 문제','mergeLatexAndSplit_to_split46')
    .addItem('Split46 해설','mergeSolutionAndSplit_to_split46')
    .addItem('Split46을 Data_DS로','append_split46_to_DataDS')
    .addSeparator()
    .addItem('SplitN 문제&해설','mergeAndSplitLatex');

  // 7. 메인 메뉴에 서브메뉴들 통합 + UI 반영
  mainMenu
    .addSubMenu(subMenuB)
    .addSubMenu(subMenuA)
    .addSubMenu(subMenuC)
    .addToUi();
} // ✅ onOpen은 여기서 끝!

/***************
 * 아래는 전부 onOpen 밖!
 * (유틸/검증기 함수 등)
 ***************/
function parseRowRange(text) {
  const t = String(text || "").trim();
  const m = t.match(/^(\d+)-(\d+)$/) || t.match(/^(\d+)$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start;
  return { startRow: start, endRow: end };
}
