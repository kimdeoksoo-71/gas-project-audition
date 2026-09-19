/*************************************************
 * MathpixTagNormalize.gs — Mathpix 식 번호(\tag) 정규화  (2026-09-19, mathory M9 H 이식)
 *
 * 배경
 *  - 해설 원문의 식 번호 `⋯⋯ ㉠`(행 끝 리더 + 원문자 자음)는 Mathpix 기본 요청에서 text 에서 **제외**된다
 *    (line_data 에 equation_number 줄로 잡히지만 included:false — mathory scripts/ocrProbe.mjs 실측).
 *  - 요청에 `include_equation_tags: true` 를 주면 그 번호가 수식 안 `\tag{ㄱ}` 로 실려 온다. 대신
 *    display 수식이 `\begin{equation*} … \end{equation*}` / `\begin{align*} … \end{align*}` 로 감싸져 오고
 *    (옵션이 idiomatic_eqn_arrays 를 함께 켠다 → 다행 수식이 array 대신 aligned 로 온다),
 *    가끔 리더 잔재가 태그 **안**에 섞여 온다: `\tag{$\cdots \cdots \cdot($ ㄱ}` (실측).
 *
 * 이 파일이 하는 일 (mathory lib/ocr.ts normalizeMathpixEquationTags + lib/proofread.ts normalizeTagLabels 와 동일 규칙)
 *  1) 태그 라벨 정규화  `\tag{ㄱ}` · `\tag{(ㄱ)}` · `\tag{㉠}` · `\tag{$\cdots … ($ ㄱ}` → `\tag{1}`  (㉠=ㄱ=1 … ㉭=ㅎ=14 고정 매핑)
 *     - 내용에서 `$`·리더(\cdots \ldots \dots \cdot ⋯ … · .)·괄호·\text{} 껍질·공백을 걷어낸 뒤
 *       남는 것이 자모 하나/원문자 하나면 번호로, 숫자면 잔재만 걷은 숫자로. 그 밖(`\tag{1.2}`·`\tag{A}`)은 무접촉.
 *     - 인자는 중괄호 균형 스캔(정규식으로 `{…}` 를 잡지 않는다). 멱등.
 *  2) `\begin{equation*} … \end{equation*}` 한 겹 벗기기 (별표 유무 모두)
 *  3) `\begin{align*}` → `\begin{aligned}` (별표 유무 모두)
 *     - 2)·3) 에서 환경이 수식 구분자(`\[ \]` / `$$ $$`) **밖**에 맨몸으로 있으면 `\[ … \]` 로 감싼다
 *       (이 프로젝트의 v3/text 요청은 display 구분자를 따로 주지 않아 기본값 `\[ \]` 로 온다 — `math_block_delimiters` 는
 *        Mathpix 문서에 없는 이름이라 무시된다).
 *
 * 호출처: MathPix API로 Latex 변환.gs (v3/text 결과)
 *  — 시트에 쓰기 **직전** 한 번. 결과가 mathory 정본(`\tag{n}`)과 같아지므로 mathory 쪽 정돈(규칙 ⑤)과 충돌하지 않는다.
 *
 * 점검: 스크립트 편집기에서 mpx_selfTest 실행 → 로그에 PASS/FAIL.
 *************************************************/

const MPX_TAG_JAMO    = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ';
const MPX_TAG_CIRCLED = '㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭';

/** s[open] === '{' 일 때 짝이 되는 '}' 의 인덱스. 없으면 -1. `\{`·`\}` 는 건너뛴다. */
function mpx_readGroup_(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 1) 태그 라벨 정규화. 반환 { fixed, count } */
function mpx_normalizeTagLabels_(text) {
  text = String(text || '');
  if (text.indexOf('\\tag') < 0) return { fixed: text, count: 0 };
  const re = /\\tag(\*?)\s*\{/g;
  const edits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = mpx_readGroup_(text, open);
    if (close === -1) continue;
    const content = text.slice(open + 1, close);
    re.lastIndex = close + 1;
    if (/\d\.\d/.test(content)) continue;                       // 1.2 같은 절 번호는 무접촉
    const core = content
      .replace(/\\text\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\(?:cdots|ldots|dots|cdot|qquad|quad|[,;: ])/g, ' ')
      .replace(/[$⋯…·.()（）[\]~\s]/g, '');
    let label = null;
    const j = MPX_TAG_JAMO.indexOf(core);
    const c = MPX_TAG_CIRCLED.indexOf(core);
    if (core.length === 1 && j !== -1) label = String(j + 1);
    else if (core.length === 1 && c !== -1) label = String(c + 1);
    else if (/^\d{1,3}$/.test(core)) label = core;
    if (label === null || label === content) continue;
    edits.push({ from: m.index, to: close + 1, insert: '\\tag' + m[1] + '{' + label + '}' });
  }
  let fixed = text;
  for (let k = edits.length - 1; k >= 0; k--) {
    fixed = fixed.slice(0, edits[k].from) + edits[k].insert + fixed.slice(edits[k].to);
  }
  return { fixed, count: edits.length };
}

/** 환경 앞뒤(공백 무시)에 display 구분자가 있는지 */
function mpx_insideDisplay_(text, from, to) {
  const before = text.slice(0, from).replace(/\s+$/, '');
  const after  = text.slice(to).replace(/^\s+/, '');
  const openOk  = /(\\\[|\$\$)$/.test(before);
  const closeOk = /^(\\\]|\$\$)/.test(after);
  return openOk && closeOk;
}

