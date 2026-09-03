/*************************************************
 * PipelineVerify.gs — 원클릭 검증 파이프라인  v1 (2026-09-01)
 *
 *  [메뉴] ▶️ 파이프라인 시작   : pv_start
 *  [메뉴] ⏯ 이어하기          : pv_resume
 *  [메뉴] 📋 상태 확인         : pv_status
 *  [메뉴] ⏹ 중지              : pv_stop
 *
 *  단계(stage)
 *   1. load    : Latex변환 파일 Data_DS!A열 키워드 검색(A~K)
 *                → 문제검토 Data_DS 초기화(A~AC) 후 붙여넣기
 *                ※ 검색·붙여넣기는 한 실행에서 원자적 수행
 *   2. verify  : 기존 문항 검증 트리거 체인(processVerificationQueue)
 *                시작 → 1분 간격 폴링으로 완료 대기 (+정체 자동 복구)
 *   3. retry   : N/Q열 error·timeout 행 헤드리스 재검증 (최대 2라운드)
 *   4. quality : STEP3 논리 검증 행 단위 루프 (전체 1패스 + error 1패스)
 *   5. stack   : Stack 저장 + AD(세트명)/AE(문항그룹) 자동 기입 (mts_core_ v4)
 *   6. stats   : 난이도 통계 재집계 (stat_core_)
 *   7. done    : Pipeline_Log 최종 요약 (메일 없음 — D7 결정)
 *
 *  설계 (실행계획서 V2):
 *   - 시간 예산 4분 + 1회용 시간 트리거 자동 이어하기 (6분 한도 대응)
 *   - 1시간 간격 watchdog: 예약 트리거 유실·쿼터 소진 정체 시 자동 재기동
 *     → 일일 트리거 쿼터(무료 계정 90분/일) 소진으로 멈춰도 다음 날 자동 재개
 *   - 기존 검증 엔진 무수정 재사용 (V_* props 설정 후 큐 시작, RUNNING 폴링)
 *   - 결과 서술 열(P/R)은 기록 시 lw_wrapBareMath_ 적용 (LatexWrap.gs)
 *
 *  의존(같은 프로젝트의 전역):
 *   VCONFIG, QCONFIG, getPromptSet, loadQualityPrompts_,
 *   callGeminiWithRetry_, getFormatGuide, verifyQualityForRow_,
 *   markRowAsTimeout_, deleteVerifyTriggers_, scheduleNextBatch_,
 *   mts_core_ (Movetostack.gs v3), stat_core_ (StatCalc.gs v3),
 *   lw_wrapBareMath_ (LatexWrap.gs), parseRowRange (MainMenu.gs)
 *************************************************/

const PV = {
  STATE_PROP: 'PV_STATE',
  STOP_PROP:  'PV_STOP',
  TICK_FN:     'pv_tick',
  WATCHDOG_FN: 'pv_watchdog',

  LATEX_FILE_ID_PROP:    'PV_LATEX_FILE_ID',
  LATEX_FILE_ID_DEFAULT: '1wu8GdvmpyxCqSKS5RiSlRhWGH4B2OMoPN0TGP94ti54',
  LATEX_SRC_SHEET: 'Data_DS',

  DATA_SHEET: 'Data_DS',
  LOG_SHEET:  'Pipeline_Log',
  NUM_COLS:   29,               // A~AC (v4: Y=fig_info, Z~AC 여유 열 포함)

  TIME_BUDGET_MS:  4 * 60 * 1000,   // tick 한 번의 시간 예산
  RESUME_AFTER_MS: 60 * 1000,       // yield 후 이어하기 지연
  POLL_AFTER_MS:   60 * 1000,       // verify 폴링 간격
  MAX_RESUMES:     2000,            // 폴링 포함 이어하기 총 상한

  RETRY_MAX_ROUNDS:   2,   // D3: STEP1·2 재검증 최대 라운드
  QUALITY_MAX_PASSES: 2,   // D3: STEP3 = 전체 1패스 + error 재시도 1패스
  VERIFY_STALE_MIN:  20,   // 문항 검증 heartbeat 정체 판정(분)
};

/* =================================================
 * 메뉴 진입점
 * ================================================= */
