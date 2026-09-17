/**
 * ============================================================
 * QualityVerification.gs — STEP 3: 해설 논리 검증 + STEP 4: 해설 군더더기 검출 (v5)
 * ============================================================
 * 패치 14 (2026-09-17): 치명적 API 오류 시 즉시 멈춤 (Itemverification.gs 패치 14 필요)
 *   - Gemini HTTP 오류는 iv_geminiHttpError_ 로 quotaId 포함 → 일일/분당 한도 구분
 *   - Claude 크레딧/결제 오류는 iv_markFatal_ 로 기록 (종전: 재시도만 안 하고 다음 행 계속)
 *   - startQualityVerification: 행 처리 후 iv_getFatal_() 이면 루프 중단 + 사유 안내
 *   - 실행기: qr_start 에서 표시 해제, qr_processRow 는 치명적 오류 행을 error+사유로 반환하고
 *     다음 호출에서 'stopped' 반환 → 사이드바가 멈춤
 * ============================================================
 * v5 변경사항 (2026-09-10, STEP4 군더더기 검출 — "논리 분리 · 운영 통합"):
 *   - STEP4 신설: 결론에 영향을 주지 않아도 없어야 할 서술(군더더기) 3유형을 검출한다.
 *       irrelevant(무관) / redundant(중복) / loose_equivalence(느슨한 서술)
 *     1차 Gemini(gemini_garbage_verify) → 2차 Claude(claude_garbage_judge, 삭제 검사·동치 검사)
 *     → 코드 합성. STEP3와 같은 뼈대이지만 프롬프트·Claude 호출·결과 열·어휘·상한을 **분리**한다.
 *   - 결과 열: Z(26) garbage_verdict / AA(27) garbage_report / AB(28) garbage_audit  (AC는 여유)
 *     어휘: clean / garbage / check / skip / error / timeout — U열의 ok/fail과 섞지 않는다
 *     (fail은 Stack에서 "틀린 해설"의 집계 기준이라 군더더기가 들어가면 오염된다).
 *   - STEP3 판정 로직(verifyQualityForRow_·Q_TYPES·synthesizeQuality_)·U/V/W/X 는 **무변경**.
 *   - 운영은 통합: 실행기 하나(사이드바 모드 논리/군더더기/둘 다), 상태·중단 키 Q_* 공유,
 *     파이프라인 quality 단계가 행마다 STEP3→STEP4 (Pipelineverify.gs, PV_RUN_GARBAGE 로 on/off).
 *   - ⚠ 행당 서버 호출은 검증마다 따로다 — `둘 다`는 행마다 qr_processRow 를 두 번 부른다
 *     (실행기 예산 270초에 STEP3 한 행이 100~200초라 한 호출에 합치면 timeout).
 *   - ⚠ 대상 선별·재개·재검증은 U와 Z 를 **각각** 본다 — STEP3가 끝난 행에 군더더기만 소급할 수 있고,
 *     군더더기 판정만 실패한 행은 Z만 error 라 STEP3를 다시 돌리지 않는다.
 *   - escalate: 군더더기 판정자가 "이건 결함이다"를 발견하면 Z를 check 이상으로 올리고
 *     AA에 [결함의심n] 블록을 남긴다. U열은 건드리지 않는다 — 사람이 V열과 대조한다.
 *   - 프롬프트 원본은 Mathory `lib/verify/prompts.ts`(Phase 61h)이고 pmt 6행이 그것을 이식했다.
 *     type 키·판정 잣대는 양쪽이 같다(Stack Z/AA 가 Mathory 프로브의 대조군이 된다).
 *
 * v4 변경사항 (2026-09-06, 프롬프트 V2 대응 — 결함 유형 6종 확장):
 *   - 결함 유형 2종 → 6종: logic_gap(비약) / invalid_inference(오추론) /
 *     unwarranted_assumption(가정) / case_omission(경우누락) /
 *     sufficiency_unchecked(충분성) / inconsistency(불일치)
 *   - Q_TYPES 상수 신설: sanitizeCandidates_ 의 type 정규화와
 *     synthesizeQuality_ 의 V열 라벨이 이 한 곳을 참조 (유형 추가 시 여기만 수정)
 *   - 미지 type 은 부분 문자열로 정규화, 그래도 실패하면 logic_gap 으로 폴백
 *   - MAX_CANDIDATES 8 → 12 (1차 Gemini 가 recall 지향으로 바뀌어 후보 증가)
 *   - 합성 규칙(valid≥1→fail, uncertain≥1→check, 전부 invalid→ok)은 변경 없음
 *   - pmt 시트 gemini_quality_verify / claude_quality_judge V2 프롬프트와 함께 적용할 것
 *     (구 프롬프트와도 호환: 2종만 오면 그대로 동작)
 *
 * v2 변경사항:
 *   - 사이드바 실행기(QualityRunner.html) 추가: 행 1건 = 서버 호출 1건 구조로
 *     GAS 6분 실행 한도를 원천 회피 → 시간 초과 재시작 불필요.
 *     (Gmail 계정의 트리거 총 실행시간 90분/일 한도를 소모하지 않는
 *      사용자 상호작용 실행이므로 하루 100건 목표에 적합)
 *   - 서버 함수: openQualityRunner / qr_start / qr_processRow / qr_finish / qr_requestStop
 *   - 동시 실행 가드: STEP1·2(V_RUNNING) 진행 중이면 시작 거부
 *   - 기존 동기 실행(startQualityVerification)은 보조용으로 유지(에디터에서 호출 가능)
 *
 * 목적:
 *   [STEP3] 해설의 논리 결함(비약·오추론·근거 없는 가정·경우 누락·충분성 미확인·불일치)을
 *   비대칭 교차 검증으로 판정한다.
 *     [1차] Gemini(후보 생성, recall) → [2차] Claude(후보 판정, precision)
 *     → [합성] 코드 로직으로 U/V/W/X 기록
 *   [STEP4] 해설의 군더더기(무관·중복·느슨한 서술)를 같은 뼈대로 검출한다 (v5, 2-G 절).
 *     [1차] Gemini(후보) → [2차] Claude(삭제 검사·동치 검사, "확신할 때만 valid") → [합성] Z/AA/AB 기록
 *
 * 설계 원칙:
 *   - STEP 1·2(ItemVerification)와 완전 분리. 트리거 체인 미사용(메뉴 수동 실행).
 *   - Claude는 Gemini 후보가 1개 이상인 행에서만 호출(비용 절감).
 *   - U열 verdict 어휘: ok / check / fail / skip  (+ API 실패 시 error / timeout)
 *     → 'fail' = 확정 결함. 'error'/'timeout'은 재검증(retryErrorRows) 대상 전용.
 *
 * 신규 열:
 *   U(21) Q_VERDICT   ok/check/fail/skip/error/timeout
 *   V(22) Q_REPORT    확정 결함 리포트 (valid 판정만, 사람이 읽는 결과)
 *   W(23) Q_AUDIT     감사 추적: Gemini 후보 ↔ Claude 판정 대조 (파일럿 정밀도 측정용)
 *   X(24) JUDGE_MODEL 2차 판정 Claude 모델명 (Claude 미호출 시 빈칸)
 *   (v5) Z(26) garbage_verdict  clean/garbage/check/skip/error/timeout
 *   (v5) AA(27) garbage_report  확정 군더더기 리포트 [무관n]/[중복n]/[느슨n] + 결함 의심 [결함의심n]
 *   (v5) AB(28) garbage_audit   감사 추적 (첫 줄 judge=모델·후보 수)
 *
 * ScriptProperties:
 *   PV_RUN_GARBAGE   (선택, v5) 'false' 면 파이프라인 quality 단계에서 STEP4 를 건너뜀 (미설정 = 실행)
 *   CLAUDE_API_KEY   (필수) Anthropic API 키
 *   Q_GEMINI_MODEL   (선택) 기본 gemini-3.1-pro-preview — STEP3 전용 1차 모델(전환 메뉴와 무관하게 고정)
 *   Q_CLAUDE_MODEL   (선택) 기본 claude-opus-4-8
 *   Q_STOP / Q_RUNNING / Q_LAST_HEARTBEAT — 실행 상태
 *
 * 재사용(Itemverification.gs의 전역 함수, 수정 없음):
 *   getPromptSet, safeParseGeminiJson_, is503Error_, parseRowRange(MainMenu.gs)
 *   (패치 14) iv_markFatal_, iv_getFatal_, iv_clearFatal_, iv_geminiHttpError_
 *
 * v3 (패치 12 확장): 그림 첨부
 *   - 본문(E·C열) 속 ![파일명](Drive링크) 그림을 내려받아 1차 Gemini 에는 inline_data,
 *     2차 Claude 에는 base64 image 블록으로 함께 보낸다.
 *   - Itemverification.gs 패치 12 의 iv_imageParts_ / iv_imageNote_ 를 재사용하므로
 *     그 패치가 먼저 적용되어 있어야 한다 (없으면 조용히 텍스트만으로 동작).
 * ============================================================
 */

