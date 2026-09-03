/**
 * ============================================================
 * LatexWrap.gs — LaTeX bare 수식 $ 감싸기 (원본 기록용)  v1
 * ============================================================
 * 목적:
 *   LLM이 반환한 서술형 보고(P solution_note / R error_report /
 *   V 논리검증 보고서 / W 논리검증 감사)에 $ 없이 노출된 LaTeX
 *   수식을 찾아 $…$로 감싸 "시트 원본"을 읽기 좋게 만든다.
 *
 * 원칙:
 *   - Sidebar.html의 wrapBareMathDelimiters(표시 전용)와 동일 규칙.
 *     뷰어 쪽 로직은 그대로 두며(멱등), 여기서는 기록 시점에 적용.
 *   - 판정/정답 "값" 열(N, O, Q, U 등)에는 절대 적용하지 않음.
 *   - 멱등성: 기존 $…$/$$…$$/\(…\)/\[…\] 구간 보호 → 반복 적용 안전.
 *
 * 사용처:
 *   1) 기록 시점 자동 적용:
 *      - Itemverification.gs: P(solution_note), R(error_report)
 *      - QualityVerification.gs writeQualityRow_: V(report), W(audit)
 *      - PipelineVerify.gs pv_retryRow_: P, R
 *   2) 소급 적용 메뉴: lw_wrapExistingMenu (Data_DS / Stack, 행 범위)
 * ============================================================
 */

const LW = {
  ALLOWED_SHEETS: ['Data_DS', 'Stack'],
  COLS: [16, 18, 22, 23],   // P, R, V, W  (판정·정답 값 열 제외)
};

/* ═══════════════════════════════════════════════
   코어 — Sidebar.html wrapBareMathDelimiters 서버판
   규칙:
    1) 기존 $…$/$$…$$/\(…\)/\[…\] 구간 보호(멱등성)
    2) 한글은 절대 수식 런에 포함하지 않음
    3) 수식 신호(연산자·^/_·\명령·함수호출) 있는 런만 감쌈
    4) 개행은 런에 미포함($…$ 안에 개행이 끼지 않도록)
   ═══════════════════════════════════════════════ */