function pv_start() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();

  // ── 0. 동시 실행 방지 ──
  const cur = pv_loadState_();
  if (cur && !['done', 'error', 'stopped'].includes(cur.stage)) {
    const r = ui.alert('진행 중인 파이프라인이 있습니다',
      `현재 단계: ${cur.stage}\n키워드: ${(cur.keywords || []).join(', ')}\n\n중단하고 새로 시작할까요?`,
      ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;
    pv_clearAllTriggers_();
    props.setProperty(PV.STOP_PROP, 'false');
  }
  if (props.getProperty(VCONFIG.PROP.RUNNING) === 'true') {
    ui.alert('문항 검증이 이미 실행 중입니다.\n완료 후 시작하거나, [검토 > 작업 중단] 후 다시 시도하세요.');
    return;
  }
  if (props.getProperty('Q_RUNNING') === 'true') {
    ui.alert('논리 검증이 이미 실행 중입니다. 완료 후 다시 시도하세요.');
    return;
  }

  // ── 1. 사전 점검 일괄 ──
  const problems = [];
  if (!props.getProperty('GEMINI_API_KEY')) problems.push('GEMINI_API_KEY 미설정');
  if (!props.getProperty('CLAUDE_API_KEY')) problems.push('CLAUDE_API_KEY 미설정');
  const pP = getPromptSet('gemini_problem_verify');
  const sP = getPromptSet('gemini_solution_verify');
  if (!pP.system || !pP.user) problems.push('pmt: gemini_problem_verify (system/user) 누락');
  if (!sP.system || !sP.user) problems.push('pmt: gemini_solution_verify (system/user) 누락');
  if (!loadQualityPrompts_())  problems.push('pmt: gemini_quality_verify / claude_quality_judge (system/user) 누락');
  if (!ss.getSheetByName('Stack')) problems.push('Stack 시트 없음');
  if (!ss.getSheetByName('Stat'))  problems.push('Stat 시트 없음');
  let latexOk = false;
  try {
    const t = SpreadsheetApp.openById(pv_latexFileId_());
    latexOk = !!t.getSheetByName(PV.LATEX_SRC_SHEET);
    if (!latexOk) problems.push('Latex변환 파일에 Data_DS 시트 없음');
  } catch (e) {
    problems.push('Latex변환 파일 열기 실패 (권한/ID 확인): ' + e.message);
  }
  if (problems.length) {
    ui.alert('사전 점검 실패', '다음 문제를 해결한 뒤 다시 실행하세요:\n\n· ' + problems.join('\n· '), ui.ButtonSet.OK);
    return;
  }

  // ── 2. 키워드 입력 (D4: 쉼표/줄바꿈, OR, 대소문자 무시 포함) ──
  const res = ui.prompt('원클릭 검증 파이프라인',
    'Latex변환 Data_DS의 A열(key)에서 찾을 키워드를 입력하세요.\n' +
    '여러 개면 쉼표(,) 또는 줄바꿈으로 구분 (OR 조건, 부분 일치)\n예: S팀모의6회, S팀모의7회',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const keywords = Array.from(new Set(
    String(res.getResponseText() || '').split(/[,\n;]+/).map(s => s.trim()).filter(Boolean)
  ));
  if (!keywords.length) { ui.alert('키워드가 비어 있습니다.'); return; }

  // ── 3. D1: 기존 Data_DS 데이터 보호 ──
  const sheet = ss.getSheetByName(PV.DATA_SHEET);
  const lastRow = sheet.getLastRow();
  let preSavedRows = 0;
  if (lastRow >= 2) {
    const nVals = sheet.getRange(2, 14, lastRow - 1, 1).getValues();   // N열
    const hasN = nVals.some(r => String(r[0] || '').trim() !== '');
    if (hasN) {
      const r = ui.alert(
        '⚠️ 미저장 검증 결과 발견',
        'Data_DS에 검증 결과(N열)가 남아 있습니다.\n파이프라인은 시작 시 Data_DS를 비우므로 이 결과가 사라집니다.\n\n' +
        '예(YES): Stack에 먼저 저장한 뒤 진행 (권장)\n' +
        '아니오(NO): 저장하지 않고 지우고 진행\n' +
        '취소: 중단',
        ui.ButtonSet.YES_NO_CANCEL);
      if (r !== ui.Button.YES && r !== ui.Button.NO) return;
      if (r === ui.Button.YES) {
        const mres = mts_core_();
        if (!mres.ok) { ui.alert('Stack 선(先)저장 실패: ' + mres.message); return; }
        preSavedRows = mres.rows;
      }
    }
  }

  // ── 4. 최종 확인 ──
  const ok = ui.alert('확인',
    `키워드 ${keywords.length}개: ${keywords.join(' | ')}\n\n` +
    (preSavedRows ? `(기존 결과 ${preSavedRows}행을 Stack에 먼저 저장했습니다)\n` : '') +
    `Data_DS(2행 이하)를 초기화한 뒤 아래를 자동 실행합니다:\n` +
    `검색·붙여넣기 → 문항 검증(STEP1·2) → error 재검증 → 논리 검증(STEP3)\n` +
    `→ Stack 저장(+세트명·문항그룹 자동 기입) → 난이도 통계\n\n` +
    `진행 상황: Pipeline_Log 시트 / [📋 상태 확인] 메뉴\n계속할까요?`,
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  // ── 5. 상태 초기화 & 시작 ──
  const st = {
    stage: 'load', keywords: keywords, startedAt: new Date().toISOString(),
    resumes: 0, preSavedRows: preSavedRows,
    load: null, verify: null, retry: null, quality: null, stack: null, stats: null, error: ''
  };
  props.setProperty(PV.STOP_PROP, 'false');
  pv_saveState_(st);
  pv_log_(st, 'start', `키워드: ${keywords.join(' | ')}`);
  pv_createWatchdog_();
  pv_tick();
}

/** 메뉴: 중지 — 현재 행/배치 마무리 후 멈춤 */
function pv_stop() {
  const props = PropertiesService.getScriptProperties();
  const st = pv_loadState_();
  props.setProperty(PV.STOP_PROP, 'true');
  props.setProperty(VCONFIG.PROP.STOP, 'true');   // 문항 검증 체인도 중단
  pv_clearAllTriggers_();
  if (st && !['done', 'error', 'stopped'].includes(st.stage)) {
    st.stoppedFrom = st.stage;
    st.stage = 'stopped';
    pv_saveState_(st);
    pv_log_(st, 'stopped', `사용자 중지 (중단 시점 단계: ${st.stoppedFrom})`);
  }
  try { SpreadsheetApp.getUi().alert('파이프라인을 중지했습니다.\n[⏯ 이어하기] 메뉴로 중단 지점부터 재개할 수 있습니다.'); } catch (_) {}
}

/** 메뉴: 이어하기 — 중지/정체 상태에서 현재 단계부터 재기동 */
function pv_resume() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const st = pv_loadState_();
  if (!st) { ui.alert('실행 이력이 없습니다.'); return; }
  if (['done', 'error'].includes(st.stage)) {
    ui.alert(`이미 종료된 파이프라인입니다 (${st.stage}).\n새로 시작하려면 [▶️ 파이프라인 시작]을 사용하세요.`);
    return;
  }
  if (st.stage === 'stopped') {
    st.stage = st.stoppedFrom || 'load';
    delete st.stoppedFrom;
  }
  props.setProperty(PV.STOP_PROP, 'false');
  props.setProperty(VCONFIG.PROP.STOP, 'false');
  pv_saveState_(st);
  pv_log_(st, st.stage, '수동 이어하기 (pv_resume)');
  pv_createWatchdog_();
  pv_tick();
}

/** 메뉴: 상태 확인 */
function pv_status() {
  const st = pv_loadState_();
  const ui = SpreadsheetApp.getUi();
  if (!st) { ui.alert('실행 이력이 없습니다.'); return; }
  ui.alert('파이프라인 상태', pv_summary_(st), ui.ButtonSet.OK);
}

/* =================================================
 * 실행 엔진 — 메뉴에서 직접, 또는 시간 트리거에서 호출
 * ================================================= */
function pv_tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;             // 동시 실행 방지

  const deadline = Date.now() + PV.TIME_BUDGET_MS;
  const props = PropertiesService.getScriptProperties();
  let st = pv_loadState_();
  try {
    pv_clearTickTriggers_();                        // 1회용 트리거 정리
    if (!st || ['done', 'error', 'stopped'].includes(st.stage)) return;

    if (props.getProperty(PV.STOP_PROP) === 'true') {
      st.stoppedFrom = st.stage; st.stage = 'stopped';
      pv_saveState_(st); pv_log_(st, 'stopped', '중지 플래그 감지');
      pv_clearAllTriggers_();
      return;
    }

    let delayMs = PV.RESUME_AFTER_MS;
    let needResume = false;

    while (Date.now() < deadline) {
      const r = pv_runStage_(st, deadline);         // st.stage 를 진행시킴
      pv_saveState_(st);
      if (['done', 'error'].includes(st.stage)) break;
      if (props.getProperty(PV.STOP_PROP) === 'true') { needResume = false; break; }
      if (r === 'yield') { needResume = true; delayMs = PV.RESUME_AFTER_MS; break; }
      if (r === 'poll')  { needResume = true; delayMs = PV.POLL_AFTER_MS;   break; }
      // r === 'next' → 같은 실행에서 다음 단계 계속
    }

    if (!['done', 'error'].includes(st.stage) &&
        props.getProperty(PV.STOP_PROP) !== 'true' &&
        (needResume || Date.now() >= deadline)) {
      if (st.resumes >= PV.MAX_RESUMES) throw new Error(`이어하기 횟수 초과 (${PV.MAX_RESUMES})`);
      st.resumes++;
      pv_saveState_(st);
      ScriptApp.newTrigger(PV.TICK_FN).timeBased().after(delayMs).create();
      return;
    }
  } catch (e) {
    if (st) {
      st.stage = 'error';
      st.error = String((e && e.stack) || e);
      pv_saveState_(st);
      pv_log_(st, 'error', st.error);
    }
    pv_clearAllTriggers_();
  } finally {
    lock.releaseLock();
  }
  if (st && ['done', 'error'].includes(st.stage)) pv_finish_(st);
}