/* ─── STEP3 설정 (VCONFIG와 완전 분리) ─── */
const QCONFIG = {
  DATA_SHEET: 'Data_DS',

  /* 1차: Gemini — 전환 메뉴(V_GEMINI_MODEL)와 무관하게 STEP3 전용으로 고정 */
  GEMINI_MODEL: PropertiesService.getScriptProperties().getProperty('Q_GEMINI_MODEL') || 'gemini-3.1-pro-preview',
  GEMINI_THINKING_LEVEL: 'HIGH',

  /* 2차: Claude Opus 4.8 — adaptive thinking + effort
     주의: temperature/top_p 등 샘플링 파라미터는 지원되지 않음(설정 시 400) */
  CLAUDE_MODEL: PropertiesService.getScriptProperties().getProperty('Q_CLAUDE_MODEL') || 'claude-opus-4-8',
  CLAUDE_MAX_TOKENS: 16000,          // thinking + 응답 합산 하드캡
  CLAUDE_EFFORT: 'high',
  ANTHROPIC_VERSION: '2023-06-01',

  /* 시간 예산 (메뉴 동기 실행: GAS 6분 한도 내 안전 마진) */
  MAX_EXEC_MS:         Math.round(1000 * 60 * 4.5),  // 4.5분
  ROW_TIME_RESERVE_MS: 120000,   // 행 시작 전 최소 확보 시간(Gemini+Claude 감안)
  API_CALL_RESERVE_MS: 45000,

  /* v2: 사이드바 실행기 — 서버 호출 1건당 1행 처리 예산 (실행당 6분 한도 내 마진) */
  RUNNER_ROW_BUDGET_MS: 270000,  // 4.5분

  /* 재시도 */
  MAX_RETRIES:    5,
  RETRY_DELAY_MS: 3000,
  INTER_ROW_COOLDOWN_MS: 1500,

  /* 후보 상한 (Claude 프롬프트 비대 방지)
     v4: 8 → 12. 1차 프롬프트가 심각도순 정렬을 지시하므로 절단 시 앞쪽(중요) 후보가 남는다. */
  MAX_CANDIDATES: 12,

  /* Data_DS 열 번호 */
  COL: {
    STEM:        5,   // E
    SOLUTION:    3,   // C
    Q_VERDICT:  21,   // U
    Q_REPORT:   22,   // V
    Q_AUDIT:    23,   // W
    JUDGE_MODEL: 24,  // X
  },

  /* v5: STEP4 군더더기 검출 — 결함 검증(U~X)과 열·어휘·상한을 분리한다.
     모델·예산·재시도·STEM/SOLUTION 은 상위 QCONFIG 를 그대로 쓴다(사본 금지). */
  G: {
    MAX_CANDIDATES: 6,   // 군더더기는 모든 해설에 조금씩 있어 상한을 먼저 채운다 — 1차 정렬 지시(느슨→중복→무관)와 짝
    COL: {
      G_VERDICT: 26,     // Z   clean / garbage / check / skip / error / timeout
      G_REPORT:  27,     // AA  [느슨1]·[중복1]·[무관1]·[결함의심1] 지점/근거/제안
      G_AUDIT:   28,     // AB  첫 줄 judge=<모델>·후보 k건 + 후보별 감사줄
    },                   // AC(29)는 여유로 남긴다. Movetostack 이 A~AC 를 통째로 이관하므로 Stack 에도 같은 자리.
    HEADERS: { 26: 'garbage_verdict', 27: 'garbage_report', 28: 'garbage_audit' },
  },
  /* 파이프라인 스위치(ScriptProperty). 'false' 일 때만 STEP4 를 건너뛴다 — 미설정 = 실행. 실행기는 모드로 고른다. */
  RUN_GARBAGE_PROP: 'PV_RUN_GARBAGE',

  PROP: {
    STOP:      'Q_STOP',
    RUNNING:   'Q_RUNNING',
    HEARTBEAT: 'Q_LAST_HEARTBEAT',
  },
};

/** v5: 파이프라인이 STEP4 를 돌릴지 (PV_RUN_GARBAGE !== 'false') */
function q_runGarbageEnabled_() {
  return PropertiesService.getScriptProperties().getProperty(QCONFIG.RUN_GARBAGE_PROP) !== 'false';
}


/* ═══════════════════════════════════════════════
   1. 메뉴 진입 / 중단
   ═══════════════════════════════════════════════ */

/**
 * 메뉴 호출: 행 범위를 입력받아 STEP3 논리 검증을 동기 실행
 * - U열이 이미 채워진 행(error/timeout 제외)은 자동 건너뜀
 *   → 시간 초과로 중단된 뒤 같은 범위를 재입력하면 이어서 처리됨
 */
function startQualityVerification() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QCONFIG.DATA_SHEET);
  if (!sheet) { ui.alert('Data_DS 시트를 찾을 수 없습니다.'); return; }

  // ── 사전 점검: API 키 ──
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('GEMINI_API_KEY')) { ui.alert('GEMINI_API_KEY가 설정되지 않았습니다.'); return; }
  if (!props.getProperty('CLAUDE_API_KEY')) { ui.alert('CLAUDE_API_KEY가 설정되지 않았습니다.'); return; }

  // ── 사전 점검: 프롬프트 (role 누락 시 조용히 빈 문자열이 되므로 반드시 검증) ──
  const qPrompts = loadQualityPrompts_();
  if (!qPrompts) {
    ui.alert(
      '프롬프트 로드 실패',
      'pmt 시트에서 gemini_quality_verify / claude_quality_judge 세트를 읽지 못했습니다.\n' +
      'key 접두어, role(system/user), enabled(TRUE) 값을 확인하세요.',
      ui.ButtonSet.OK
    );
    return;
  }

  // ── 행 범위 입력 ──
  const input = ui.prompt(
    '논리 검증 (STEP 3)',
    '검증할 행 범위를 입력하세요 (예: 2-47)\n\n' +
    '· U열이 이미 채워진 행(error/timeout 제외)은 건너뜁니다.\n' +
    '· 시간 초과로 중단되면 같은 범위로 재실행하면 이어서 처리됩니다.',
    ui.ButtonSet.OK_CANCEL
  );
  if (input.getSelectedButton() !== ui.Button.OK) return;

  const range = parseRowRange(input.getResponseText());
  if (!range || range.startRow < 2) { ui.alert('유효하지 않은 범위입니다. (예: 2-47)'); return; }

  // ── 대상 행 선별 (U열 기준 건너뛰기) ──
  const numRows = range.endRow - range.startRow + 1;
  const uVals = sheet.getRange(range.startRow, QCONFIG.COL.Q_VERDICT, numRows, 1).getValues();
  const targets = [];
  let skippedDone = 0;
  for (let i = 0; i < numRows; i++) {
    const u = String(uVals[i][0] || '').toLowerCase().trim();
    if (u === '' || u === 'error' || u === 'timeout') {
      targets.push(range.startRow + i);
    } else {
      skippedDone++;
    }
  }

  if (targets.length === 0) {
    ui.alert(`범위 내 처리할 행이 없습니다. (이미 완료 ${skippedDone}개)`);
    return;
  }

  const confirm = ui.alert(
    '논리 검증 시작 확인',
    `1차: Gemini (${QCONFIG.GEMINI_MODEL})\n` +
    `2차: Claude (${QCONFIG.CLAUDE_MODEL}) — 후보가 있는 행만 호출\n\n` +
    `대상: ${targets.length}개 행 (이미 완료 ${skippedDone}개 건너뜀)\n` +
    `범위: ${range.startRow} ~ ${range.endRow}\n\n` +
    `시작하시겠습니까?`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  // ── 실행 상태 설정 ──
  iv_clearFatal_();   // 패치 14: 새 작업 시작
  props.setProperties({
    [QCONFIG.PROP.STOP]:      'false',
    [QCONFIG.PROP.RUNNING]:   'true',
    [QCONFIG.PROP.HEARTBEAT]: String(Date.now()),
  });

  // ── 동기 루프 ──
  const startTime = Date.now();
  const stats = { ok: 0, fail: 0, check: 0, skip: 0, error: 0 };
  let lastDoneRow = 0;
  let stoppedBy = '';   // '' | 'time' | 'user' | 'fatal'(패치 14)

  try {
    for (let k = 0; k < targets.length; k++) {
      const row = targets[k];

      // 사용자 중단
      if (props.getProperty(QCONFIG.PROP.STOP) === 'true') { stoppedBy = 'user'; break; }

      // 시간 예산
      const remaining = QCONFIG.MAX_EXEC_MS - (Date.now() - startTime);
      if (remaining < QCONFIG.ROW_TIME_RESERVE_MS) { stoppedBy = 'time'; break; }

      props.setProperty(QCONFIG.PROP.HEARTBEAT, String(Date.now()));

      const status = verifyQualityForRow_(sheet, row, qPrompts, remaining);
      if (stats[status] !== undefined) stats[status]++;
      lastDoneRow = row;

      // 패치 14: 치명적 API 오류 → 남은 행 호출 중단
      if (iv_getFatal_()) { stoppedBy = 'fatal'; break; }

      if (k < targets.length - 1) Utilities.sleep(QCONFIG.INTER_ROW_COOLDOWN_MS);
      if (k % 3 === 0) SpreadsheetApp.flush();
    }
  } finally {
    SpreadsheetApp.flush();
    props.setProperty(QCONFIG.PROP.RUNNING, 'false');
  }

  const done = stats.ok + stats.fail + stats.check + stats.skip + stats.error;
  const summary =
    `처리: ${done} / ${targets.length}\n` +
    `· ok(결함 없음): ${stats.ok}\n` +
    `· fail(확정 결함): ${stats.fail}\n` +
    `· check(보류): ${stats.check}\n` +
    `· skip(풀이 없음): ${stats.skip}\n` +
    `· error(호출 실패): ${stats.error}\n` +
    `마지막 처리 행: ${lastDoneRow || '없음'}`;

  if (stoppedBy === 'fatal') {
    ui.alert('⛔ 논리 검증 — API 한도 초과로 중단',
      `사유: ${iv_getFatal_()}\n\n` + summary +
      '\n\n한도를 조정한 뒤 같은 범위로 메뉴를 재실행하면 남은 행(빈칸·error)부터 이어서 처리됩니다.',
      ui.ButtonSet.OK);
  } else if (stoppedBy === 'time') {
    ui.alert('논리 검증 — 시간 한도 근접으로 중단',
      summary + '\n\n같은 범위로 메뉴를 재실행하면 남은 행부터 이어서 처리됩니다.',
      ui.ButtonSet.OK);
  } else if (stoppedBy === 'user') {
    ui.alert('논리 검증 — 사용자 중단', summary, ui.ButtonSet.OK);
  } else {
    ui.alert('논리 검증 완료', summary, ui.ButtonSet.OK);
  }
}

