/**
 * ============================================================
 * Diagnostic503.gs — 503 에러 패턴 진단 도구
 * ============================================================
 * Data_DS 시트의 검증 결과를 분석하여
 * 503 에러의 원인을 파악하는 진단 보고서를 생성합니다.
 *
 * 사용법: 스프레드시트 메뉴 → 검증 도구 → 🔍 503 에러 진단
 * ============================================================
 */

function run503Diagnostic() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Data_DS');
  if (!sheet) {
    SpreadsheetApp.getUi().alert('Data_DS 시트를 찾을 수 없습니다.');
    return;
  }

  const ui = SpreadsheetApp.getUi();
  const input = ui.prompt(
    '503 에러 진단',
    '분석할 행 범위를 입력하세요 (예: 2-47)',
    ui.ButtonSet.OK_CANCEL
  );
  if (input.getSelectedButton() !== ui.Button.OK) return;

  const range = parseRowRange(input.getResponseText());
  if (!range || range.startRow < 2) {
    ui.alert('유효하지 않은 범위입니다.');
    return;
  }

  const numRows = range.endRow - range.startRow + 1;
  // A~S열 (19열) 읽기
  const data = sheet.getRange(range.startRow, 1, numRows, 19).getValues();

  // ─────────────────────────────────────
  // 분석 수행
  // ─────────────────────────────────────
  const report = {
    totalRows: numRows,
    rangeStart: range.startRow,
    rangeEnd: range.endRow,

    // 체크 2: 총 API 호출 수 추정
    rowsWithStem: 0,       // E열 비어있지 않은 행
    rowsWithSolution: 0,   // C열 비어있지 않은 행
    estimatedApiCalls: 0,  // stem이 있으면 +1, solution이 있으면 +1

    // 체크 3: 에러 행 분포
    errorRows: [],         // { row, nVal, qVal, pNote, sError }
    errorInFirst25pct: 0,
    errorIn25to50pct: 0,
    errorIn50to75pct: 0,
    errorInLast25pct: 0,

    // 체크 4: STEP 1 vs STEP 2 실패 분석
    step1ErrorOnly: 0,     // N열만 error/timeout
    step2ErrorOnly: 0,     // Q열만 error/timeout
    bothStepError: 0,      // 둘 다 error/timeout
    step1Errors: [],       // { row, verdict, note }
    step2Errors: [],       // { row, verdict, error }

    // 체크 5: 시간 예산 관련 (P열 메시지 분석)
    timeBudgetExhausted: 0,  // "시간 예산 초과" 포함하는 에러
    generic503: 0,           // 503 포함하지만 시간예산 아닌 에러
    otherErrors: 0,

    // 체크 5-b: thinking 토큰 통계 (S열)
    thinkingTokens: [],    // 성공 행의 thinking 토큰 수
    thinkingTokenMax: 0,
    thinkingTokenAvg: 0,

    // 기타 통계
    successRows: 0,
    skipRows: 0,
    timeoutRows: 0,
  };

  // ── 열 인덱스 (0-based) ──
  const COL = {
    SOLUTION: 2,    // C (idx 2)
    STEM: 4,        // E (idx 4)
    P_VERDICT: 13,  // N (idx 13)
    P_DERIVED: 14,  // O (idx 14)
    P_NOTE: 15,     // P (idx 15)
    S_VERDICT: 16,  // Q (idx 16)
    S_ERROR: 17,    // R (idx 17)
    THINKING: 18,   // S (idx 18)
  };

  for (let i = 0; i < numRows; i++) {
    const row = data[i];
    const rowNum = range.startRow + i;
    const stem     = String(row[COL.STEM] || '').trim();
    const solution = String(row[COL.SOLUTION] || '').trim();
    const nVal     = String(row[COL.P_VERDICT] || '').toLowerCase().trim();
    const qVal     = String(row[COL.S_VERDICT] || '').toLowerCase().trim();
    const pNote    = String(row[COL.P_NOTE] || '').trim();
    const sError   = String(row[COL.S_ERROR] || '').trim();
    const thinking = Number(row[COL.THINKING] || 0);

    // API 호출 수 추정
    if (stem !== '') report.rowsWithStem++;
    if (solution !== '') report.rowsWithSolution++;
    if (stem !== '') report.estimatedApiCalls++;
    if (solution !== '') report.estimatedApiCalls++;

    // 에러/성공 분류
    const nIsErr = (nVal === 'error' || nVal === 'timeout');
    const qIsErr = (qVal === 'error' || qVal === 'timeout');

    if (nIsErr || qIsErr) {
      // 에러 행 정보 수집
      report.errorRows.push({
        row: rowNum,
        nVal: nVal,
        qVal: qVal,
        pNote: pNote.substring(0, 120),
        sError: sError.substring(0, 120),
      });

      // 분포 분석 (4분위)
      const position = i / numRows;
      if (position < 0.25) report.errorInFirst25pct++;
      else if (position < 0.5) report.errorIn25to50pct++;
      else if (position < 0.75) report.errorIn50to75pct++;
      else report.errorInLast25pct++;

      // STEP 1 vs STEP 2
      if (nIsErr && qIsErr) {
        report.bothStepError++;
        report.step1Errors.push({ row: rowNum, verdict: nVal, note: pNote.substring(0, 80) });
        report.step2Errors.push({ row: rowNum, verdict: qVal, error: sError.substring(0, 80) });
      } else if (nIsErr) {
        report.step1ErrorOnly++;
        report.step1Errors.push({ row: rowNum, verdict: nVal, note: pNote.substring(0, 80) });
      } else {
        report.step2ErrorOnly++;
        report.step2Errors.push({ row: rowNum, verdict: qVal, error: sError.substring(0, 80) });
      }

      // 에러 유형 분류
      const allNotes = pNote + ' ' + sError;
      if (allNotes.includes('시간 예산 초과') || allNotes.includes('Time budget')) {
        report.timeBudgetExhausted++;
      } else if (allNotes.includes('503')) {
        report.generic503++;
      } else {
        report.otherErrors++;
      }

    } else if (nVal === 'skip' || qVal === 'skip') {
      report.skipRows++;
    } else if (nVal === 'timeout' || qVal === 'timeout') {
      report.timeoutRows++;
    } else {
      report.successRows++;
    }

    // thinking 토큰 통계 (성공 행만)
    if (!nIsErr && !qIsErr && thinking > 0) {
      report.thinkingTokens.push({ row: rowNum, tokens: thinking });
    }
  }

  // thinking 토큰 통계 계산
  if (report.thinkingTokens.length > 0) {
    const vals = report.thinkingTokens.map(t => t.tokens);
    report.thinkingTokenMax = Math.max(...vals);
    report.thinkingTokenAvg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  // ─────────────────────────────────────
  // 보고서 생성
  // ─────────────────────────────────────
  const lines = [];
  lines.push('═══════════════════════════════════════════');
  lines.push('  503 에러 진단 보고서');
  lines.push('═══════════════════════════════════════════');
  lines.push('');

  // ── 체크 2: API 호출량 ──
  lines.push('▶ [체크 2] 총 API 호출 수 추정');
  lines.push(`  분석 범위: 행 ${report.rangeStart} ~ ${report.rangeEnd} (${report.totalRows}행)`);
  lines.push(`  문제(E열) 있는 행: ${report.rowsWithStem}개`);
  lines.push(`  풀이(C열) 있는 행: ${report.rowsWithSolution}개`);
  lines.push(`  추정 API 호출 수: ${report.estimatedApiCalls}회`);
  lines.push(`  → 분당 호출 밀도: INITIAL_BATCH=${5}행 × 2호출 = 10회/배치`);
  lines.push('');

  // ── 체크 3: 에러 분포 ──
  lines.push('▶ [체크 3] 에러 행 분포 패턴');
  lines.push(`  총 에러/timeout 행: ${report.errorRows.length}개 / ${report.totalRows}행 (${(report.errorRows.length / report.totalRows * 100).toFixed(1)}%)`);
  lines.push(`  성공: ${report.successRows}개, 스킵: ${report.skipRows}개`);
  lines.push('');
  lines.push(`  위치별 분포 (4분위):`);
  lines.push(`    1~25%  (초반): ${report.errorInFirst25pct}개 ${'█'.repeat(report.errorInFirst25pct)}`);
  lines.push(`    25~50% (중반): ${report.errorIn25to50pct}개 ${'█'.repeat(report.errorIn25to50pct)}`);
  lines.push(`    50~75% (후반): ${report.errorIn50to75pct}개 ${'█'.repeat(report.errorIn50to75pct)}`);
  lines.push(`    75~100%(끝):   ${report.errorInLast25pct}개 ${'█'.repeat(report.errorInLast25pct)}`);
  lines.push('');

  if (report.errorInFirst25pct > report.errorInLast25pct * 2) {
    lines.push('  📊 판정: 초반 집중 → API 할당량/초기 부하 문제 가능성');
  } else if (report.errorInLast25pct > report.errorInFirst25pct * 2) {
    lines.push('  📊 판정: 후반 집중 → 누적 부하/시간 예산 고갈 패턴');
  } else {
    lines.push('  📊 판정: 균등 분포 → 서버 측 간헐적 과부하 (503 high demand)');
  }
  lines.push('');

  // ── 체크 4: STEP 1 vs STEP 2 ──
  lines.push('▶ [체크 4] STEP 1(문제검증) vs STEP 2(해설검증) 실패 분석');
  lines.push(`  STEP 1만 실패: ${report.step1ErrorOnly}개`);
  lines.push(`  STEP 2만 실패: ${report.step2ErrorOnly}개`);
  lines.push(`  둘 다 실패:     ${report.bothStepError}개`);
  lines.push('');

  if (report.bothStepError > 0) {
    lines.push(`  ⚠️ 둘 다 실패한 ${report.bothStepError}개 행:`);
    lines.push(`     → STEP 1에서 503 발생 후 STEP 2도 연쇄 실패하는 패턴`);
    lines.push(`     → 원인: STEP 1 실패 시 catch에서 error 마킹 후 STEP 2를 시도하지 않음`);
  }
  if (report.step2ErrorOnly > report.step1ErrorOnly) {
    lines.push(`  ⚠️ STEP 2 단독 실패가 더 많음:`);
    lines.push(`     → STEP 1이 시간을 소진하여 STEP 2의 시간 예산 부족`);
  }
  lines.push('');

  // 에러 행 상세 목록
  lines.push('  에러 행 상세:');
  lines.push('  ─────────────────────────────────────────');
  for (const e of report.errorRows) {
    const nTag = e.nVal === 'error' || e.nVal === 'timeout' ? `N=${e.nVal}` : `N=${e.nVal}(ok)`;
    const qTag = e.qVal === 'error' || e.qVal === 'timeout' ? `Q=${e.qVal}` : `Q=${e.qVal}(ok)`;
    lines.push(`  행 ${String(e.row).padStart(3)}: ${nTag}, ${qTag}`);
    if (e.pNote && (e.nVal === 'error' || e.nVal === 'timeout')) {
      lines.push(`         P: ${e.pNote}`);
    }
    if (e.sError && (e.qVal === 'error' || e.qVal === 'timeout')) {
      lines.push(`         R: ${e.sError}`);
    }
  }
  lines.push('');

  // ── 체크 5: 에러 유형 분류 ──
  lines.push('▶ [체크 5] 에러 유형 분류');
  lines.push(`  "시간 예산 초과로 재시도 포기": ${report.timeBudgetExhausted}개`);
  lines.push(`  503 직접 에러 (시간예산 무관):  ${report.generic503}개`);
  lines.push(`  기타 에러:                      ${report.otherErrors}개`);
  lines.push('');

  if (report.timeBudgetExhausted > report.generic503) {
    lines.push('  📊 판정: 시간 예산 문제가 주된 원인');
    lines.push('     → 첫 503 후 재시도할 시간이 부족하여 즉시 포기');
    lines.push('     → API_CALL_RESERVE_MS(65초)가 실제 응답시간 대비 과대 추정');
    lines.push('     → 또는 MAX_EXEC_MS(3.5분)이 너무 짧음');
  } else if (report.generic503 > 0) {
    lines.push('  📊 판정: 503 서버 과부하가 주된 원인');
    lines.push('     → MAX_RETRIES(2회)와 대기시간(2~4초)이 부족');
  }
  lines.push('');

  // ── 체크 5-b: thinking 토큰 통계 ──
  lines.push('▶ [체크 5-b] Thinking 토큰 통계 (성공 행, S열)');
  if (report.thinkingTokens.length > 0) {
    lines.push(`  데이터 있는 행: ${report.thinkingTokens.length}개`);
    lines.push(`  평균: ${report.thinkingTokenAvg.toLocaleString()} 토큰`);
    lines.push(`  최대: ${report.thinkingTokenMax.toLocaleString()} 토큰`);

    // 상위 5개 행
    const top5 = [...report.thinkingTokens].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
    lines.push(`  최고 5개 행:`);
    for (const t of top5) {
      lines.push(`    행 ${t.row}: ${t.tokens.toLocaleString()} 토큰`);
    }

    if (report.thinkingTokenMax > 20000) {
      lines.push('');
      lines.push('  ⚠️ thinking 토큰이 매우 높은 행 존재');
      lines.push('     → 이런 행에서 API 응답시간이 길어져 시간 예산을 소진');
      lines.push('     → API_CALL_RESERVE_MS를 높이거나 행별 시간 예산을 동적 조정 필요');
    }
  } else {
    lines.push('  S열 데이터 없음 (thinking 토큰 미기록)');
  }
  lines.push('');

  // ── 체크 6: 동시 실행 여부 ──
  lines.push('▶ [체크 6] 동시 실행 여부');
  lines.push('  (이 항목은 자동 확인 불가 — 아래를 수동 확인해 주세요)');
  lines.push('  1) Google AI Studio → Settings → API Keys 에서');
  lines.push('     같은 API 키를 사용하는 다른 프로젝트가 없는지 확인');
  lines.push('  2) 검증 실행 중 다른 탭/스크립트에서 동일 키로 호출하지 않았는지 확인');
  lines.push('');

  // ── 종합 진단 ──
  lines.push('═══════════════════════════════════════════');
  lines.push('  종합 진단');
  lines.push('═══════════════════════════════════════════');
  lines.push('');

  const errorRate = report.errorRows.length / report.totalRows * 100;

  if (report.timeBudgetExhausted > report.errorRows.length * 0.5) {
    lines.push('🔴 주요 원인: 시간 예산(timeBudgetMs) 차단');
    lines.push('');
    lines.push('   현재 로직:');
    lines.push('     1) 첫 API 호출에서 503 수신 (약 수초 소요)');
    lines.push('     2) 재시도 전 시간 체크: elapsed + sleepMs(2초) + 65초 > stepBudget?');
    lines.push('     3) 대부분 "예" → "시간 예산 초과로 재시도 포기" 즉시 throw');
    lines.push('     4) 결과: MAX_RETRIES=2이지만 실제로는 1회만 시도하고 포기');
    lines.push('');
    lines.push('   권장 수정:');
    lines.push('     - MAX_RETRIES를 4~6으로 증가');
    lines.push('     - 지수 백오프 적용 (2초→4초→8초→16초)');
    lines.push('     - API_CALL_RESERVE_MS를 실제 응답시간 기반으로 축소 (65초→40초)');
    lines.push('     - 503일 때만 재시도, 400/401은 즉시 포기');
    lines.push('     - 행 간 1~2초 쿨다운 추가');

  } else if (report.generic503 > report.errorRows.length * 0.5) {
    lines.push('🔴 주요 원인: Gemini 서버 과부하 (503 high demand)');
    lines.push('');
    lines.push('   권장 수정:');
    lines.push('     - MAX_RETRIES를 4~6으로 증가');
    lines.push('     - 지수 백오프 + 지터 적용');
    lines.push('     - 연속 503 감지 시 배치 일시 중단 (5분 대기)');
    lines.push('     - 배치 간 간격을 3초→10초로 증가');

  } else {
    lines.push('🟡 복합적 원인: 시간 예산 + 서버 과부하 + 기타');
    lines.push('');
    lines.push('   권장: 위 두 가지 수정 사항 모두 적용');
  }

  lines.push('');
  lines.push(`실패율: ${errorRate.toFixed(1)}% (${report.errorRows.length}/${report.totalRows})`);
  lines.push(`진단 시각: ${new Date().toLocaleString('ko-KR')}`);

  // ─────────────────────────────────────
  // 결과 출력
  // ─────────────────────────────────────
  const reportText = lines.join('\n');
  Logger.log(reportText);

  // 사이드바로 표시
  const html = HtmlService.createHtmlOutput(
    `<pre style="font-family:'D2Coding','Noto Sans KR',monospace; font-size:12px; ` +
    `white-space:pre-wrap; padding:12px; line-height:1.6;">${escapeHtml_(reportText)}</pre>`
  ).setTitle('503 에러 진단 보고서').setWidth(600);

  ui.showSidebar(html);
}

/** HTML 이스케이프 */
function escapeHtml_(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}