/** 한 단계 실행. 'next' | 'yield'(시간 부족, 같은 단계 재개) | 'poll'(완료 대기) 반환 */
function pv_runStage_(st, deadline) {
  const ss = SpreadsheetApp.getActive();
  const props = PropertiesService.getScriptProperties();

  switch (st.stage) {

    /* ── 1. 검색 + 붙여넣기 (한 실행에서 원자적) ── */
    case 'load': {
      const r = pv_load_(ss, st.keywords);
      st.load = r;
      pv_log_(st, 'load',
        `키워드 일치 ${r.found}건 → 적재 ${r.count}행 (행 2~${r.writeEnd})` +
        (r.excludedNoECount ? ` / E열(정규화) 빈 행 ${r.excludedNoECount}건 제외 (Latex변환 행: ${r.excludedNoE.join(', ')}${r.excludedNoECount > r.excludedNoE.length ? ' 외' : ''})` : ''));
      if (!r.count) {
        throw new Error('키워드에 해당하는 적재 가능 행이 없습니다.' +
          (r.excludedNoECount ? ` (E열 빈 행 ${r.excludedNoECount}건은 제외됨 — Latex변환 쪽 정규화 필요)` : ''));
      }
      st.stage = 'verify';
      return 'next';
    }

    /* ── 2. 문항 검증(STEP1·2): 기존 트리거 체인 시작 → 폴링 ── */
    case 'verify': {
      if (!st.verify) {
        if (props.getProperty(VCONFIG.PROP.RUNNING) === 'true') {
          throw new Error('문항 검증이 이미 실행 중입니다. (수동 실행과 충돌)');
        }
        deleteVerifyTriggers_();
        props.setProperties({
          [VCONFIG.PROP.CURRENT]:   '2',
          [VCONFIG.PROP.START]:     '2',
          [VCONFIG.PROP.END]:       String(st.load.writeEnd),
          [VCONFIG.PROP.STOP]:      'false',
          [VCONFIG.PROP.BATCH]:     String(VCONFIG.INITIAL_BATCH),
          [VCONFIG.PROP.RUNNING]:   'true',
          [VCONFIG.PROP.HEARTBEAT]: String(Date.now()),
        });
        scheduleNextBatch_();   // 10초 뒤 큐 시작 (tick의 시간 예산 보호를 위해 동기 호출하지 않음)
        st.verify = { polls: 0, recovered: 0 };
        pv_log_(st, 'verify', `문항 검증 시작: 행 2~${st.load.writeEnd} [${VCONFIG.GEMINI_MODEL}]`);
        return 'poll';
      }

      // ── 폴링 ──
      st.verify.polls++;
      if (props.getProperty(VCONFIG.PROP.RUNNING) !== 'true') {
        pv_log_(st, 'verify', `문항 검증 완료 (폴링 ${st.verify.polls}회, 정체 복구 ${st.verify.recovered}회)`);
        st.stage = 'retry';
        return 'next';
      }

      // 정체 감지 → 헤드리스 복구 (checkAndHandleStaleRun_의 UI 없는 버전)
      const hb = parseInt(props.getProperty(VCONFIG.PROP.HEARTBEAT), 10) || 0;
      const staleMin = hb ? (Date.now() - hb) / 60000 : 0;
      if (hb && staleMin >= PV.VERIFY_STALE_MIN) {
        const curRow = parseInt(props.getProperty(VCONFIG.PROP.CURRENT), 10);
        const endRow = parseInt(props.getProperty(VCONFIG.PROP.END), 10);
        if (curRow && endRow && curRow <= endRow) {
          try { markRowAsTimeout_(curRow, Math.round(staleMin)); } catch (_) {}
          props.setProperty(VCONFIG.PROP.CURRENT, String(curRow + 1));
        }
        props.setProperty(VCONFIG.PROP.HEARTBEAT, String(Date.now()));
        scheduleNextBatch_();
        st.verify.recovered++;
        pv_log_(st, 'verify',
          `정체 감지(${Math.round(staleMin)}분 무진척) → 행 ${curRow} timeout 처리 후 큐 재기동 (#${st.verify.recovered})`);
      }
      return 'poll';
    }

    /* ── 3. error/timeout 재검증 (STEP1·2, 최대 2라운드) ── */
    case 'retry': {
      if (!st.retry) st.retry = { round: 0, inProgress: false, remain: [] };
      const sheet = ss.getSheetByName(PV.DATA_SHEET);
      const targets = pv_scanErrorRows_(sheet, st.load.writeEnd);

      if (!targets.length) {
        pv_log_(st, 'retry', st.retry.round
          ? `재검증 완료 — 전부 해소 (총 ${st.retry.round}라운드)`
          : 'error/timeout 행 없음 — 재검증 생략');
        st.retry.remain = [];
        st.stage = 'quality';
        return 'next';
      }

      if (!st.retry.inProgress) {
        if (st.retry.round >= PV.RETRY_MAX_ROUNDS) {
          st.retry.remain = targets.map(t => t.row);
          pv_log_(st, 'retry',
            `라운드 한도(${PV.RETRY_MAX_ROUNDS}) 도달 — 미해결 ${targets.length}행: ${pv_short_(st.retry.remain)} → 계속 진행 (D3)`);
          st.stage = 'quality';
          return 'next';
        }
        st.retry.round++;
        st.retry.inProgress = true;
        pv_log_(st, 'retry', `라운드 ${st.retry.round} 시작 — 대상 ${targets.length}행: ${pv_short_(targets.map(t => t.row))}`);
      }

      const pPr = getPromptSet('gemini_problem_verify');
      const sPr = getPromptSet('gemini_solution_verify');
      if (!pPr.system || !sPr.system) throw new Error('재검증 프롬프트 로드 실패 (pmt 시트 확인)');

      let done = 0;
      for (const t of targets) {
        if (props.getProperty(PV.STOP_PROP) === 'true') return 'yield';
        if (deadline - Date.now() < VCONFIG.ROW_TIME_RESERVE_MS) {
          pv_log_(st, 'retry', `라운드 ${st.retry.round} 진행 중 시간 예산 소진 (${done}/${targets.length}) → 자동 이어하기`);
          return 'yield';   // 재진입 시 재스캔 → 남은 error 행만 다시 대상
        }
        pv_retryRow_(sheet, t, pPr, sPr, deadline);
        done++;
        Utilities.sleep(VCONFIG.INTER_ROW_COOLDOWN_MS);
      }
      SpreadsheetApp.flush();
      st.retry.inProgress = false;
      pv_log_(st, 'retry', `라운드 ${st.retry.round} 완료 (${done}행 재시도) → 잔존 재확인`);
      return 'next';   // 같은 단계 재진입 → 재스캔으로 잔존 확인
    }

    /* ── 4. 논리 검증 (STEP3): 전체 1패스 + error 재시도 1패스 ── */
    case 'quality': {
      if (!st.quality) st.quality = { pass: 1, cursor: 2, remain: [] };
      const sheet = ss.getSheetByName(PV.DATA_SHEET);
      const qPrompts = loadQualityPrompts_();
      if (!qPrompts) throw new Error('STEP3 프롬프트 로드 실패 (pmt 시트 확인)');

      const endRow = st.load.writeEnd;
      const uVals = sheet.getRange(2, QCONFIG.COL.Q_VERDICT, endRow - 1, 1).getValues();

      for (let row = st.quality.cursor; row <= endRow; row++) {
        const u = String(uVals[row - 2][0] || '').toLowerCase().trim();
        if (u && u !== 'error' && u !== 'timeout') continue;   // 완료 행 건너뜀 (재개 대응)
        if (props.getProperty(PV.STOP_PROP) === 'true') { st.quality.cursor = row; return 'yield'; }
        const remaining = deadline - Date.now();
        if (remaining < QCONFIG.ROW_TIME_RESERVE_MS) {
          st.quality.cursor = row;
          return 'yield';
        }
        verifyQualityForRow_(sheet, row, qPrompts, remaining);
        Utilities.sleep(QCONFIG.INTER_ROW_COOLDOWN_MS);
      }
      SpreadsheetApp.flush();

      // 패스 완료 → error 잔존 확인
      const remainErr = pv_scanQualityUnresolved_(sheet, endRow);
      if (remainErr.length && st.quality.pass < PV.QUALITY_MAX_PASSES) {
        pv_log_(st, 'quality', `패스 ${st.quality.pass} 완료 — error/timeout ${remainErr.length}행 재시도: ${pv_short_(remainErr)}`);
        st.quality.pass++;
        st.quality.cursor = 2;
        return 'next';
      }
      st.quality.remain = remainErr;
      pv_log_(st, 'quality', `논리 검증 완료 (패스 ${st.quality.pass})` +
        (remainErr.length ? ` — 미해결 ${remainErr.length}행: ${pv_short_(remainErr)} → 계속 진행 (D3)` : ''));
      st.stage = 'stack';
      return 'next';
    }

    /* ── 5. Stack 저장 + Y/Z 자동 기입 ── */
    case 'stack': {
      const r = mts_core_();
      if (!r.ok) throw new Error('Stack 저장 실패: ' + r.message);
      st.stack = {
        rows: r.rows, appendRow: r.appendRow, endRow: r.endRow,
        emptyN: r.emptyNRows, keyParseFail: r.keyParseFail
      };
      pv_log_(st, 'stack',
        `Stack ${r.rows}행 저장 (행 ${r.appendRow}~${r.endRow}) / Y·Z 자동 기입` +
        (r.emptyNRows.length ? ` / 미검증(N 빈칸) ${r.emptyNRows.length}행: ${pv_short_(r.emptyNRows)} (D2: 함께 저장)` : '') +
        (r.keyParseFail.length ? ` / key 분해 실패 ${r.keyParseFail.length}건 (Stack 행: ${pv_short_(r.keyParseFail)})` : ''));
      st.stage = 'stats';
      return 'next';
    }

    /* ── 6. 난이도 통계 ── */
    case 'stats': {
      const r = stat_core_();
      if (!r.ok) throw new Error('난이도 통계 실패: ' + r.message);
      st.stats = r;
      pv_log_(st, 'stats', `난이도 통계: 연속 구간 ${r.runs}개, 세트 집계 ${r.sets}개, 기준 미달 제외 ${r.skipped}개`);
      st.stage = 'done';
      return 'next';
    }

    default:
      throw new Error('알 수 없는 단계: ' + st.stage);
  }
}

