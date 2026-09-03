/*************************************************
 * normalizeProblem.gs — Data_DS 문항 정규화 (2026-08-30 보완판)
 *
 * 입력  A key(파일명 공통부, 예: 2606평가원_1공통07) / B 원본 문제(Latex) / C 해설
 * 출력  E stem / F~J 선지("① …" 형식) / K answer_type
 *       K = mcq_math | mcq_combo | short_int | NEED_REVIEW:… | RAW_EMPTY | EXCEPTION: …
 *
 * 판정 순서
 *  1) 문항번호로 객관식/주관식 선판정  (ds_expectedType_)
 *     - A열 key 의 번호와 B열 첫머리 인쇄 번호를 비교, 다르면 인쇄 번호 우선 + NUM_MISMATCH 경고
 *     - 공통 1~15 / 선택 23~28 → 객관식,  16~22 / 29~30 → 단답형  (DSN.QTYPE_RULES)
 *     - key 가 규칙에 안 맞으면 선판정 없이 현행 방식(파싱 결과만)으로 판정
 *  2) 객관식이면 선지 토크나이저(parseMcqFromRaw_)로 5개 선지 추출
 *     - 마커 (1)~(5), （1）~（5）, ①~⑤, \textcircled{n} 을 모두 인정, 한 문항 안 혼용 허용
 *     - 줄 단위가 아니라 텍스트 전체에서 마커를 찾고, {1..5} 를 정확히 한 번씩 담는 연속 5개 창을 선지 블록으로 채택
 *       (순서 뒤바뀜 (1)(4)(2)(5)(3) 허용, 발문 속 (1)(2) 참조·선지 뒤 메모/그림 라벨/다음 문항 유출은 자동 배제)
 *     - 선지 뒤에 남는 텍스트(메모, \end{itemize}, 그림 라벨 …)는 E/F~J 에서 제외(B 에는 남음) + TRAILER_DROPPED 경고
 *  3) 객관식인데 선지를 못 찾으면 K = NEED_REVIEW:MCQ_<사유>, E 에는 원문 보존 (조용한 short_int 금지)
 *     단답형 번호면 선지 파싱을 생략하고 short_int (DSN.SKIP_PARSE_FOR_SHORT)
 *  4) mcq_math / mcq_combo 구별은 기존 기준(선지에 ㄱ/ㄴ/ㄷ 포함 여부) 그대로
 *
 * 부수 효과(제자리 덮어쓰기)
 *  - B열: itemize 래퍼 제거(DSN.UNWRAP_ITEMIZE) + mcq 확정 행의 선지 마커 5곳만 ①~⑤ 로 통일 (DSN.REWRITE_RAW_MARKERS)
 *  - C열: 첫머리 "정답 (n)" → "정답 ⓝ" (기존) + itemize 래퍼 제거
 *
 * 진입점
 *  - 메뉴 '⏺️ 문항 정규화'      : ds_runNormalizeAndValidate_byRowInput  (행 범위 입력)
 *  - 메뉴 '🔎 정규화 점검(쓰기 없음)' : ds_auditNormalize_byRowInput  (재정규화 대상만 골라 보고)
 *  - 파이프라인 normalize 단계 : Pipeline.gs 의 pl_normalizeRows_ → ds_normalizeRow_
 *  공통 코어 ds_normalizeRow_(sh,row) 하나만 시트를 읽고 쓴다. 판정 자체는 순수 함수 ds_classify_ (Node 테스트 가능).
 *
 * (ㄱ)(ㄴ)(ㄷ)→(1)(2)(3) 참조 변환은 "(n)=원문자" 전제와 충돌하므로 GAS 에서는 하지 않는다 (2026-08-30 결정).
 *************************************************/

const DSN = {
  SHEET: 'Data_DS',
  COL: { key: 1, raw: 2, solution: 3 },                 // A, B, C
  OUT: { stem: 5, c1: 6, c2: 7, c3: 8, c4: 9, c5: 10, type: 11 }, // E, F~J, K
  OVERWRITE_NORMALIZE: true,

  SKIP_PARSE_FOR_SHORT: true,      // 번호가 단답형이면 선지 파싱 생략
  MCQ_FAIL_POLICY: 'review',       // 'review' → K=NEED_REVIEW:MCQ_… | 'short' → 예전처럼 short_int
  REWRITE_RAW_MARKERS: 'chain',    // 'chain' 선지 마커 5곳만 ①~⑤ 로 치환 | 'none' B열 보존
  UNWRAP_ITEMIZE: true             // B·C·E·F~J 의 \begin{itemize}\item[X] … \end{itemize} 래퍼를 모두 벗기고 알맹이만 남김
};