/** 2)·3) equation* 벗기기 · align* → aligned. 반환 { fixed, count } */
function mpx_unwrapEquationEnvs_(text) {
  text = String(text || '');
  let count = 0;
  // 2) equation / equation*
  const eqRe = /\\begin\{equation\*?\}[ \t]*\n?([\s\S]*?)\n?[ \t]*\\end\{equation\*?\}/g;
  let out = '';
  let last = 0, m;
  while ((m = eqRe.exec(text)) !== null) {
    const inner = m[1];
    const wrapped = mpx_insideDisplay_(text, m.index, m.index + m[0].length);
    out += text.slice(last, m.index) + (wrapped ? inner : '\\[\n' + inner + '\n\\]');
    last = m.index + m[0].length;
    count++;
  }
  text = out + text.slice(last);
  // 3) align / align* → aligned (수식 구분자 밖에 맨몸이면 \[ \] 로 감싼다)
  const alRe = /\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g;
  out = ''; last = 0;
  while ((m = alRe.exec(text)) !== null) {
    const body = '\\begin{aligned}' + m[1] + '\\end{aligned}';
    const wrapped = mpx_insideDisplay_(text, m.index, m.index + m[0].length);
    out += text.slice(last, m.index) + (wrapped ? body : '\\[\n' + body + '\n\\]');
    last = m.index + m[0].length;
    count++;
  }
  text = out + text.slice(last);
  return { fixed: text, count };
}

/** 진입점: Mathpix 결과(text / mmd) → 앱 정본. 문자열을 돌려준다. */
function mpx_normalizeEquationTags_(text) {
  const a = mpx_normalizeTagLabels_(text);
  const b = mpx_unwrapEquationEnvs_(a.fixed);
  return b.fixed;
}

/** 점검용 — 스크립트 편집기에서 실행. mathory tests/ocr.test.mjs 의 케이스를 그대로 옮겼다. */
function mpx_selfTest() {
  const N = mpx_normalizeEquationTags_;
  const cases = [
    // equation* 한 겹 벗기고 \tag{ㄱ} → \tag{1}  ($$ 구분자)
    ['$$\\begin{equation*}\n=\\frac{2}{(t+1)^{2}} \\tag{ㄱ}\n\\end{equation*}$$', '$$=\\frac{2}{(t+1)^{2}} \\tag{1}$$'],
    // 같은 것, \[ \] 구분자 (이 프로젝트 기본)
    ['\\[\\begin{equation*}\n=\\frac{2}{(t+1)^{2}} \\tag{ㄱ}\n\\end{equation*}\\]', '\\[=\\frac{2}{(t+1)^{2}} \\tag{1}\\]'],
    // 맨몸 equation* → \[ \] 로 감싼다
    ['앞\n\\begin{equation*}\nx=1 \\tag{ㄴ}\n\\end{equation*}\n뒤', '앞\n\\[\nx=1 \\tag{2}\n\\]\n뒤'],
    // align* → aligned · 행의 \tag{ㄴ} → \tag{2}
    ['$$\\begin{align*}\n& f=1 \\\\\n& g=2 \\tag{ㄴ}\n\\end{align*}$$', '$$\\begin{aligned}\n& f=1 \\\\\n& g=2 \\tag{2}\n\\end{aligned}$$'],
    ['\\[\\begin{align*}\n& f=1 \\\\\n& g=2 \\tag{ㄴ}\n\\end{align*}\\]', '\\[\\begin{aligned}\n& f=1 \\\\\n& g=2 \\tag{2}\n\\end{aligned}\\]'],
    // 라벨 표기 변형
    ['\\tag{(ㄷ)}', '\\tag{3}'],
    ['\\tag{㉡}', '\\tag{2}'],
    ['\\tag{3}', '\\tag{3}'],
    // 리더 잔재가 태그 안에 섞인 형태 (덕수 실측 2026-09-19)
    ['& \\Rightarrow \\frac{d t}{d s}=\\frac{2 s}{s^{2}+1} \\tag{$\\cdots \\cdots \\cdots \\cdots \\cdots \\cdot($ ㄱ}',
     '& \\Rightarrow \\frac{d t}{d s}=\\frac{2 s}{s^{2}+1} \\tag{1}'],
    ['\\tag{\\cdots \\cdots (ㄴ)}', '\\tag{2}'],
    ['\\tag{ ( ㄷ ) }', '\\tag{3}'],
    ['\\tag{ㄱ)}', '\\tag{1}'],
    ['\\tag{\\text{(ㄹ)}}', '\\tag{4}'],
    ['\\tag{……… ㉡}', '\\tag{2}'],
    ['\\tag{$\\cdots$ (3)}', '\\tag{3}'],
    ['\\tag*{(ㄱ)}', '\\tag*{1}'],
    // 판단할 수 없는 태그는 무접촉
    ['\\tag{1}', '\\tag{1}'], ['\\tag{1.2}', '\\tag{1.2}'], ['\\tag{A}', '\\tag{A}'], ['\\tag{ㄱㄴ}', '\\tag{ㄱㄴ}'], ['\\tag{12}', '\\tag{12}'],
    // 태그 없는 본문은 그대로
    ['$f(t)$ 는 부채꼴의 넓이이므로', '$f(t)$ 는 부채꼴의 넓이이므로'],
  ];
  let pass = 0, fail = 0;
  cases.forEach(function (c, i) {
    const got = N(c[0]);
    if (got === c[1]) { pass++; }
    else { fail++; Logger.log('FAIL #' + i + '\n  in : ' + JSON.stringify(c[0]) + '\n  exp: ' + JSON.stringify(c[1]) + '\n  got: ' + JSON.stringify(got)); }
  });
  // 멱등성
  cases.forEach(function (c, i) {
    const once = N(c[0]);
    if (N(once) !== once) { fail++; Logger.log('IDEMPOTENT FAIL #' + i + ': ' + JSON.stringify(once)); }
  });
  Logger.log('mpx_selfTest: PASS ' + pass + ' / FAIL ' + fail);
  return fail === 0;
}