/** 메뉴 호출: STEP3·STEP4 중단 요청 (실행기·동기 실행·파이프라인 quality 단계 공통 — Q_STOP 하나) */
function stopQualityVerification() {
  PropertiesService.getScriptProperties().setProperty(QCONFIG.PROP.STOP, 'true');
  SpreadsheetApp.getActiveSpreadsheet().toast('논리·군더더기 검증 중단 요청됨. 현재 작업 처리 후 멈춥니다.');
}

/** pmt 시트에서 STEP3 프롬프트 2세트 로드 (system/user 필수 검증) */
function loadQualityPrompts_() {
  const gem   = getPromptSet('gemini_quality_verify');
  const judge = getPromptSet('claude_quality_judge');
  if (!gem.system || !gem.user || !judge.system || !judge.user) return null;
  return { gem: gem, judge: judge };
}


/* ═══════════════════════════════════════════════
   2. 행 단위 검증 (retryErrorRows에서도 재사용)
   ═══════════════════════════════════════════════ */

/**
 * 한 행에 대해 STEP3 전체 흐름 수행 후 U/V/W/X 기록.
 * API 실패는 내부에서 U='error'로 기록하고 'error'를 반환한다(throw하지 않음).
 *
 * @param {Sheet}  sheet     Data_DS 시트
 * @param {number} row       행 번호
 * @param {Object} qPrompts  { gem:{system,user,assistant}, judge:{system,user,assistant} }
 * @param {number} budgetMs  이 행에 허용된 총 시간(ms)
 * @return {string} 'ok' | 'fail' | 'check' | 'skip' | 'error'
 */
function verifyQualityForRow_(sheet, row, qPrompts, budgetMs) {
  const rowStart = Date.now();
  const C = QCONFIG.COL;

  const stem     = String(sheet.getRange(row, C.STEM).getValue()     || '').trim();
  const solution = String(sheet.getRange(row, C.SOLUTION).getValue() || '').trim();

  // ── 풀이 없음 → skip ──
  if (solution === '') {
    writeQualityRow_(sheet, row, 'skip', '', 'C열(풀이) 비어있음', '');
    return 'skip';
  }

  try {
    // ── (패치 12 확장) 본문 그림 수집: Itemverification 패치 12 가 있어야 동작 ──
    const qImgs = (typeof iv_imageParts_ === 'function') ? iv_imageParts_([stem, solution]) : [];
    const qNote = (typeof iv_imageNote_ === 'function') ? iv_imageNote_(qImgs) : '';   // 패치 13: 누락 목록 포함

    // ── [1차] Gemini 후보 생성 ──
    // ★ 함수형 치환 필수: 문자열 치환값의 $$/$& 특수 패턴이 LaTeX를 손상시킴
    const gemUser = qPrompts.gem.user
      .replace(/\{problem\}/g,  function () { return stem; })
      .replace(/\{solution\}/g, function () { return solution; }) + qNote;

    const gemBudget = Math.max((budgetMs - (Date.now() - rowStart)) / 2, QCONFIG.API_CALL_RESERVE_MS);
    const gemParsed = callGeminiForQuality_(qPrompts.gem.system, gemUser, qPrompts.gem.assistant, gemBudget, qImgs);

    // 배열 스키마 필수 검증 (4단계 폴백은 candidates를 모름 → 누락 = 파싱 실패로 간주)
    if (!Array.isArray(gemParsed.candidates)) {
      throw new Error('Gemini 응답에서 candidates 배열을 파싱하지 못했습니다.');
    }

    // ── 후보 없음 → ok (Claude 미호출) ──
    let candidates = sanitizeCandidates_(gemParsed.candidates);
    if (candidates.length === 0) {
      writeQualityRow_(sheet, row, 'ok', '', '(후보 없음)', '');
      return 'ok';
    }

    // 후보 상한
    let truncNote = '';
    if (candidates.length > QCONFIG.MAX_CANDIDATES) {
      truncNote = `(후보 ${candidates.length}개 중 ${QCONFIG.MAX_CANDIDATES}개만 판정)`;
      candidates = candidates.slice(0, QCONFIG.MAX_CANDIDATES);
    }

    // quote 실재성 표기 (판정은 Claude에 위임, 감사 정보만)
    const normSol = normalizeForQuoteCheck_(solution);
    candidates.forEach(function (c) {
      c._quoteFound = normSol.indexOf(normalizeForQuoteCheck_(c.quote)) !== -1;
    });

    // ── [2차] Claude 판정 ──
    const candidatesText = formatCandidatesForJudge_(candidates);
    const judgeUser = qPrompts.judge.user
      .replace(/\{problem\}/g,    function () { return stem; })
      .replace(/\{solution\}/g,   function () { return solution; })
      .replace(/\{candidates\}/g, function () { return candidatesText; }) + qNote;

    const claudeBudget = budgetMs - (Date.now() - rowStart);
    const judgeParsed = callClaudeWithRetry_(qPrompts.judge.system, judgeUser, claudeBudget, q_claudeImageBlocks_(qImgs));

    if (!Array.isArray(judgeParsed.judgments)) {
      throw new Error('Claude 응답에서 judgments 배열을 파싱하지 못했습니다.');
    }

    // ── [합성] ──
    const synth = synthesizeQuality_(candidates, judgeParsed.judgments, truncNote);
    writeQualityRow_(sheet, row, synth.verdict, synth.report, synth.audit, QCONFIG.CLAUDE_MODEL);
    return synth.verdict;

  } catch (e) {
    Logger.log(`STEP3 row ${row} error: ${e.message}`);
    writeQualityRow_(sheet, row, 'error', '', `[Error] ${String(e.message).slice(0, 400)}`, '');
    return 'error';
  }
}