const CIRCLED_NUMS = ['①', '②', '③', '④', '⑤'];      // idx 0~4 → 선지 1~5
const CIRCLED_TO_INT = { '①': 1, '②': 2, '③': 3, '④': 4, '⑤': 5 };

/* =================================================
 * 1. 순수 판정 함수 (시트 접근 없음)
 * ================================================= */
// 문항번호 → 유형 (현행 2022학년도~ 수능 체제, 과목 무관: 공통 1~15 객관식 / 16~22 단답형, 선택 23~28 객관식 / 29~30 단답형)
DSN.QTYPE_RULES = [
  { from: 1,  to: 15, type: 'mcq'   },
  { from: 16, to: 22, type: 'short' },
  { from: 23, to: 28, type: 'mcq'   },
  { from: 29, to: 30, type: 'short' }
];
// A열 key 에서 과목코드+번호: "…_1공통07" / "…_4미적28"  (CroP 명명 규칙. 이 코드가 있어야 신체제 시험지로 간주)
const KEY_RE = /[1345](공통|확통|미적|기하)(\d{2})\s*$/;
// 본문 첫머리 인쇄 문항번호: "12." / "12)" / "\begin{itemize}\item[12.]"
const PRINTED_NUM_RE = /^\s*(?:\\begin\{itemize\}\s*\\item\[\s*(\d{1,2})\s*\.?\s*\]|(\d{1,2})\s*[.)])/;

function qtypeFromNum_(num) {
  const r = DSN.QTYPE_RULES.find(r => num >= r.from && num <= r.to);
  return r ? r.type : null;
}

/**
 * 문항번호 기반 선판정.  A열 key 의 번호와 B열 본문 첫머리의 인쇄 번호를 모두 본다.
 *  - 둘이 다르면 인쇄 번호를 우선한다(파일명 번호가 한 칸씩 밀린 세트가 실제로 있음) 하고 NUM_MISMATCH 경고.
 *  - key 가 규칙(과목코드+2자리)에 안 맞으면 expected:null → 현행 동작(파싱 결과만으로 판정)으로 폴백.
 * @returns {{subject, keyNum, printedNum, num, expected:'mcq'|'short'|null, warn:string[]}}
 */
function ds_expectedType_(key, raw) {
  const warn = [];
  const m = String(key ?? '').match(KEY_RE);
  if (!m) return { subject: null, keyNum: null, printedNum: null, num: null, expected: null, warn: ['KEY_NO_MATCH'] };
  const subject = m[1], keyNum = Number(m[2]);
  const pm = String(raw ?? '').match(PRINTED_NUM_RE);
  const printedNum = pm ? Number(pm[1] || pm[2]) : null;
  let num = keyNum;
  if (printedNum != null && printedNum !== keyNum && qtypeFromNum_(printedNum)) {
    num = printedNum; warn.push('NUM_MISMATCH(key ' + keyNum + ' / printed ' + printedNum + ')');
  }
  const expected = qtypeFromNum_(num);
  if (!expected) warn.push('NUM_OUT_OF_RANGE');
  return { subject, keyNum, printedNum, num, expected, warn };
}

/* ---- 선지 토크나이저 ---- */
// 마커: (행시작|공백|$) 뒤의  (n) / （n） / ①~⑤ / \textcircled{n} ; 뒤에 글자·숫자가 붙으면 제외 (f(1), (1)번)
const MARK_RE = /(^|[\s$])(?:[\(（]\s*([1-5])\s*[\)）]|([①②③④⑤])|\\textcircled\s*\{\s*([1-5])\s*\})\$?(?![\d\w가-힣])/gm;

function findChoiceMarkers_(text) {
  const out = []; let m; MARK_RE.lastIndex = 0;
  while ((m = MARK_RE.exec(text)) !== null) {
    const k = m[2] != null ? Number(m[2]) : m[3] != null ? CIRCLED_TO_INT[m[3]] : Number(m[4]);
    out.push({ k, start: m.index + m[1].length, end: m.index + m[0].length });
  }
  return out;
}