/* =================================================
 * 단계별 코어 (UI 없음)
 * ================================================= */

/** Latex변환 파일 ID (스크립트 속성 우선) */
function pv_latexFileId_() {
  return PropertiesService.getScriptProperties().getProperty(PV.LATEX_FILE_ID_PROP)
      || PV.LATEX_FILE_ID_DEFAULT;
}

/**
 * load: Latex변환 Data_DS!A~K에서 키워드 포함 행 검색 →
 * 문제검토 Data_DS 초기화(A~AC) 후 A~K 붙여넣기
 */
function pv_load_(ss, keywords) {
  const srcSs = SpreadsheetApp.openById(pv_latexFileId_());
  const src = srcSs.getSheetByName(PV.LATEX_SRC_SHEET);
  if (!src) throw new Error('Latex변환 파일에 ' + PV.LATEX_SRC_SHEET + ' 시트가 없습니다.');

  const last = src.getLastRow();
  if (last < 2) throw new Error('Latex변환 Data_DS에 데이터가 없습니다.');

  const vals = src.getRange(2, 1, last - 1, 11).getValues();   // A~K
  const kws = keywords.map(k => k.toLowerCase());

  const excludedNoE = [];
  const rowsOut = [];
  let found = 0;
  vals.forEach((r, i) => {
    const key = String(r[0] || '').trim();
    if (!key) return;
    const kl = key.toLowerCase();
    if (!kws.some(k => kl.indexOf(k) !== -1)) return;
    found++;
    if (String(r[4] || '').trim() === '') {   // E열(정규화 문제) 빈 행 제외 (D6)
      excludedNoE.push(i + 2);
      return;
    }
    rowsOut.push(r);
  });

  const dst = ss.getSheetByName(PV.DATA_SHEET);
  if (!dst) throw new Error('문제검토 Data_DS 시트를 찾을 수 없습니다.');
  if (dst.getMaxColumns() < PV.NUM_COLS) {   // v4: A~AC 폭 보장
    dst.insertColumnsAfter(dst.getMaxColumns(), PV.NUM_COLS - dst.getMaxColumns());
  }
  const maxRows = dst.getMaxRows();
  if (maxRows >= 2) dst.getRange(2, 1, maxRows - 1, PV.NUM_COLS).clearContent();   // A~AC 전체 클리어 (v4)
  if (rowsOut.length) dst.getRange(2, 1, rowsOut.length, 11).setValues(rowsOut);
  SpreadsheetApp.flush();

  return {
    found: found,
    count: rowsOut.length,
    excludedNoE: excludedNoE.slice(0, 30),   // 상태 9KB 보호
    excludedNoECount: excludedNoE.length,
    writeStart: 2,
    writeEnd: 1 + rowsOut.length,
  };
}

