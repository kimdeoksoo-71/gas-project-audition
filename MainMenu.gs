/**
 * 파일이 열릴 때 실행되어 메뉴를 생성합니다.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi(); // 문서(Docs)라면 DocumentApp, 설문지라면 FormApp으로 변경
  
  // 1. 메인 메뉴 생성
  const mainMenu = ui.createMenu('🥝 앱메뉴');

  // 2. 단일 항목 추가
  mainMenu.addItem('선택셀 보기', 'lv_openDialog')
  mainMenu.addItem('오류 보기', 'openErrorViewer');
  
  // 3. 구분선 추가
  mainMenu.addSeparator()
  mainMenu.addItem('첫번째 셀로 합치기','mergeSelectedCellsToTopAndClearRest')
  mainMenu.addSeparator();

  // 4. 서브메뉴 A 생성 
  const subMenuA = ui.createMenu('검토')
    .addItem('⏺️ 문항 정규화', 'ds_runNormalizeAndValidate_byRowInput')
    .addSeparator()
    .addItem('▶️ 문제 검증', 'startValidationUI')
    .addItem('▶️ 해설 검증', 'startAutomaticProcess')
    .addItem('⏹️ 해설 검증 강제중단', 'forceStopProcess');

  // 5. 서브메뉴 B 생성 
  const subMenuB = ui.createMenu('Latex 변환')
    .addItem('❇️ Latex 초기화', 'clear_Data1_and_Data_Latex_rows2down')
    .addSeparator()
    .addItem('✳️ 문항찾기 : 키워드', 'runSearchAndAppend')
    .addItem('✅ Latex 변환 : 행범위', 'mpb_runRange')
    .addItem('➕ CRUX 홀짝행 번호추가','addQuestionNumberPrefixToColumnC_byOddEven_InRangeIndex');
    
  // 5. 서브메뉴 C 생성 
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
    .addItem('SplitN 문제&해설','mergeAndSplitLatex')
    

  // 6. 메인 메뉴에 서브메뉴들 통합 및 UI에 반영
  mainMenu.addSubMenu(subMenuB)
          .addSubMenu(subMenuA)
          .addSubMenu(subMenuC)
          .addToUi();
}