/**
 * 선지 내용 추출: 마커 뒤 같은 줄 텍스트. 같은 줄이 비어 있으면(마커 단독 줄) 다음 비어있지 않은 줄 하나.
 * 수식 블록(\[ … \] / $$ … $$)이 열려 있으면 닫힐 때까지 이어 붙인다. limit 이후는 보지 않는다.
 */
function sliceChoice_(src, from, limit) {
  const region = src.slice(from, limit);
  const lines = region.split('\n');
  let out = [], i = 0;
  // 같은 줄
  let first = lines[0].trim();
  if (first) { out.push(first); i = 1; }
  else { i = 1; while (i < lines.length && !lines[i].trim()) i++; if (i < lines.length) { out.push(lines[i].trim()); i++; } }
  // 열린 수식 블록 이어붙이기
  const joined = () => out.join('\n');
  const open = s => (s.match(/\\\[/g) || []).length > (s.match(/\\\]/g) || []).length || ((s.match(/\$\$/g) || []).length % 2 === 1);
  while (open(joined()) && i < lines.length) { out.push(lines[i].trim()); i++; }
  const usedLines = i;
  const rest = lines.slice(usedLines).filter(l => l.trim());
  return { content: joined().replace(/\\quad|\\qquad/g, ' ').trim(), leftover: rest };
}

function parseMcqFromRaw_(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const marks = findChoiceMarkers_(src);
  const present = new Set(marks.map(m => m.k));
  const missing = [1, 2, 3, 4, 5].filter(k => !present.has(k));
  if (missing.length) return { ok: false, reason: 'CHOICE_MISSING_' + missing.join(''), found: marks.map(x => x.k).join('') };

  // 각 마커의 내용(다음 마커 직전까지)을 미리 계산
  const items = marks.map((m, i) => {
    const limit = i + 1 < marks.length ? marks[i + 1].start : src.length;
    return Object.assign({}, m, sliceChoice_(src, m.end, limit));
  });
  // 후보 창: 문서 순으로 연속한 5개 마커가 {1..5} 를 정확히 한 번씩 담는 구간.
  //  - 순서는 강제하지 않는다 (Mathpix 가 2단 배치를 (1)(4)(2)(5)(3) 순으로 읽는 경우가 실제로 있음)
  //  - 발문 속 (1),(2) 참조·선지 뒤의 표/그림 숫자 (1)(2)… 는 완전한 창을 만들지 못하거나 내용이 비어 점수가 낮다.
  //  - 점수 = 내용이 비어있지 않은 선지 수. 동점이면 뒤쪽 창.
  let best = null;
  for (let i = 0; i + 5 <= items.length; i++) {
    const w = items.slice(i, i + 5);
    if (new Set(w.map(x => x.k)).size !== 5) continue;
    const score = w.filter(x => x.content).length;
    if (!best || score >= best.score) best = { w, score };
  }
  let strayInBlock = false;
  if (!best) {
    // 완전한 창이 없으면(마커가 중간에 끼어듦) 각 번호의 마지막 출현으로 폴백
    const lastOf = {}; items.forEach(x => { lastOf[x.k] = x; });
    best = { w: [1, 2, 3, 4, 5].map(k => lastOf[k]).sort((a, b) => a.start - b.start), score: 0 };
    strayInBlock = true;
  }
  const byPos = best.w;                                          // 문서 순
  const chain = byPos.slice().sort((a, b) => a.k - b.k);         // k 순 (기록·치환용)
  const blockStart = byPos[0].start;

  const stem = src.slice(0, blockStart).trim();
  const choices = ['', '', '', '', ''], warn = [];
  if (strayInBlock) warn.push('STRAY_MARKER_IN_BLOCK');
  if (byPos.some((c, i) => c.k !== i + 1)) warn.push('CHOICE_ORDER_' + byPos.map(c => c.k).join(''));
  let trailer = '';
  byPos.forEach((c, i) => {
    // 창 안 마지막 선지의 내용은 다음 마커가 아니라 문서 끝까지 기준으로 다시 잘라 trailer 를 얻는다
    const r = (i < 4) ? c : sliceChoice_(src, c.end, src.length);
    choices[c.k - 1] = r.content;
    if (r.leftover.length) {
      if (i < 4) warn.push(`CHOICE_${c.k}_EXTRA_LINES`);
      else trailer = r.leftover.join('\n');
    }
  });
  const empty = choices.map((c, i) => c ? null : i + 1).filter(Boolean);
  if (empty.length) return { ok: false, reason: 'CHOICE_EMPTY_' + empty.join(''), choices, chain };
  if (trailer) warn.push('TRAILER_DROPPED');
  return { ok: true, stem, choices, chain, trailer, warn };
}