/** N/Q열에서 error·timeout 행 스캔 (STEP1·2 재검증 대상) */
function pv_scanErrorRows_(sheet, endRow) {
  if (!endRow || endRow < 2) return [];
  const data = sheet.getRange(2, 1, endRow - 1, 18).getValues();   // A~R
  const targets = [];
  for (let i = 0; i < data.length; i++) {
    const n = String(data[i][VCONFIG.COL.P_VERDICT - 1] || '').toLowerCase().trim();
    const q = String(data[i][VCONFIG.COL.S_VERDICT - 1] || '').toLowerCase().trim();
    const nErr = (n === 'error' || n === 'timeout');
    const qErr = (q === 'error' || q === 'timeout');
    if (nErr || qErr) targets.push({ row: i + 2, retryProblem: nErr, retrySolution: qErr });
  }
  return targets;
}

/** U열에서 미해결(빈칸·error·timeout) 행 스캔 (STEP3) */
function pv_scanQualityUnresolved_(sheet, endRow) {
  if (!endRow || endRow < 2) return [];
  const uVals = sheet.getRange(2, QCONFIG.COL.Q_VERDICT, endRow - 1, 1).getValues();
  const out = [];
  for (let i = 0; i < uVals.length; i++) {
    const u = String(uVals[i][0] || '').toLowerCase().trim();
    if (u === '' || u === 'error' || u === 'timeout') out.push(i + 2);
  }
  return out;
}