/** U/V/W/X 4개 열 일괄 기록 */
function writeQualityRow_(sheet, row, verdict, report, audit, judgeModel) {
  sheet.getRange(row, QCONFIG.COL.Q_VERDICT, 1, 4)
    .setValues([[verdict, report, audit, judgeModel]]);
}

/**
 * JSON 파싱이 "성공"하며 조용히 손상된 LaTeX 명령 복구.
 * 예: JSON 문자열 "\frac"은 \f가 유효 이스케이프라 form feed + "rac"으로 파싱됨.
 * 제어문자 바로 뒤에 영문자가 이어지면 LaTeX 명령으로 보고 백슬래시를 복원한다.
 * (기존 fixJsonStringEscapes_는 파싱 '실패' 시에만 개입하므로 이 경로를 못 잡음)
 */
function repairLatexControlChars_(s) {
  return String(s || '')
    .replace(/\f(?=[a-zA-Z])/g, '\\f')   // \frac, \forall ...
    .replace(/\x08(?=[a-zA-Z])/g, '\\b') // \begin, \beta ...
    .replace(/\r(?=[a-zA-Z])/g, '\\r')   // \right, \rho ...
    .replace(/\n(?=[a-zA-Z])/g, '\\n')   // \neq, \nabla ... (최소 길이 인용에서 개행+영문자는 희소)
    .replace(/\t(?=[a-zA-Z])/g, '\\t');  // \theta, \tan, \text ...
}

/**
 * v4: 결함 유형 정의 (단일 출처)
 *  - label : V열 리포트 블록 제목 "[라벨n]" 에 쓰는 한글 라벨
 *  - hints : 1차 모델이 type 을 변형해 보냈을 때 정규화용 부분 문자열 (소문자, 앞의 것이 우선)
 *  순서는 폴백 판정 순서이기도 하다. 'logic_gap' 은 마지막 폴백이므로 hints 검사 대상에서 제외.
 */
const Q_TYPES = {
  invalid_inference:      { label: '오추론',   hints: ['infer', 'invalid'] },
  unwarranted_assumption: { label: '가정',     hints: ['assum', 'unwarrant'] },
  case_omission:          { label: '경우누락', hints: ['case', 'omiss'] },
  sufficiency_unchecked:  { label: '충분성',   hints: ['suffic', 'uncheck'] },
  inconsistency:          { label: '불일치',   hints: ['incons'] },
  logic_gap:              { label: '비약',     hints: ['gap', 'logic'] },
};
const Q_TYPE_FALLBACK = 'logic_gap';

/** 1차 응답의 type 문자열을 Q_TYPES 키로 정규화. 정확 일치 → 부분 문자열 → 폴백 */
function normalizeCandidateType_(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
  if (Object.prototype.hasOwnProperty.call(Q_TYPES, t)) return t;
  const keys = Object.keys(Q_TYPES);
  for (let k = 0; k < keys.length; k++) {
    const hints = Q_TYPES[keys[k]].hints;
    for (let h = 0; h < hints.length; h++) {
      if (t.indexOf(hints[h]) !== -1) return keys[k];
    }
  }
  return Q_TYPE_FALLBACK;
}

/** Gemini 후보 배열 정제: 필드 문자열화, LaTeX 복구, type 정규화(v4: 6종), 빈 quote 제거, id 재부여 */
function sanitizeCandidates_(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i] || {};
    // ★ 복구를 trim보다 먼저: 선두의 \f 등 제어문자가 trim에 공백으로 소실되기 전에 복원
    const quote  = repairLatexControlChars_(String(c.quote  || '')).trim();
    const reason = repairLatexControlChars_(String(c.reason || '')).trim();
    const type   = normalizeCandidateType_(c.type);
    if (quote === '' && reason === '') continue;
    out.push({ id: 'c' + (out.length + 1), type: type, quote: quote, reason: reason });
  }
  return out;
}

/** quote 실재성 검사용 정규화(공백 제거) */
function normalizeForQuoteCheck_(s) {
  return String(s || '').replace(/\s+/g, '');
}

/** Claude user 프롬프트의 {candidates} 자리에 넣을 가독 텍스트 */
function formatCandidatesForJudge_(candidates) {
  return candidates.map(function (c) {
    return c.id + ' [' + c.type + ']\n' +
           'quote: ' + c.quote + '\n' +
           'reason: ' + c.reason;
  }).join('\n\n');
}

/**
 * §3.3 합성 규칙 (순수 코드 로직)
 *  - valid ≥ 1        → 'fail'  (V열에 확정 결함 리포트)
 *  - uncertain ≥ 1    → 'check'
 *  - 전부 invalid     → 'ok'
 *  - 판정 누락 후보   → uncertain으로 취급
 */
function synthesizeQuality_(candidates, judgments, truncNote) {
  const byId = {};
  judgments.forEach(function (j) {
    if (j && j.id) byId[String(j.id).trim()] = j;
  });

  // v4: 라벨·카운터를 Q_TYPES 에서 생성 (유형 추가 시 Q_TYPES 만 수정)
  const counter = {};
  Object.keys(Q_TYPES).forEach(function (k) { counter[k] = 0; });
  const labelOf = function (type) {
    return (Q_TYPES[type] && Q_TYPES[type].label) || Q_TYPES[Q_TYPE_FALLBACK].label;
  };
  const reportBlocks = [];
  const auditLines = [];
  let validCnt = 0, uncertainCnt = 0;

  candidates.forEach(function (c) {
    const j = byId[c.id];
    let ruling = j ? String(j.ruling || '').toLowerCase().trim() : '';
    let note   = j ? repairLatexControlChars_(String(j.note || '')).trim() : '';
    if (ruling !== 'valid' && ruling !== 'invalid' && ruling !== 'uncertain') {
      ruling = 'uncertain';
      note = note || '판정 누락';
    }

    if (ruling === 'valid') {
      validCnt++;
      if (!Object.prototype.hasOwnProperty.call(counter, c.type)) counter[c.type] = 0;
      counter[c.type]++;
      reportBlocks.push(
        '[' + labelOf(c.type) + counter[c.type] + ']\n' +
        '지점: ' + c.quote + '\n' +
        '근거: ' + (note || c.reason)
      );
    } else if (ruling === 'uncertain') {
      uncertainCnt++;
    }

    auditLines.push(
      '[' + c.id + '|' + c.type + (c._quoteFound === false ? '|quote원문불일치' : '') + '] ' +
      c.quote + ' → Claude:' + ruling + (note ? ' (' + note + ')' : '')
    );
  });

  const verdict = (validCnt >= 1) ? 'fail' : (uncertainCnt >= 1 ? 'check' : 'ok');
  let audit = auditLines.join('\n');
  if (truncNote) audit = truncNote + '\n' + audit;

  return { verdict: verdict, report: reportBlocks.join('\n\n'), audit: audit };
}


/* ═══════════════════════════════════════════════
   2-G. STEP 4: 해설 군더더기 검출 (v5)
   ═══════════════════════════════════════════════
   STEP3 와 같은 뼈대(1차 Gemini 후보 → 2차 Claude 판정 → 코드 합성)를 쓰되
   프롬프트·Claude 호출·결과 열(Z/AA/AB)·어휘(clean/garbage/check)·상한(6)을 분리한다.
   API 호출기·그림 수집·LaTeX 복구·quote 정규화는 STEP3 의 헬퍼를 그대로 호출한다.

   판정 잣대(프롬프트가 수행):
     irrelevant / redundant → 삭제 검사: 그 대목을 지워도 (문제 조건 + 남은 풀이)로 논증이 완결되는가
     loose_equivalence     → 동치 검사: ⟺ 한 줄로 쓸 수 있고 고교 과정에서 자명하며 결론은 옳은가
   경계는 하나 — 결론이 안전한가. 위태로우면 결함(STEP3 몫) → 2차가 escalate 로 표시.

   ⚠ STEP3 의 normalizeCandidateType_ 를 재사용하지 말 것 — 폴백이 logic_gap 이라 군더더기가 결함으로 샌다.
   ⚠ 2차 성향은 STEP3 와 반대다("확신할 때만 valid"). 프롬프트를 STEP3 판정자에 합치지 말 것. */