/** B열 원문: chain 위치의 마커 5곳만 ①~⑤ 로 치환 (뒤에서부터 치환해 오프셋 보존) */
function rewriteRawMarkers_(src, chain) {
  let s = String(src ?? '').replace(/\r\n?/g, '\n');
  const desc = chain.slice().sort((a, b) => b.start - a.start);   // 뒤쪽부터 치환해야 앞쪽 오프셋이 유지됨
  for (const c of desc) {
    s = s.slice(0, c.start) + CIRCLED_NUMS[c.k - 1] + ' ' + s.slice(c.end).replace(/^[ \t]+/, '');
  }
  return s;
}

/* ---- 기존 유지 함수 ---- */
function detectAnswerTypeFromChoices_(choices) {
  return /[ㄱㄴㄷᄀᄂᄃ]/.test((choices || []).join(' ')) ? 'mcq_combo' : 'mcq_math';
}
function normalizeChoiceToLatex_(s) {
  const t = String(s ?? '').trim();
  if (!t) return '';
  if ((t.startsWith('$$') && t.endsWith('$$')) || (t.startsWith('$') && t.endsWith('$'))) return t;
  if (t.startsWith('\\[') || t.startsWith('\\includegraphics') || t.startsWith('![')) return t;  // 수식블록·그림은 감싸지 않음
  if (/[ㄱㄴㄷᄀᄂᄃ]/.test(t)) return t;
  return '$' + t + '$';
}
function normalizeComboChoice_(s) {
  const t0 = String(s ?? '').trim().replace(/ᄀ/g, 'ㄱ').replace(/ᄂ/g, 'ㄴ').replace(/ᄃ/g, 'ㄷ');
  const arr = []; if (t0.includes('ㄱ')) arr.push('ㄱ'); if (t0.includes('ㄴ')) arr.push('ㄴ'); if (t0.includes('ㄷ')) arr.push('ㄷ');
  return arr.join(', ');
}
function attachCircledMarker_(content, idx) {
  const marker = CIRCLED_NUMS[idx] || ''; const c = String(content ?? '').trim();
  return c ? (marker + ' ' + c) : marker;
}

/**
 * itemize/enumerate 래퍼 완전 제거 — 알맹이만 남긴다.
 *  Mathpix(v3/pdf mmd)가 행 첫머리의 번호·기호("7.", "-", "(i)", "이 …")를 보고 곳곳을
 *  \begin{itemize}\item[X] … \end{itemize} 로 감싸는데(중첩 포함), 수능 문항·해설에는 진짜 목록 구조가 필요 없다.
 *   - \begin{itemize} / \end{itemize} (enumerate, description 포함) → 삭제
 *   - \item[X] → "X " (X 가 비면 삭제),  \item (대괄호 없음) → "- "
 *   - 각 항목은 자기 줄에서 시작하도록 유지, 줄 끝 공백·3줄 이상 연속 빈 줄 정리
 *  DSN.UNWRAP_ITEMIZE=true 면 B(원문)·C(해설)·E·F~J 모두에 적용된다.
 */
