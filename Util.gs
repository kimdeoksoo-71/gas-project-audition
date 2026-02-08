/***********************
 * Utility Functions
 * Problem 검증과 Solution 검증에서 공용으로 사용
 ***********************/

/**
 * 진행 상황 확인 (범용)
 * @param {string} prefix - 'AUTO' (Solution 검증) 또는 '' (Problem 검증)
 */
function checkProgress_(prefix) {
  prefix = prefix || '';
  const separator = prefix ? '_' : '';
  
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperty(prefix + separator + 'CURRENT_ROW');
  const end = props.getProperty(prefix + separator + 'END_ROW');
  const startRow = props.getProperty(prefix + separator + 'START_ROW');
  
  // Solution 검증은 PROVIDER, Problem 검증은 SELECTED_MODEL 사용
  const model = props.getProperty(prefix + separator + 'PROVIDER') || 
                props.getProperty(prefix + separator + 'SELECTED_MODEL');
  
  if (!current || !end) {
    SpreadsheetApp.getUi().alert('진행 중인 작업이 없습니다.');
    return;
  }
  
  const start = parseInt(startRow || '2');
  const curr = parseInt(current);
  const finish = parseInt(end);
  const progress = ((curr - start) / (finish - start + 1) * 100).toFixed(1);
  
  const taskType = prefix === 'AUTO' ? 'Solution 검증' : 'Problem 검증';
  
  SpreadsheetApp.getUi().alert(
    `현재 진행 상황 (${taskType})\n\n` +
    `모델: ${model || 'N/A'}\n` +
    `현재 행: ${current}\n` +
    `종료 행: ${end}\n` +
    `진행률: ${progress}%`
  );
}

/**
 * Problem 검증 진행 상황 확인
 */
function checkProgressProblem() {
  checkProgress_('');
}

/**
 * Solution 검증 진행 상황 확인
 */
function checkProgressSolution() {
  checkProgress_('AUTO');
}

/**
 * 메뉴에 추가할 수 있는 통합 진행 상황 확인
 * 현재 실행 중인 작업을 자동 감지
 */
function checkProgressAuto() {
  const props = PropertiesService.getScriptProperties();
  
  // Solution 검증이 실행 중인지 확인
  const solutionRunning = props.getProperty('AUTO_RUNNING') === 'true';
  const problemRunning = props.getProperty('RUNNING') === 'true';
  
  if (solutionRunning) {
    checkProgressSolution();
  } else if (problemRunning) {
    checkProgressProblem();
  } else {
    SpreadsheetApp.getUi().alert('진행 중인 작업이 없습니다.');
  }
}

/**
 * 모든 작업 강제 중단
 */
function forceStopAll() {
  const props = PropertiesService.getScriptProperties();
  const ui = SpreadsheetApp.getUi();
  
  const response = ui.alert(
    '모든 작업 중단',
    'Problem 검증과 Solution 검증을 모두 중단하시겠습니까?',
    ui.ButtonSet.YES_NO
  );
  
  if (response !== ui.Button.YES) return;
  
  // Solution 검증 중단
  props.setProperty('AUTO_STOP_SIGNAL', 'true');
  props.deleteProperty('AUTO_RUNNING');
  props.deleteProperty('AUTO_LAST_TRIGGER_TIME');
  props.deleteProperty('AUTO_PROVIDER');
  props.deleteProperty('AUTO_CURRENT_ROW');
  props.deleteProperty('AUTO_END_ROW');
  
  // Problem 검증 중단
  props.setProperty('STOP_SIGNAL', 'true');
  props.deleteProperty('RUNNING');
  props.deleteProperty('LAST_TRIGGER_TIME');
  props.deleteProperty('SELECTED_MODEL');
  props.deleteProperty('CURRENT_ROW');
  props.deleteProperty('END_ROW');
  props.deleteProperty('START_ROW');
  
  // 모든 트리거 삭제
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    ScriptApp.deleteTrigger(t);
  }
  
  ui.alert('모든 작업이 중단되었습니다.');
}