/** pmt 시트에서 STEP4 프롬프트 2세트 로드 (system/user 필수 검증) */
function loadGarbagePrompts_() {
  const gem   = getPromptSet('gemini_garbage_verify');
  const judge = getPromptSet('claude_garbage_judge');
  if (!gem.system || !gem.user || !judge.system || !judge.user) return null;
  return { gem: gem, judge: judge };
}

/**
 * v5: 군더더기 유형 정의 (단일 출처). label 은 AA열 블록 제목 "[라벨n]".
 * ⚠ 순서가 정규화의 우선순위다: irrelevant → redundant → loose_equivalence.
 *    '불필요'.includes('필요') 가 참이라 느슨 힌트에 '필요'·'충분'을 두면 '불필요'가 느슨으로 샌다(Mathory 61h E3) —
 *    느슨 힌트는 loose/equiv/necess/suffic/느슨/동치/iff 만, 그리고 irrelevant 를 먼저 본다('unnecess' 가 'necess' 보다 먼저 걸린다).
 */
const G_TYPES = {
  irrelevant:        { label: '무관', hints: ['irrelev', 'unrelat', 'unnecess', '무관', '불필요'] },
  redundant:         { label: '중복', hints: ['redund', 'repet', 'duplic', '중복', '중언'] },
  loose_equivalence: { label: '느슨', hints: ['loose', 'equiv', 'necess', 'suffic', '느슨', '동치', 'iff'] },
};
const G_TYPE_FALLBACK = 'irrelevant';
/** AA열 [결함의심n] 블록에 적을 STEP3 유형 라벨 — escalate_tag 가 STEP3 type 키로 온다 */
function g_escalateLabel_(tag) {
  const t = String(tag || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
  if (Q_TYPES[t]) return Q_TYPES[t].label;
  // 한글/변형 키 흡수 (Mathory 태그가 그대로 올 수도 있다)
  if (/충분|suffic/.test(t)) return Q_TYPES.sufficiency_unchecked.label;
  if (/경우|case|omiss/.test(t)) return Q_TYPES.case_omission.label;
  if (/가정|assum|unwarrant/.test(t)) return Q_TYPES.unwarranted_assumption.label;
  if (/비약|gap/.test(t)) return Q_TYPES.logic_gap.label;
  if (/불일치|일관|incons/.test(t)) return Q_TYPES.inconsistency.label;
  return Q_TYPES.invalid_inference.label;   // 논리오류/invalid_inference/미지 → 오추론
}

/** 1차 응답의 type 을 G_TYPES 키로 정규화. 정확 일치 → 부분 문자열 → 폴백(irrelevant) */
function normalizeGarbageType_(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
  if (Object.prototype.hasOwnProperty.call(G_TYPES, t)) return t;
  const keys = Object.keys(G_TYPES);
  for (let k = 0; k < keys.length; k++) {
    const hints = G_TYPES[keys[k]].hints;
    for (let h = 0; h < hints.length; h++) {
      if (t.indexOf(hints[h]) !== -1) return keys[k];
    }
  }
  return G_TYPE_FALLBACK;
}

/** Gemini 군더더기 후보 정제 (STEP3 sanitizeCandidates_ 등가, type 정규화만 교체) */
function sanitizeGarbageCandidates_(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i] || {};
    const quote  = repairLatexControlChars_(String(c.quote  || '')).trim();
    const reason = repairLatexControlChars_(String(c.reason || '')).trim();
    const type   = normalizeGarbageType_(c.type);
    if (quote === '' && reason === '') continue;
    out.push({ id: 'c' + (out.length + 1), type: type, quote: quote, reason: reason });
  }
  return out;
}

/** Data_DS 열 폭(≥AB)과 Z1/AA1/AB1 헤더 보장 (빈 칸일 때만 — 패치 13 iv_ensureFigInfoHeader_ 방식) */
function g_ensureHeaders_(sheet) {
  try {
    const cols = QCONFIG.G.COL;
    const maxCol = Math.max(cols.G_VERDICT, cols.G_REPORT, cols.G_AUDIT);
    if (sheet.getMaxColumns() < maxCol) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), maxCol - sheet.getMaxColumns());
    }
    Object.keys(QCONFIG.G.HEADERS).forEach(function (col) {
      const cell = sheet.getRange(1, Number(col));
      if (!String(cell.getValue() || '').trim()) cell.setValue(QCONFIG.G.HEADERS[col]);
    });
  } catch (e) {
    Logger.log('[STEP4] 헤더 보장 실패(무시): ' + e.message);
  }
}

/** Z/AA/AB 3열 일괄 기록 */
function writeGarbageRow_(sheet, row, verdict, report, audit) {
  sheet.getRange(row, QCONFIG.G.COL.G_VERDICT, 1, 3).setValues([[verdict, report, audit]]);
}

/**
 * 한 행에 대해 STEP4 전체 흐름 수행 후 Z/AA/AB 기록. U/V/W/X 는 건드리지 않는다.
 * API 실패는 내부에서 Z='error' 로 기록하고 'error' 를 반환한다(throw 하지 않음).
 *
 * @param {Sheet}  sheet     Data_DS 시트
 * @param {number} row       행 번호
 * @param {Object} gPrompts  loadGarbagePrompts_() 결과
 * @param {number} budgetMs  이 행에 허용된 총 시간(ms)
 * @return {string} 'clean' | 'garbage' | 'check' | 'skip' | 'error'
 */
function verifyGarbageForRow_(sheet, row, gPrompts, budgetMs) {
  const rowStart = Date.now();
  const C = QCONFIG.COL;

  const stem     = String(sheet.getRange(row, C.STEM).getValue()     || '').trim();
  const solution = String(sheet.getRange(row, C.SOLUTION).getValue() || '').trim();

  if (solution === '') {
    writeGarbageRow_(sheet, row, 'skip', '', 'C열(풀이) 비어있음');
    return 'skip';
  }

  try {
    const imgs = (typeof iv_imageParts_ === 'function') ? iv_imageParts_([stem, solution]) : [];
    const note = (typeof iv_imageNote_ === 'function') ? iv_imageNote_(imgs) : '';

    // ── [1차] Gemini 후보 생성 — ★ 함수형 치환($$/$& 패턴 보호) ──
    const gemUser = gPrompts.gem.user
      .replace(/\{problem\}/g,  function () { return stem; })
      .replace(/\{solution\}/g, function () { return solution; }) + note;

    const gemBudget = Math.max((budgetMs - (Date.now() - rowStart)) / 2, QCONFIG.API_CALL_RESERVE_MS);
    const gemParsed = callGeminiForQuality_(gPrompts.gem.system, gemUser, gPrompts.gem.assistant, gemBudget, imgs);

    if (!Array.isArray(gemParsed.candidates)) {
      throw new Error('Gemini 응답에서 candidates 배열을 파싱하지 못했습니다.');
    }

    let candidates = sanitizeGarbageCandidates_(gemParsed.candidates);
    if (candidates.length === 0) {
      writeGarbageRow_(sheet, row, 'clean', '', 'judge=— · (후보 없음)');
      return 'clean';
    }

    let truncNote = '';
    if (candidates.length > QCONFIG.G.MAX_CANDIDATES) {
      truncNote = `(후보 ${candidates.length}개 중 ${QCONFIG.G.MAX_CANDIDATES}개만 판정)`;
      candidates = candidates.slice(0, QCONFIG.G.MAX_CANDIDATES);
    }

    const normSol = normalizeForQuoteCheck_(solution);
    candidates.forEach(function (c) {
      c._quoteFound = normSol.indexOf(normalizeForQuoteCheck_(c.quote)) !== -1;
    });

    // ── [2차] Claude 판정 (STEP3 와 별도 프롬프트·별도 호출) ──
    const judgeUser = gPrompts.judge.user
      .replace(/\{problem\}/g,    function () { return stem; })
      .replace(/\{solution\}/g,   function () { return solution; })
      .replace(/\{candidates\}/g, function () { return formatCandidatesForJudge_(candidates); }) + note;

    const claudeBudget = budgetMs - (Date.now() - rowStart);
    const judgeParsed = callClaudeWithRetry_(gPrompts.judge.system, judgeUser, claudeBudget, q_claudeImageBlocks_(imgs));

    if (!Array.isArray(judgeParsed.judgments)) {
      throw new Error('Claude 응답에서 judgments 배열을 파싱하지 못했습니다.');
    }

    const synth = synthesizeGarbage_(candidates, judgeParsed.judgments, truncNote);
    writeGarbageRow_(sheet, row, synth.verdict, synth.report, synth.audit);
    return synth.verdict;

  } catch (e) {
    Logger.log(`STEP4 row ${row} error: ${e.message}`);
    writeGarbageRow_(sheet, row, 'error', '', `[Error] ${String(e.message).slice(0, 400)}`);
    return 'error';
  }
}