/**
 * 한 행 STEP1·2 재검증 (retryErrorRows의 헤드리스판)
 * - 결과 서술(P/R)은 lw_wrapBareMath_ 적용
 * - 실패 시 N/Q를 그대로 두어 다음 라운드에서 다시 잡히게 함
 */
function pv_retryRow_(sheet, t, pPrompts, sPrompts, deadline) {
  try {
    const stem       = String(sheet.getRange(t.row, VCONFIG.COL.STEM).getValue() || '').trim();
    const solution   = String(sheet.getRange(t.row, VCONFIG.COL.SOLUTION).getValue() || '').trim();
    const answerType = String(sheet.getRange(t.row, VCONFIG.COL.ANSWER_TYPE).getValue() || '').trim();

    // ── STEP 1 ──
    if (t.retryProblem) {
      if (stem === '') {
        sheet.getRange(t.row, VCONFIG.COL.P_VERDICT, 1, 3)
          .setValues([['skip', '', 'E열(문제) 비어있음']]);
      } else {
        const formatGuide = getFormatGuide(answerType);
        const imgsP1 = iv_imageParts_([stem]);                       // 패치 13: 그림 첨부
        sheet.getRange(t.row, VCONFIG.COL_FIG_INFO).setValue(iv_figInfo_(imgsP1));
        // ★ 함수형 치환: 치환값의 $$/$& 특수 패턴이 LaTeX를 손상시키지 않도록
        const userContent = pPrompts.user
          .replace('{problem}', function () { return stem; })
          .replace('{format}',  function () { return formatGuide; }) + iv_imageNote_(imgsP1);

        const split = (t.retryProblem && t.retrySolution) ? 2 : 1;
        const budget = Math.max((deadline - Date.now()) / split, VCONFIG.API_CALL_RESERVE_MS);
        const pResult = callGeminiWithRetry_(pPrompts.system, userContent, pPrompts.assistant, budget, imgsP1);

        sheet.getRange(t.row, VCONFIG.COL.P_VERDICT, 1, 3).setValues([[
          String(pResult.verdict || 'error').toLowerCase(),
          String(pResult.derived_answer || '').trim(),
          lw_wrapBareMath_(String(pResult.solution_note || '').trim()),
        ]]);
        sheet.getRange(t.row, VCONFIG.COL.THINKING_TOKENS)
          .setValue(pResult._usage?.thoughtsTokenCount || 0);
        sheet.getRange(t.row, VCONFIG.COL.MODEL_NAME).setValue(VCONFIG.GEMINI_MODEL);
      }
    }

    if (t.retryProblem && t.retrySolution) Utilities.sleep(VCONFIG.INTER_ROW_COOLDOWN_MS);

    // ── STEP 2 ──
    if (t.retrySolution) {
      if (solution === '') {
        sheet.getRange(t.row, VCONFIG.COL.S_VERDICT, 1, 2)
          .setValues([['SKIP', 'C열(풀이) 비어있음']]);
      } else {
        const imgsP2 = iv_imageParts_([stem, solution]);             // 패치 13: 그림 첨부
        sheet.getRange(t.row, VCONFIG.COL_FIG_INFO).setValue(iv_figInfo_(imgsP2));
        const userContent2 = sPrompts.user
          .replace(/\{problem\}/g,  function () { return stem; })
          .replace(/\{solution\}/g, function () { return solution; }) + iv_imageNote_(imgsP2);

        const budget = Math.max(deadline - Date.now(), VCONFIG.API_CALL_RESERVE_MS);
        const sResult = callGeminiWithRetry_(sPrompts.system, userContent2, sPrompts.assistant, budget, imgsP2);

        sheet.getRange(t.row, VCONFIG.COL.S_VERDICT, 1, 2).setValues([[
          String(sResult.verdict || 'error').toLowerCase(),
          lw_wrapBareMath_(String(sResult.error_report || '').trim()),
        ]]);
      }
    }
  } catch (e) {
    Logger.log(`pv_retryRow_ row ${t.row}: ${e.message}`);
  }
}