function lw_wrapBareMath_(text) {
  if (text === null || text === undefined) return '';
  var s = String(text);
  if (s.indexOf('\uE000') !== -1) return s;   // PUA 문자가 이미 있으면 건드리지 않음

  var holders = [];
  s = s.replace(/(\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/g, function (m) {
    holders.push(m);
    return String.fromCharCode(0xE000 + (holders.length - 1));
  });

  var RUN_RE = new RegExp(
    '(?:' +
      '\\\\[a-zA-Z]+' +
      // 중괄호: 1단계 중첩까지 허용 (\frac{-b \pm \sqrt{b^2-4ac}}{2a} 대응 — 뷰어판보다 개선)
      '|\\{(?:[^{}\\uE000-\\uF8FF가-힣ㄱ-ㅎㅏ-ㅣ\\n]|\\{[^{}\\uE000-\\uF8FF가-힣ㄱ-ㅎㅏ-ㅣ\\n]*\\})*\\}' +
      '|[A-Za-z0-9.]' +
      '|[()\\[\\]]' +
      '|[\\^_]' +
      '|[=+\\-*/<>≤≥≠±·×÷′°]' +
      '|,[ \\t](?=[A-Za-z0-9\\\\(])' +
      '|[ \\t](?=[=+\\-*/<>≤≥≠±·×÷^_\\\\])' +
      '|(?<=[=+\\-*/<>≤≥≠±·×÷^_])[ \\t]' +
      '|(?<=\\\\[a-zA-Z]{1,24})[ \\t](?=[A-Za-z0-9({\\\\])' +
      '|(?<=\\})[ \\t](?=[A-Za-z0-9({\\\\=+\\-])' +
    ')+',
    'g'
  );
  var SIGNAL_RE = /\\[a-zA-Z]|[\^_]|[A-Za-z0-9)\]}]\s*[=+\-*\/<>≤≥≠±·×÷]\s*[A-Za-z0-9(\\{[]|[A-Za-z]\(|[≤≥≠±×÷′]/;

  s = s.replace(RUN_RE, function (run) {
    var lead = (run.match(/^[ \t]+/) || [''])[0];
    var tail = (run.match(/[ \t]+$/) || [''])[0];
    var core = run.slice(lead.length, run.length - tail.length);
    if (!core) return run;

    var punct = '';
    var pm = core.match(/[.,]+$/);
    if (pm) { punct = pm[0]; core = core.slice(0, core.length - punct.length); }
    if (!core) return run;

    if (/[\uE000-\uF8FF]/.test(core)) return run;
    if (!SIGNAL_RE.test(core)) return run;
    if (/^[A-Za-z]{2,}$/.test(core)) return run;   // 순수 영단어는 제외

    return lead + '$' + core + '$' + punct + tail;
  });

  s = s.replace(/[\uE000-\uF8FF]/g, function (ch) {
    var idx = ch.charCodeAt(0) - 0xE000;
    return holders[idx] !== undefined ? holders[idx] : ch;
  });
  return s;
}


/* ═══════════════════════════════════════════════
   범위 일괄 적용 (헤드리스 코어)
   ═══════════════════════════════════════════════ */

/**
 * 지정 시트의 startRow~endRow에서 LW.COLS 열만 감싸기 적용
 * @return {{checked:number, changed:number}}
 */
function lw_wrapRange_(sheet, startRow, endRow) {
  var checked = 0, changed = 0;
  if (endRow < startRow) return { checked: checked, changed: changed };
  var n = endRow - startRow + 1;

  for (var c = 0; c < LW.COLS.length; c++) {
    var col = LW.COLS[c];
    if (sheet.getMaxColumns() < col) continue;
    var rng = sheet.getRange(startRow, col, n, 1);
    var vals = rng.getValues();
    var dirty = false;
    for (var i = 0; i < n; i++) {
      var v = vals[i][0];
      if (v === '' || v === null || v === undefined) continue;
      checked++;
      var w = lw_wrapBareMath_(String(v));
      if (w !== String(v)) { vals[i][0] = w; dirty = true; changed++; }
    }
    if (dirty) rng.setValues(vals);
  }
  SpreadsheetApp.flush();
  return { checked: checked, changed: changed };
}


/* ═══════════════════════════════════════════════
   소급 적용 메뉴
   ═══════════════════════════════════════════════ */

/** 메뉴 호출: 기존 데이터에 $ 감싸기 소급 적용 (Data_DS / Stack) */
function lw_wrapExistingMenu() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var shRes = ui.prompt(
    '수식 $ 감싸기 — 소급 적용',
    '대상 시트 이름을 입력하세요 (' + LW.ALLOWED_SHEETS.join(' / ') + ')\n비우면 Data_DS',
    ui.ButtonSet.OK_CANCEL
  );
  if (shRes.getSelectedButton() !== ui.Button.OK) return;
  var name = String(shRes.getResponseText() || '').trim() || 'Data_DS';
  if (LW.ALLOWED_SHEETS.indexOf(name) === -1) {
    ui.alert('허용된 시트가 아닙니다: ' + name + '\n(' + LW.ALLOWED_SHEETS.join(' / ') + ')');
    return;
  }
  var sheet = ss.getSheetByName(name);
  if (!sheet) { ui.alert(name + ' 시트를 찾을 수 없습니다.'); return; }

  var last = sheet.getLastRow();
  if (last < 2) { ui.alert(name + ' 시트에 데이터가 없습니다.'); return; }

  var rgRes = ui.prompt(
    '행 범위',
    '적용할 행 범위를 입력하세요 (예: 2-100)\n비우면 2~' + last + ' 전체\n\n' +
    '· 대상 열: P(solution_note), R(error_report), V(논리검증 보고), W(논리검증 감사)\n' +
    '· 이미 $로 감싼 구간은 건드리지 않습니다 (반복 실행 안전)',
    ui.ButtonSet.OK_CANCEL
  );
  if (rgRes.getSelectedButton() !== ui.Button.OK) return;

  var startRow = 2, endRow = last;
  var txt = String(rgRes.getResponseText() || '').trim();
  if (txt) {
    var r = parseRowRange(txt);
    if (!r || r.startRow < 2) { ui.alert('유효하지 않은 범위입니다. (예: 2-100)'); return; }
    startRow = r.startRow;
    endRow = Math.min(r.endRow, last);
  }

  var res = lw_wrapRange_(sheet, startRow, endRow);
  ui.alert(
    '🧮 수식 $ 감싸기 완료',
    name + ' 시트 행 ' + startRow + '~' + endRow + '\n' +
    '검사한 셀(값 있는 셀): ' + res.checked + '개\n' +
    '수정된 셀: ' + res.changed + '개',
    ui.ButtonSet.OK
  );
  Logger.log('lw_wrapExistingMenu: ' + name + ' ' + startRow + '-' + endRow +
             ' checked=' + res.checked + ' changed=' + res.changed);
}


/* ═══════════════════════════════════════════════
   자가 테스트 (편집기에서 실행 → 로그 확인)
   ═══════════════════════════════════════════════ */
function lw_selfTest() {
  var cases = [
    ['f(x)=x^2+1 이므로 최솟값은 1', true],
    ['이미 $x^2$ 감싼 경우', false],
    ['\\frac{1}{2} 을 대입하면', true],
    ['한글만 있는 문장입니다', false],
    ['정답은 32', false],
  ];
  cases.forEach(function (c) {
    var out = lw_wrapBareMath_(c[0]);
    var changed = out !== c[0];
    var idem = lw_wrapBareMath_(out) === out;
    Logger.log((changed === c[1] ? 'PASS' : 'FAIL') + (idem ? '' : ' [멱등성 실패!]') +
               ' | in: ' + c[0] + ' | out: ' + out);
  });
}