/**
 * STEP4 합성 (순수 코드 로직)
 *  - valid ≥ 1      → 'garbage'   (AA열에 확정 군더더기 블록)
 *  - uncertain ≥ 1  → 'check'
 *  - 그 외          → 'clean'
 *  - escalate ≥ 1   → clean 이면 'check' 로 올리고 AA에 [결함의심n] 블록 (U열은 건드리지 않는다)
 *  - 판정 누락·미지 값은 uncertain (STEP3 와 동일)
 *  - suggestion 은 valid 일 때만 싣는다 (Mathory 61h 실측: 판정자가 uncertain 에도 제안을 붙인다 → 코드로 강제)
 */
function synthesizeGarbage_(candidates, judgments, truncNote) {
  const byId = {};
  judgments.forEach(function (j) {
    if (j && j.id) byId[String(j.id).trim()] = j;
  });

  const counter = {};
  Object.keys(G_TYPES).forEach(function (k) { counter[k] = 0; });
  let escCounter = 0;
  const labelOf = function (type) {
    return (G_TYPES[type] && G_TYPES[type].label) || G_TYPES[G_TYPE_FALLBACK].label;
  };

  const reportBlocks = [];
  const auditLines = [];
  let validCnt = 0, uncertainCnt = 0, escalateCnt = 0;

  candidates.forEach(function (c) {
    const j = byId[c.id];
    let ruling = j ? String(j.ruling || '').toLowerCase().trim() : '';
    let note   = j ? repairLatexControlChars_(String(j.note || '')).trim() : '';
    const suggestion = j ? repairLatexControlChars_(String(j.suggestion || '')).trim() : '';
    const escalate   = !!(j && j.escalate === true);
    const escTag     = j ? String(j.escalate_tag || '').trim() : '';
    if (ruling !== 'valid' && ruling !== 'invalid' && ruling !== 'uncertain') {
      ruling = 'uncertain';
      note = note || '판정 누락';
    }

    if (escalate) {
      // 군더더기가 아니라 결함 의심 — ruling 과 무관하게 사람에게 보인다. U열 무접촉.
      escalateCnt++;
      escCounter++;
      reportBlocks.push(
        '[결함의심' + escCounter + ']\n' +
        '지점: ' + c.quote + '\n' +
        '근거: [군더더기 검토에서 격상] ' + (note || c.reason) + '\n' +
        'STEP3 유형: ' + g_escalateLabel_(escTag) + ' → U/V열과 대조'
      );
    } else if (ruling === 'valid') {
      validCnt++;
      if (!Object.prototype.hasOwnProperty.call(counter, c.type)) counter[c.type] = 0;
      counter[c.type]++;
      reportBlocks.push(
        '[' + labelOf(c.type) + counter[c.type] + ']\n' +
        '지점: ' + c.quote + '\n' +
        '근거: ' + (note || c.reason) +
        (suggestion ? '\n제안: ' + suggestion : '')
      );
    } else if (ruling === 'uncertain') {
      uncertainCnt++;
    }

    auditLines.push(
      '[' + c.id + '|' + c.type + (c._quoteFound === false ? '|quote원문불일치' : '') + '] ' +
      c.quote + ' → Claude:' + ruling + (note ? ' (' + note + ')' : '') +
      (escalate ? ' → escalate:' + (escTag || '?') : '')
    );
  });

  let verdict = (validCnt >= 1) ? 'garbage' : (uncertainCnt >= 1 ? 'check' : 'clean');
  if (escalateCnt >= 1 && verdict === 'clean') verdict = 'check';

  let audit = 'judge=' + QCONFIG.CLAUDE_MODEL + ' · 후보 ' + candidates.length + '건' +
              (truncNote ? ' ' + truncNote : '') +
              (escalateCnt ? ' · 결함의심 ' + escalateCnt + '건' : '') + '\n' + auditLines.join('\n');

  return { verdict: verdict, report: reportBlocks.join('\n\n'), audit: audit };
}


/* ═══════════════════════════════════════════════
   3. Gemini 호출 (STEP3 전용 — 모델 고정)
   ═══════════════════════════════════════════════
   기존 callGeminiUnified_는 전환 메뉴의 VCONFIG.GEMINI_MODEL을 사용하므로
   STEP3의 "1차 = 3.1 Pro 고정" 원칙을 위해 전용 호출기를 둔다.
   safeParseGeminiJson_ / is503Error_ 는 전역 함수라 그대로 재사용. */

function callGeminiForQuality_(sys, usr, ast, timeBudgetMs, imgParts) {   // 패치 12: imgParts(선택)
  const startedAt = Date.now();

  for (let attempt = 0; attempt < QCONFIG.MAX_RETRIES; attempt++) {
    try {
      return callGeminiForQualityOnce_(sys, usr, ast, imgParts);
    } catch (e) {
      const errorMsg = e.message || '';
      const isRetryable = is503Error_(errorMsg);
      const isLastAttempt = (attempt === QCONFIG.MAX_RETRIES - 1);

      if (!isRetryable) { Logger.log(`[Q-Gemini] 영구 에러: ${errorMsg.slice(0, 150)}`); throw e; }
      if (isLastAttempt) { Logger.log(`[Q-Gemini] 재시도 소진: ${errorMsg.slice(0, 150)}`); throw e; }

      const baseDelay = QCONFIG.RETRY_DELAY_MS * Math.pow(2, attempt);
      const jitter    = Math.floor(Math.random() * 2000);
      const sleepMs   = Math.min(baseDelay + jitter, 60000);

      const elapsed = Date.now() - startedAt;
      if (timeBudgetMs && (elapsed + sleepMs + QCONFIG.API_CALL_RESERVE_MS) > timeBudgetMs) {
        throw new Error(`시간 예산 초과로 재시도 포기: ${errorMsg}`);
      }
      Logger.log(`[Q-Gemini] 재시도 ${attempt + 1}/${QCONFIG.MAX_RETRIES}: ${sleepMs}ms 대기`);
      Utilities.sleep(sleepMs);
    }
  }
}