function unwrapItemize_(s) {
  let t = String(s ?? '').replace(/\r\n?/g, '\n');
  if (!/\\(?:begin|end)\{(?:itemize|enumerate|description)\}|\\item\b/.test(t)) return t.trim();
  t = t
    .replace(/[ \t]*\\begin\{(?:itemize|enumerate|description)\}[ \t]*\n?/g, '')
    .replace(/\n?[ \t]*\\end\{(?:itemize|enumerate|description)\}[ \t]*/g, '')
    .replace(/(^|\n)[ \t]*\\item\[\s*\]\s*/g, '$1')                    // \item[]   → 제거
    .replace(/(^|\n)[ \t]*\\item\[\s*([^\]]*?)\s*\][ \t]*/g, '$1$2 ')  // \item[X]  → "X "
    .replace(/(^|\n)[ \t]*\\item\b[ \t]*/g, '$1- ')                    // \item     → "- "
    .replace(/\\item\[\s*\]\s*/g, '')                                  // 줄 중간에 남은 것
    .replace(/\\item\[\s*([^\]]*?)\s*\][ \t]*/g, '\n$1 ')
    .replace(/\\item\b[ \t]*/g, '\n- ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/** 순수 판정 코어: 시트 접근 없음. 반환값을 호출측이 기록한다. */
function ds_classify_(key, raw, cfg) {
  cfg = cfg || DSN;
  if (cfg.UNWRAP_ITEMIZE !== false) raw = unwrapItemize_(raw);   // itemize 래퍼는 판정 전에 벗긴다 (B열에도 반영됨)
  const exp = ds_expectedType_(key, raw);
  const warn = exp.warn.slice();
  const R = { expected: exp.expected, num: exp.num, warn, rawOut: raw };
  if (!String(raw ?? '').trim()) return Object.assign(R, { ok: false, type: 'RAW_EMPTY', stem: '', choices: ['', '', '', '', ''] });

  const skip = exp.expected === 'short' && cfg.SKIP_PARSE_FOR_SHORT !== false;
  const mcq = skip ? { ok: false, reason: 'SKIPPED_SHORT' } : parseMcqFromRaw_(raw);

  if (mcq.ok && exp.expected !== 'short') {
    const type = detectAnswerTypeFromChoices_(mcq.choices);
    const choices = mcq.choices.map((x, i) => attachCircledMarker_(type === 'mcq_math' ? normalizeChoiceToLatex_(x) : normalizeComboChoice_(x), i));
    warn.push(...(mcq.warn || []));
    const rawOut = (cfg.REWRITE_RAW_MARKERS === 'none') ? raw : rewriteRawMarkers_(raw, mcq.chain);
    return Object.assign(R, { ok: true, type, stem: mcq.stem, choices, rawOut, trailer: mcq.trailer });
  }
  if (mcq.ok && exp.expected === 'short') { warn.push('SHORT_BUT_CHOICES_FOUND'); }
  if (exp.expected === 'mcq') {
    if ((cfg.MCQ_FAIL_POLICY || 'review') === 'review')
      return Object.assign(R, { ok: false, type: 'NEED_REVIEW:MCQ_' + mcq.reason, stem: raw, choices: ['', '', '', '', ''] });
  }
  return Object.assign(R, { ok: true, type: 'short_int', stem: raw, choices: ['', '', '', '', ''] });
}

/* =================================================
 * 2. 기존 유지: 해설 정답마커, 행 입력 파서, 기록
 * ================================================= */

/**
 * C열(해설) 첫머리의 "정답 (n)"을 원문자로 통일한다. (기존 로직 그대로)
 *  - 첫머리가 문항번호(숫자 + . 또는 ))로 시작하고, 그 뒤 공백류만 지나 곧바로 "정답 (n)" 이 오는 경우만.
 */
function normalizeSolutionAnswerMarker_(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const qHead = src.match(/^(\s*\d+\s*[.)])/);
  if (!qHead) return text;
  const headLen = qHead[1].length;
  const before = src.slice(0, headLen);
  const after = src.slice(headLen);
  const ANS_RE = /^(\s*정답\s*[:：]?\s*)[\(（]([1-5])[\)）]/;
  const m = after.match(ANS_RE);
  if (!m) return text;
  return before + m[1] + CIRCLED_NUMS[Number(m[2]) - 1] + after.slice(m[0].length);
}

/** 행 입력 파서: "15, 17, 123, 10-15" */
function parseRowInput_(text) {
  const set = new Set();
  String(text ?? '').split(',').forEach(part => {
    const s = part.trim();
    if (!s) return;
    if (s.includes('-')) {
      const [a, b] = s.split('-').map(v => Number(String(v).trim()));
      if (Number.isInteger(a) && Number.isInteger(b)) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
    } else {
      const n = Number(s);
      if (Number.isInteger(n)) set.add(n);
    }
  });
  return Array.from(set).filter(n => n >= 2).sort((x, y) => x - y);
}