/* =================================================
 * watchdog — 1시간 간격, 파이프라인 활성 중에만 존재
 * (예약 트리거 유실·일일 쿼터 소진 정체 시 자동 재기동)
 * ================================================= */
function pv_watchdog() {
  const st = pv_loadState_();
  if (!st || ['done', 'error', 'stopped'].includes(st.stage)) {
    pv_deleteWatchdog_();
    return;
  }
  const hasTick = ScriptApp.getProjectTriggers()
    .some(t => t.getHandlerFunction() === PV.TICK_FN);
  if (!hasTick) {
    pv_log_(st, 'watchdog', '예약된 이어하기 트리거 없음 → 자동 재기동');
    pv_tick();   // 실행 중이면 락에 막혀 무해하게 종료
  }
}

function pv_createWatchdog_() {
  pv_deleteWatchdog_();
  ScriptApp.newTrigger(PV.WATCHDOG_FN).timeBased().everyHours(1).create();
}

function pv_deleteWatchdog_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === PV.WATCHDOG_FN) ScriptApp.deleteTrigger(t);
  });
}

function pv_clearTickTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === PV.TICK_FN) ScriptApp.deleteTrigger(t);
  });
}

function pv_clearAllTriggers_() {
  pv_clearTickTriggers_();
  pv_deleteWatchdog_();
}

