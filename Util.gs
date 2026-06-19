/**
 * ============================================================
 * Util.gs — 공용 유틸리티 (개편)
 * ============================================================
 * 변경사항:
 *   - 통합 VCONFIG.PROP 키에 맞춰 진행 확인 로직 수정
 *   - 구 Problem/Solution 개별 진행 확인 함수 제거
 *   - parseRowRange 제거 (MainMenu.gs에서 정의)
 *   - forceStopAll → 통합 키 대응
 *   - v3: HEARTBEAT 키 정리 추가
 *   - v5: activeWatchdog_ 트리거 정리 추가
 * ============================================================
 */

/**
 * 모든 작업 강제 중단
 */
function forceStopAll() {
  const props = PropertiesService.getScriptProperties();
  const ui = SpreadsheetApp.getUi();

  const confirm = ui.alert(
    '모든 작업 중단',
    '문항 검증 작업을 강제 중단하시겠습니까?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  // 통합 검증 중단
  props.setProperty('V_STOP', 'true');
  props.setProperty('V_RUNNING', 'false');
  props.deleteProperty('V_LAST_HEARTBEAT');  // v3: heartbeat 정리

  // 레거시 키도 정리 (혹시 남아있을 경우)
  props.setProperty('STOP_REQUESTED', 'true');
  props.setProperty('AUTO_STOP_SIGNAL', 'true');

  // 모든 트리거 제거 (v5: activeWatchdog_ 추가)
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    const fn = t.getHandlerFunction();
    if (['processVerificationQueue', 'processValidationQueue', 'mainLoop', 'watchdog_', 'activeWatchdog_'].includes(fn)) {
      ScriptApp.deleteTrigger(t);
    }
  }

  ui.alert('모든 작업이 중단되었습니다. 관련 트리거도 제거되었습니다.');
}