/** E~K 기록. r.ok=false 면 K 에 사유, E 는 r.stem(원문 보존용) 또는 빈칸, F~J 비움 */
function writeNormResult_(sh, row, r) {
  const stem = r.ok ? String(r.stem ?? '').trim() : String(r.stem ?? '');
  const choices = (r.ok && Array.isArray(r.choices)) ? r.choices : ['', '', '', '', ''];
  sh.getRange(row, DSN.OUT.stem, 1, 6).setValues([[
    stem, String(choices[0] ?? ''), String(choices[1] ?? ''), String(choices[2] ?? ''), String(choices[3] ?? ''), String(choices[4] ?? '')
  ]]);
  sh.getRange(row, DSN.OUT.type).setValue(String(r.ok ? (r.type || '') : (r.type || r.reason || 'FAIL')));
}

/* =================================================
 * 3. 공통 코어: 한 행 읽기 → 판정 → 쓰기   (메뉴·파이프라인 공용)
 * ================================================= */
/**
 * @param {Sheet} sh Data_DS
 * @param {number} row
 * @param {{dryRun?:boolean}} [opts] dryRun=true 면 시트에 쓰지 않고 판정 결과만 반환
 * @returns {{ok:boolean, type:string, expected:string|null, warn:string[], changedRaw:boolean}}
 */
function ds_normalizeRow_(sh, row, opts) {
  opts = opts || {};
  const write = !opts.dryRun;

  // C열 해설: 정답 마커 정규화 (문제 정규화와 독립, 실패 무시)
  if (write) {
    try {
      const solCell = sh.getRange(row, DSN.COL.solution);
      const solRaw = String(solCell.getDisplayValue() || '');
      if (solRaw) {
        let solNorm = normalizeSolutionAnswerMarker_(solRaw);
        if (DSN.UNWRAP_ITEMIZE !== false) solNorm = unwrapItemize_(solNorm);
        if (solNorm !== solRaw) solCell.setValue(solNorm);
      }
    } catch (_) {}
  }

  const key = String(sh.getRange(row, DSN.COL.key).getDisplayValue() || '').trim();
  const raw = String(sh.getRange(row, DSN.COL.raw).getDisplayValue() || '').trim();

  if (!DSN.OVERWRITE_NORMALIZE && write) {
    const existingStem = String(sh.getRange(row, DSN.OUT.stem).getDisplayValue() || '').trim();
    if (existingStem) return { ok: true, type: 'SKIPPED_EXISTING', expected: null, warn: [], changedRaw: false };
  }

  const r = ds_classify_(key, raw, DSN);
  const changedRaw = r.ok && r.rawOut != null && r.rawOut !== raw;
  if (write) {
    if (changedRaw) sh.getRange(row, DSN.COL.raw).setValue(r.rawOut);
    writeNormResult_(sh, row, r);
  }
  return { ok: r.ok, type: r.type, expected: r.expected, warn: r.warn || [], changedRaw };
}