function callGeminiForQualityOnce_(sys, usr, ast, imgParts) {   // 패치 12: imgParts(선택)
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');

  const userParts = [{ text: usr }].concat(Array.isArray(imgParts) ? imgParts : []);
  const contents = [{ role: 'user', parts: userParts }];
  if (ast && ast.trim() !== '') contents.push({ role: 'model', parts: [{ text: ast }] });

  const payload = {
    system_instruction: { parts: [{ text: sys }] },
    contents: contents,
    generationConfig: {
      response_mime_type: 'application/json',
      // Gemini 3.x REST: camelCase + 대문자 enum (이월 학습)
      thinkingConfig: { thinkingLevel: QCONFIG.GEMINI_THINKING_LEVEL },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${QCONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code !== 200) throw iv_geminiHttpError_(code, resp.getContentText());   // 패치 14: quotaId 포함

  const json    = JSON.parse(resp.getContentText());
  const content = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!content) throw new Error('Gemini 응답에서 content를 찾을 수 없습니다.');

  Logger.log('[Q-Gemini Raw] ' + content.substring(0, 500));
  return safeParseGeminiJson_(content);
}


/* ═══════════════════════════════════════════════
   4. Claude API 호출 (신규)
   ═══════════════════════════════════════════════ */

/**
 * Claude 호출 + 지수 백오프/지터 재시도.
 * 재시도 대상: 529(overloaded), 429, 500, 502, 503, 504
 * 즉시 중단: credit/billing 계열, 인증/요청 형식 오류(400/401/403/404)
 */
/** (패치 12 확장) Gemini inline_data 파트 → Claude image 블록 변환 */
function q_claudeImageBlocks_(gemParts) {
  if (!Array.isArray(gemParts)) return [];
  return gemParts
    .filter(function (p) { return p && p.inline_data && p.inline_data.data; })
    .map(function (p) {
      return { type: 'image',
               source: { type: 'base64',
                         media_type: p.inline_data.mime_type || 'image/jpeg',
                         data: p.inline_data.data } };
    });
}

function callClaudeWithRetry_(sys, usr, timeBudgetMs, imgBlocks) {   // 패치 12: imgBlocks(선택)
  const startedAt = Date.now();

  for (let attempt = 0; attempt < QCONFIG.MAX_RETRIES; attempt++) {
    try {
      return callClaudeUnified_(sys, usr, imgBlocks);
    } catch (e) {
      const errorMsg = e.message || '';
      const isRetryable = isClaudeRetryable_(errorMsg);
      const isLastAttempt = (attempt === QCONFIG.MAX_RETRIES - 1);

      if (!isRetryable) { Logger.log(`[Claude] 영구 에러: ${errorMsg.slice(0, 200)}`); throw e; }
      if (isLastAttempt) { Logger.log(`[Claude] 재시도 소진: ${errorMsg.slice(0, 200)}`); throw e; }

      const baseDelay = QCONFIG.RETRY_DELAY_MS * Math.pow(2, attempt);
      const jitter    = Math.floor(Math.random() * 2000);
      const sleepMs   = Math.min(baseDelay + jitter, 60000);

      const elapsed = Date.now() - startedAt;
      if (timeBudgetMs && (elapsed + sleepMs + QCONFIG.API_CALL_RESERVE_MS) > timeBudgetMs) {
        throw new Error(`시간 예산 초과로 재시도 포기: ${errorMsg}`);
      }
      Logger.log(`[Claude] 재시도 ${attempt + 1}/${QCONFIG.MAX_RETRIES}: ${sleepMs}ms 대기`);
      Utilities.sleep(sleepMs);
    }
  }
}

/**
 * Claude 재시도 가능 여부 판별
 * 529 overloaded → 재시도. credit/billing 계열 → 즉시 중단.
 */
function isClaudeRetryable_(errorMsg) {
  const msg = String(errorMsg);

  // 크레딧/결제 계열 → 재시도 무의미. 패치 14: 치명적 오류로 기록 → 호출자가 작업을 멈춤
  if (iv_markFatal_(msg)) return false;

  const retryableCodes = ['529', '429', '500', '502', '503', '504'];
  for (const code of retryableCodes) {
    if (msg.includes(`(${code})`)) return true;
  }
  if (/overloaded/i.test(msg)) return true;
  if (msg.includes('응답에서 text를 찾을 수 없습니다')) return true;  // 간헐적 빈 응답
  return false;
}

/**
 * Anthropic Messages API 단일 호출
 * - adaptive thinking + effort=high (Opus 4.8은 수동 budget_tokens 미지원)
 * - temperature 등 샘플링 파라미터 설정 금지(400 반환)
 * - 응답 content에서 type:"text" 블록만 취합 (thinking 블록 무시)
 */
function callClaudeUnified_(sys, usr, imgBlocks) {   // 패치 12: imgBlocks(선택)
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY가 설정되지 않았습니다.');

  const content = (Array.isArray(imgBlocks) && imgBlocks.length > 0)
    ? [{ type: 'text', text: usr }].concat(imgBlocks)
    : usr;

  const payload = {
    model: QCONFIG.CLAUDE_MODEL,
    max_tokens: QCONFIG.CLAUDE_MAX_TOKENS,
    system: sys,
    thinking: { type: 'adaptive' },
    output_config: { effort: QCONFIG.CLAUDE_EFFORT },
    messages: [{ role: 'user', content: content }],
  };

  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': QCONFIG.ANTHROPIC_VERSION,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code !== 200) throw new Error(`Claude API (${code}): ${resp.getContentText().slice(0, 300)}`);

  const json = JSON.parse(resp.getContentText());

  // text 블록 취합
  let text = '';
  const blocks = json.content || [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] && blocks[i].type === 'text') text += blocks[i].text || '';
  }
  if (!text.trim()) throw new Error('Claude 응답에서 text를 찾을 수 없습니다.');

  // 파일럿 비용 파악용 usage 로깅 (시트 기록 없음)
  const usage = json.usage || {};
  Logger.log(`[Claude usage] input=${usage.input_tokens || 0}, output=${usage.output_tokens || 0}`);
  Logger.log('[Claude Raw] ' + text.substring(0, 500));

  // Claude엔 JSON 강제 옵션이 없어 코드펜스가 붙을 수 있음 → 기존 파서 공유
  return safeParseGeminiJson_(text);
}


/* ═══════════════════════════════════════════════
   5. 단일 행 테스트 (파일럿 전 파이프라인 점검)
   ═══════════════════════════════════════════════ */

/** 메뉴 호출: 활성 셀이 있는 행 1개로 STEP3 전체 파이프라인을 검증 */
function testSingleQualityRow() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QCONFIG.DATA_SHEET);
  if (!sheet) { ui.alert('Data_DS 시트를 찾을 수 없습니다.'); return; }

  const activeSheet = ss.getActiveSheet();
  if (activeSheet.getName() !== QCONFIG.DATA_SHEET) {
    ui.alert('Data_DS 시트에서 테스트할 행의 셀을 선택한 뒤 실행하세요.');
    return;
  }
  const rowNum = activeSheet.getActiveCell().getRow();
  if (rowNum < 2) { ui.alert('2행 이하의 데이터 행을 선택하세요.'); return; }

  const qPrompts = loadQualityPrompts_();
  if (!qPrompts) {
    ui.alert('프롬프트 로드 실패. pmt 시트의 quality 세트(key/role/enabled)를 확인하세요.');
    return;
  }
  // v5: 군더더기 세트는 없으면 STEP4 만 건너뛴다 (STEP3 테스트는 종전대로)
  const gPrompts = loadGarbagePrompts_();

  const confirm = ui.alert(
    '논리·군더더기 단일 행 테스트',
    `행 ${rowNum}에 대해 STEP3(논리 검증 → U~X열)` +
    (gPrompts ? ` 와 STEP4(군더더기 검출 → Z~AB열)` : ``) + `를 차례로 실행합니다.\n` +
    (gPrompts ? `` : `⚠ pmt 에 garbage 프롬프트 세트가 없어 STEP4 는 건너뜁니다.\n`) +
    `해당 열이 덮어쓰기 됩니다. 진행할까요?`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  ss.toast(`행 ${rowNum} 논리 검증 중... (최대 수 분 소요)`);
  const t1 = Date.now();
  const status = verifyQualityForRow_(sheet, rowNum, qPrompts, QCONFIG.MAX_EXEC_MS);
  const ms1 = Date.now() - t1;
  SpreadsheetApp.flush();
  Logger.log(`[test] STEP3 row ${rowNum}: ${status} (${ms1}ms)`);

  let gLine = 'STEP4: 건너뜀(프롬프트 없음)';
  if (gPrompts) {
    g_ensureHeaders_(sheet);
    ss.toast(`행 ${rowNum} 군더더기 검출 중... (최대 수 분 소요)`);
    const t2 = Date.now();
    const gStatus = verifyGarbageForRow_(sheet, rowNum, gPrompts, QCONFIG.MAX_EXEC_MS);
    const ms2 = Date.now() - t2;
    SpreadsheetApp.flush();
    Logger.log(`[test] STEP4 row ${rowNum}: ${gStatus} (${ms2}ms)`);
    gLine = `STEP4(군더더기, Z~AB): ${gStatus}  [${Math.round(ms2 / 1000)}s]`;
  }

  ui.alert(
    '테스트 완료',
    `행 ${rowNum}\n` +
    `STEP3(논리, U~X): ${status}  [${Math.round(ms1 / 1000)}s]\n` +
    `${gLine}\n\n실행 로그(Logger)에서 원문 응답을 확인하세요.`,
    ui.ButtonSet.OK
  );
}


/* ═══════════════════════════════════════════════
   6. 사이드바 실행기 (QualityRunner) — v2 신설 · v5 모드 통합
   ═══════════════════════════════════════════════
   구조: 사이드바 JS가 (행, 검증) 1건당 서버 호출 1건(qr_processRow)을 연쇄 실행.
   각 호출은 독립적인 실행 예산을 가지므로 6분 한도에 걸리지 않고,
   사용자 상호작용 실행이라 트리거 일일 한도(90분)도 소모하지 않는다.
   행 간 쿨다운은 서버측 sleep으로 처리(백그라운드 탭 타이머 스로틀 회피).

   v5: 모드 quality(논리 검증만) / garbage(군더더기만) / both(둘 다, 기본).
   ⚠ both 는 행마다 호출 2건(quality → garbage) — 한 호출에 합치지 않는다(예산 270초).
   ⚠ 대상 선별은 U(STEP3)·Z(STEP4)를 각각 본다 — 이미 STEP3가 끝난 행에 군더더기만 소급할 수 있다. */