/* =================================================
 * 상태 / 로그 / 요약
 * ================================================= */
function pv_loadState_() {
  const s = PropertiesService.getScriptProperties().getProperty(PV.STATE_PROP);
  try { return s ? JSON.parse(s) : null; } catch (_) { return null; }
}

function pv_saveState_(st) {
  PropertiesService.getScriptProperties().setProperty(PV.STATE_PROP, JSON.stringify(st));
}

function pv_log_(st, stage, msg) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(PV.LOG_SHEET);
    if (!sh) { sh = ss.insertSheet(PV.LOG_SHEET); sh.appendRow(['time', 'run', 'stage', 'message']); }
    sh.appendRow([new Date(), st ? st.startedAt : '', stage, msg]);
  } catch (_) {}
}

function pv_short_(rows) {
  if (!rows || !rows.length) return '없음';
  return rows.slice(0, 10).join(', ') + (rows.length > 10 ? ` 외 ${rows.length - 10}개` : '');
}

function pv_summary_(st) {
  const lines = [
    `단계: ${st.stage}${st.stoppedFrom ? ` (중단 시점: ${st.stoppedFrom})` : ''}`,
    `키워드: ${(st.keywords || []).join(' | ')}`,
    `시작: ${st.startedAt}   이어하기: ${st.resumes}회`,
  ];
  if (st.preSavedRows) lines.push(`시작 전 Stack 선저장: ${st.preSavedRows}행`);
  if (st.load) lines.push(
    `적재: 키워드 일치 ${st.load.found}건 → ${st.load.count}행 (행 2~${st.load.writeEnd})` +
    (st.load.excludedNoECount ? ` / E열 빈 행 ${st.load.excludedNoECount}건 제외` : ''));
  if (st.verify) lines.push(`문항 검증: 폴링 ${st.verify.polls}회, 정체 복구 ${st.verify.recovered}회`);
  if (st.retry) lines.push(
    `재검증: ${st.retry.round}라운드` +
    (st.retry.remain && st.retry.remain.length ? `, 미해결 ${st.retry.remain.length}행 (${pv_short_(st.retry.remain)})` : ' — 전부 해소'));
  if (st.quality) lines.push(
    `논리 검증: 패스 ${st.quality.pass}` +
    (st.quality.remain && st.quality.remain.length ? `, 미해결 ${st.quality.remain.length}행 (${pv_short_(st.quality.remain)})` : ''));
  if (st.stack) lines.push(
    `Stack: ${st.stack.rows}행 저장 (행 ${st.stack.appendRow}~${st.stack.endRow})` +
    (st.stack.emptyN && st.stack.emptyN.length ? `, 미검증 ${st.stack.emptyN.length}행` : '') +
    (st.stack.keyParseFail && st.stack.keyParseFail.length ? `, key 분해 실패 ${st.stack.keyParseFail.length}건` : ''));
  if (st.stats) lines.push(`통계: 구간 ${st.stats.runs}, 세트 ${st.stats.sets}, 제외 ${st.stats.skipped}`);
  if (st.error) lines.push(`오류: ${st.error}`);
  return lines.join('\n');
}

function pv_finish_(st) {
  pv_clearAllTriggers_();
  const title = st.stage === 'done' ? '✅ 파이프라인 완료' : '❌ 파이프라인 오류';
  pv_log_(st, st.stage, title + ' — 최종 요약:\n' + pv_summary_(st));
  try {
    SpreadsheetApp.getActive().toast(title + ' (상세: Pipeline_Log / 📋 상태 확인 메뉴)', '원클릭 파이프라인', 10);
  } catch (_) {}
}