/** 여러 행 처리 + 통계 (UI 없음). Pipeline 과 메뉴가 공용 */
function ds_normalizeRows_(sh, rows, opts) {
  const st = { ok: 0, fail: 0, failRows: [], review: [], warnRows: {}, warnCount: {} };
  for (const row of rows) {
    try {
      const r = ds_normalizeRow_(sh, row, opts);
      if (r.type === 'SKIPPED_EXISTING') continue;
      if (r.ok) st.ok++; else { st.fail++; st.failRows.push(row); }
      if (/^NEED_REVIEW/.test(r.type)) st.review.push(row + ':' + r.type.replace('NEED_REVIEW:', ''));
      (r.warn || []).forEach(w => {
        const k = w.replace(/\(.*$/, '');
        st.warnCount[k] = (st.warnCount[k] || 0) + 1;
        (st.warnRows[k] = st.warnRows[k] || []).push(row + (w.includes('(') ? w.slice(w.indexOf('(')) : ''));
      });
    } catch (e) {
      try { writeNormResult_(sh, row, { ok: false, type: 'EXCEPTION: ' + (e && e.message || String(e)) }); } catch (_) {}
      st.fail++; st.failRows.push(row);
    }
  }
  return st;
}

function ds_statSummary_(st) {
  const lines = [`성공 ${st.ok}, 실패 ${st.fail}` + (st.failRows.length ? ` (행 ${st.failRows.join(', ')})` : '')];
  if (st.review.length) lines.push(`검토 필요(NEED_REVIEW) ${st.review.length}건: ${st.review.join(', ')}`);
  Object.keys(st.warnCount).forEach(k => {
    const rows = st.warnRows[k] || [];
    lines.push(`${k} ${st.warnCount[k]}건` + (rows.length && rows.length <= 40 ? `: ${rows.join(', ')}` : ''));
  });
  return lines.join('\n');
}

/* =================================================
 * 4. 메뉴 진입점
 * ================================================= */

/** 메뉴 '⏺️ 문항 정규화': 행번호 입력(예: 15, 17, 123, 10-15) */
function ds_runNormalizeAndValidate_byRowInput() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('정규화+검증(문제) 행 번호 입력', '예: 15, 17, 123, 10-15', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const rows = parseRowInput_(res.getResponseText());
  if (!rows.length) return;

  const sh = SpreadsheetApp.getActive().getSheetByName(DSN.SHEET);
  if (!sh) throw new Error(`시트 없음: ${DSN.SHEET}`);

  const st = ds_normalizeRows_(sh, rows);
  const msg = ds_statSummary_(st);
  SpreadsheetApp.getActive().toast(`정규화 완료: 성공 ${st.ok}, 실패 ${st.fail}` + (st.review.length ? `, 검토 ${st.review.length}` : ''), 'Data_DS', 5);
  if (st.review.length || Object.keys(st.warnCount).length) ui.alert('정규화 결과', msg, ui.ButtonSet.OK);
}

/**
 * 메뉴 '🔎 정규화 점검(쓰기 없음)': 입력 범위(비우면 전체)를 새 판정으로 돌려 보고
 *  현재 K 와 달라지는 행만 목록으로 보여준다. 시트는 건드리지 않는다.
 *  → 기존 행 재정규화 대상 선정용 (D-7)
 */
function ds_auditNormalize_byRowInput() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('정규화 점검 (쓰기 없음)', '행 범위 (예: 2-3000). 비우면 전체', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(DSN.SHEET);
  if (!sh) throw new Error(`시트 없음: ${DSN.SHEET}`);

  let rows = parseRowInput_(res.getResponseText());
  const last = sh.getLastRow();
  if (!rows.length) { rows = []; for (let r = 2; r <= last; r++) rows.push(r); }
  if (!rows.length) { ui.alert('데이터 없음'); return; }

  const minR = Math.min(...rows), maxR = Math.max(...rows);
  const block = sh.getRange(minR, 1, maxR - minR + 1, DSN.OUT.type).getValues();
  const rowSet = new Set(rows);
  const changes = [], review = [], mismatch = [];
  for (let r = minR; r <= maxR; r++) {
    if (!rowSet.has(r)) continue;
    const v = block[r - minR];
    const key = String(v[DSN.COL.key - 1] || '').trim(), raw = String(v[DSN.COL.raw - 1] || '').trim();
    if (!key && !raw) continue;
    const curK = String(v[DSN.OUT.type - 1] || '').trim();
    const c = ds_classify_(key, raw, DSN);
    if (c.type !== curK) changes.push(`${r}: ${curK || '(빈칸)'} → ${c.type}`);
    if (/^NEED_REVIEW/.test(c.type)) review.push(r);
    (c.warn || []).forEach(w => { if (w.startsWith('NUM_MISMATCH')) mismatch.push(r + ' ' + w); });
  }
  const lines = [
    `점검 ${rows.length}행 — K 가 달라지는 행 ${changes.length}건, 검토 필요 ${review.length}건, 번호 불일치 ${mismatch.length}건`,
    '', '[K 변경]', ...changes.slice(0, 60), changes.length > 60 ? `… 외 ${changes.length - 60}건` : '',
    '', '[번호 불일치 (key ≠ 인쇄 번호)]', ...mismatch.slice(0, 30), mismatch.length > 30 ? `… 외 ${mismatch.length - 30}건` : ''
  ].filter(s => s !== undefined);
  const text = lines.join('\n');
  Logger.log(text);
  ui.alert('정규화 점검 결과 (시트 변경 없음)', text.length > 3500 ? text.slice(0, 3500) + '\n…(전체는 실행 로그 참조)' : text, ui.ButtonSet.OK);
}