/** 실행기 스텝별 설정 — 검증 함수·프롬프트 로더·verdict 열을 한 곳에서 고른다 */
function qr_stepOf_(step) {
  if (step === 'garbage') {
    return { step: 'garbage', label: '군더더기', col: QCONFIG.G.COL.G_VERDICT,
             loadPrompts: loadGarbagePrompts_, verifyRow: verifyGarbageForRow_,
             promptHint: 'garbage 세트(gemini_garbage_verify / claude_garbage_judge)' };
  }
  return { step: 'quality', label: '논리', col: QCONFIG.COL.Q_VERDICT,
           loadPrompts: loadQualityPrompts_, verifyRow: verifyQualityForRow_,
           promptHint: 'quality 세트(gemini_quality_verify / claude_quality_judge)' };
}

/** 모드 → 스텝 목록 (순서 = 실행 순서) */
function qr_stepsOfMode_(mode) {
  if (mode === 'quality') return ['quality'];
  if (mode === 'garbage') return ['garbage'];
  return ['quality', 'garbage'];   // 'both' · 미지정
}

/** 메뉴 호출: 논리·군더더기 검증 실행기 사이드바 열기 (모드는 사이드바에서 고른다) */
function openQualityRunner() {
  const html = HtmlService.createHtmlOutputFromFile('QualityRunner')
    .setTitle('논리·군더더기 검증 실행기 (STEP 3·4)')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * 실행 시작: 사전 점검 + 대상 선별.
 * @param {string} rangeText  예: "2-101"
 * @param {string} [mode]     'quality' | 'garbage' | 'both' (기본 'both'; 구 호출은 인자 없음 → both)
 * @return {Object} { ok:false, message } 또는
 *                  { ok:true, mode, targets:[{row, steps:string[]}], skippedDone:number,
 *                    geminiModel:string, claudeModel:string }
 *   ⚠ targets 는 행마다 "아직 필요한 검증"만 담는다 — U/Z 를 각각 본 결과다.
 */
function qr_start(rangeText, mode) {
  const props = PropertiesService.getScriptProperties();
  mode = (mode === 'quality' || mode === 'garbage') ? mode : 'both';
  const steps = qr_stepsOfMode_(mode);

  // 동시 실행 가드: STEP1·2 트리거 체인 진행 중이면 거부
  if (props.getProperty('V_RUNNING') === 'true') {
    return { ok: false, message: '문항 검증(STEP 1·2)이 실행 중입니다. 완료 또는 중단 후 시작하세요.' };
  }
  if (props.getProperty(QCONFIG.PROP.RUNNING) === 'true') {
    // 이전 실행이 비정상 종료된 잔재일 수 있음 → 안내 후 초기화하고 진행
    Logger.log('[Runner] Q_RUNNING 잔재 감지 — 초기화 후 진행');
  }

  if (!props.getProperty('GEMINI_API_KEY')) return { ok: false, message: 'GEMINI_API_KEY가 설정되지 않았습니다.' };
  if (!props.getProperty('CLAUDE_API_KEY')) return { ok: false, message: 'CLAUDE_API_KEY가 설정되지 않았습니다.' };

  // 모드에 필요한 프롬프트 세트만 점검
  for (let s = 0; s < steps.length; s++) {
    const st = qr_stepOf_(steps[s]);
    if (!st.loadPrompts()) {
      return { ok: false, message: '프롬프트 로드 실패. pmt 시트의 ' + st.promptHint + ' key/role/enabled 를 확인하세요.' };
    }
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(QCONFIG.DATA_SHEET);
  if (!sheet) return { ok: false, message: 'Data_DS 시트를 찾을 수 없습니다.' };
  if (steps.indexOf('garbage') !== -1) g_ensureHeaders_(sheet);

  const range = parseRowRange(rangeText);
  if (!range || range.startRow < 2) return { ok: false, message: '유효하지 않은 범위입니다. (예: 2-101)' };

  // 대상 선별: 스텝마다 그 verdict 열이 비었거나 error/timeout 인 행만 (완료 행 건너뛰기 — U/Z 각각)
  const numRows = range.endRow - range.startRow + 1;
  const colVals = {};
  steps.forEach(function (stepName) {
    const st = qr_stepOf_(stepName);
    colVals[stepName] = sheet.getRange(range.startRow, st.col, numRows, 1).getValues();
  });
  const targets = [];
  let skippedDone = 0;
  for (let i = 0; i < numRows; i++) {
    const need = [];
    steps.forEach(function (stepName) {
      const v = String(colVals[stepName][i][0] || '').toLowerCase().trim();
      if (v === '' || v === 'error' || v === 'timeout') need.push(stepName);
    });
    if (need.length) targets.push({ row: range.startRow + i, steps: need });
    else skippedDone++;
  }

  iv_clearFatal_();   // 패치 14: 새 작업 시작
  props.setProperties({
    [QCONFIG.PROP.STOP]:      'false',
    [QCONFIG.PROP.RUNNING]:   'true',
    [QCONFIG.PROP.HEARTBEAT]: String(Date.now()),
  });

  return {
    ok: true,
    mode: mode,
    targets: targets,
    skippedDone: skippedDone,
    geminiModel: QCONFIG.GEMINI_MODEL,
    claudeModel: QCONFIG.CLAUDE_MODEL,
  };
}

/**
 * (행, 검증) 1건 처리 (서버 호출 1건 = 독립 실행 예산).
 * @param {number} row
 * @param {string|boolean} step  'quality' | 'garbage'.  ⚠ 구 시그니처 호환: boolean 이 오면 isFirst 로 읽고 step='quality'
 * @param {boolean} isFirst  첫 작업이면 쿨다운 생략
 * @return {Object} { row, step, status } — status: (quality) ok/fail/check/skip/error · (garbage) clean/garbage/check/skip/error · stopped
 */
function qr_processRow(row, step, isFirst) {
  if (typeof step === 'boolean') { isFirst = step; step = 'quality'; }   // v2 클라이언트 호환
  const st = qr_stepOf_(step);
  const props = PropertiesService.getScriptProperties();

  // 중단 확인 (사이드바 STOP 버튼 / 메뉴 '⛔ 논리·군더더기 검증 중단' / forceStopAll 모두 감지)
  if (props.getProperty(QCONFIG.PROP.STOP) === 'true') {
    return { row: row, step: st.step, status: 'stopped' };
  }

  // 패치 14: 앞선 작업에서 치명적 API 오류가 났으면 호출하지 않고 멈춤
  const fatalBefore = iv_getFatal_();
  if (fatalBefore) {
    return { row: row, step: st.step, status: 'stopped', message: fatalBefore };
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(QCONFIG.DATA_SHEET);
  if (!sheet) return { row: row, step: st.step, status: 'error', message: 'Data_DS 시트를 찾을 수 없습니다.' };

  const prompts = st.loadPrompts();
  if (!prompts) return { row: row, step: st.step, status: 'error', message: '프롬프트 로드 실패(' + st.promptHint + ')' };

  // 작업 간 쿨다운: 서버측 sleep (백그라운드 탭 setTimeout 스로틀 회피)
  if (!isFirst) Utilities.sleep(QCONFIG.INTER_ROW_COOLDOWN_MS);

  props.setProperty(QCONFIG.PROP.HEARTBEAT, String(Date.now()));

  const status = st.verifyRow(sheet, row, prompts, QCONFIG.RUNNER_ROW_BUDGET_MS);
  SpreadsheetApp.flush();

  // 패치 14: 이 작업에서 치명적 오류 → 사유를 로그에 남기고, 다음 호출이 'stopped' 로 멈춘다
  const fatalNow = iv_getFatal_();
  if (fatalNow) {
    return { row: row, step: st.step, status: status, message: '⛔ ' + fatalNow + ' — 다음 작업부터 중단' };
  }

  return { row: row, step: st.step, status: status };
}

/** 실행 종료 처리 (완료·중단 공통) */
function qr_finish() {
  PropertiesService.getScriptProperties().setProperty(QCONFIG.PROP.RUNNING, 'false');
  return true;
}

/** 사이드바 STOP 버튼: Q_STOP 설정 (현재 작업 완료 후 정지) */
function qr_requestStop() {
  PropertiesService.getScriptProperties().setProperty(QCONFIG.PROP.STOP, 'true');
  return true;
}