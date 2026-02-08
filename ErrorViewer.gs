function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Math Problem Error Viewer') // 웹 앱 타이틀
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 지정된 행 범위의 데이터를 읽어와서 N 또는 Q가 error인 항목만 반환
 */
function getErrorData(startRow, endRow) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Data_DS');
  
  // 데이터 유효성 검사
  if (!sheet) {
    throw new Error("'Data_DS' 시트를 찾을 수 없습니다.");
  }
  
  var lastRow = sheet.getLastRow();
  if (startRow > lastRow) {
    throw new Error("시작 행이 데이터 범위를 벗어났습니다.");
  }
  
  // 실제 읽어올 행 수 계산 (요청 범위와 실제 데이터 범위 중 작은 값 사용)
  var numRows = Math.min(endRow, lastRow) - startRow + 1;
  if (numRows < 1) return [];

  // A열(1)부터 R열(18)까지 한 번에 가져옴 (인덱스는 0부터 시작하므로 R은 17)
  // 범위: startRow, 1열, numRows개, 18개 열
  var data = sheet.getRange(startRow, 1, numRows, 18).getValues();
  
  var filteredData = [];
  
  // 데이터 가공 및 필터링
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    
    // 열 인덱스 매핑 (A=0, C=2, E=4, N=13, P=15, Q=16, R=17)
    var source = row[0];   // A: 문제 출처
    var solution = row[2]; // C: 풀이
    var problem = row[4];  // E: 문제
    var n_status = row[13]; // N: 문제 오류 판정
    var p_note = row[15];   // P: 문제 풀이 노트
    var q_status = row[16]; // Q: 풀이 오류 판정
    var r_error = row[17];  // R: 오류 내용
    
    var currentRowNum = startRow + i;

    // 필터 조건: N 또는 Q가 'error'인 경우 (대소문자 구분 없이 처리하려면 toLowerCase 사용 고려)
    if (String(n_status).trim() === 'error' || String(q_status).trim() === 'error') {
      filteredData.push({
        rowIndex: currentRowNum,
        source: source,
        problem: problem,
        p_note: p_note,
        n_status: n_status,
        solution: solution,
        q_status: q_status,
        r_error: r_error
      });
    }
  }
  
  return filteredData;
}


/**
 * 메뉴를 클릭했을 때 실행되는 함수입니다.
 * Index.html을 모달 다이얼로그(팝업창) 형태로 띄웁니다.
 */
function openErrorViewer() {
  var html = HtmlService.createHtmlOutputFromFile('Index')
    .setWidth(1200) // 창의 가로 크기 (픽셀)
    .setHeight(800); // 창의 세로 크기 (픽셀)
    
  SpreadsheetApp.getUi().showModalDialog(html, 'Math Problem Error Viewer');
}