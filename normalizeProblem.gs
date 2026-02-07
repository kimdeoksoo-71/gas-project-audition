/*************************************************
 * Data_DS: 원본 문제(B열) → stem(E) + choices(F~J) + answer_type(K)
 *
 * - mcq 판정: (1)~(5) 5개가 "각각 별도 행"으로 존재하면 mcq
 * - answer_type(K) 최종 3분류:
 *    - mcq_combo : choices에 ㄱ/ㄴ/ㄷ 또는 ᄀ/ᄂ/ᄃ 포함(합답형)
 *    - mcq_math  : mcq이면서 합답형이 아닌 경우(정답형/완성형)
 *    - short_int : mcq가 아닌 경우(단답형으로 취급)
 *
 * - 선택지 정규화:
 *    - mcq_math: 수식은 $...$로 감싼다(이미 $...$ / $$...$$면 유지)
 *    - mcq_combo: ᄀᄂᄃ를 ㄱㄴㄷ로 통일하고 "ㄱ, ㄴ" 형식으로 정리
 *************************************************/

const DSN = {
  SHEET: 'Data_DS',

  // 입력
  COL: {
    raw: 2 // B 원본 문제
  },

  // 출력 (K까지만 사용)
  OUT: {
    stem: 5,      // E
    c1: 6, c2: 7, c3: 8, c4: 9, c5: 10, // F~J
    type: 11      // K  mcq_math | mcq_combo | short_int | (fail reason)
  },

  OVERWRITE_NORMALIZE: true
};

/*************************************************
 * 행 입력 파서: "15, 17, 123, 10-15"
 *************************************************/
function parseRowInput_(text) {
  const set = new Set();
  String(text ?? '').split(',').forEach(part => {
    const s = part.trim();
    if (!s) return;
    if (s.includes('-')) {
      const [a, b] = s.split('-').map(v => Number(String(v).trim()));
      if (Number.isInteger(a) && Number.isInteger(b)) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
      }
    } else {
      const n = Number(s);
      if (Number.isInteger(n)) set.add(n);
    }
  });
  return Array.from(set).sort((x, y) => x - y);
}

/*************************************************
 * 시트 기록
 *************************************************/
function writeNormResult_(sh, row, r) {
  if (!r.ok) {
    // 실패면 K에 reason만 남기고 E~J는 비움
    sh.getRange(row, DSN.OUT.stem, 1, 6).setValues([[ '', '', '', '', '', '' ]]); // E~J
    sh.getRange(row, DSN.OUT.type).setValue(String(r.reason || 'FAIL'));
    return;
  }

  const stem = String(r.stem ?? '').trim();
  const choices = Array.isArray(r.choices) ? r.choices : ['', '', '', '', ''];

  sh.getRange(row, DSN.OUT.stem, 1, 6).setValues([[
    stem,
    String(choices[0] ?? ''),
    String(choices[1] ?? ''),
    String(choices[2] ?? ''),
    String(choices[3] ?? ''),
    String(choices[4] ?? '')
  ]]);

  sh.getRange(row, DSN.OUT.type).setValue(String(r.type || ''));
}

/*************************************************
 * 파서: (1)~(5) 5개 선택지가 "각각 별도 행"으로 있어야 mcq로 인정
 *************************************************/
function parseMcqFromRaw_(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

  const stemLines = [];
  const choiceMap = {};
  // 앞쪽 공백 허용: 행 시작부터 공백 가능
  const re = /^\s*\((\d)\)\s*(.+)$/;

  let inChoices = false;

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;

    const m = s.match(re);
    if (m) {
      inChoices = true;
      const k = Number(m[1]);
      if (k >= 1 && k <= 5) choiceMap[k] = m[2].trim();
      continue;
    }

    // 선택지 구간에 들어간 후 (n) 패턴이 아닌 라인 처리
    if (inChoices) {
      // 숫자만 있거나 의미없는 텍스트는 무시 (정답 번호나 메타데이터)
      // 한글/영문이 섞인 실제 내용이 있으면 포맷 오류로 간주
      if (/^[\d\s]+$/.test(s) || s.length <= 3) {
        // 무시하고 계속 진행
        continue;
      }
      // 그 외는 포맷 오류
      return { ok: false, reason: 'CHOICE_BLOCK_FORMAT_BREAK' };
    }

    stemLines.push(line);
  }

  // 5개 선택지 모두 존재 확인
  for (let k = 1; k <= 5; k++) {
    if (!choiceMap[k]) return { ok: false, reason: 'CHOICE_MISSING_' + k };
  }

  return {
    ok: true,
    stem: stemLines.join('\n').trim(),
    choices: [1, 2, 3, 4, 5].map(k => choiceMap[k])
  };
}

/*************************************************
 * answer_type 판정: ㄱ/ㄴ/ㄷ 또는 ᄀ/ᄂ/ᄃ 포함되면 mcq_combo, 아니면 mcq_math
 *************************************************/
function detectAnswerTypeFromChoices_(choices) {
  const joined = (choices || []).join(' ');
  return /[ㄱㄴㄷᄀᄂᄃ]/.test(joined) ? 'mcq_combo' : 'mcq_math';
}

/*************************************************
 * 수식 선택지 정규화: $...$ 강제(이미 $...$ 또는 $$...$$면 유지)
 *************************************************/
function normalizeChoiceToLatex_(s) {
  const t = String(s ?? '').trim();
  if (!t) return '';
  // 이미 $...$ 또는 $$...$$면 그대로
  if ((t.startsWith('$$') && t.endsWith('$$')) || (t.startsWith('$') && t.endsWith('$'))) return t;
  // 합답형 문자가 섞이면 감싸지 않음(안전장치)
  if (/[ㄱㄴㄷᄀᄂᄃ]/.test(t)) return t;
  // 그 외는 $...$
  return '$' + t + '$';
}

/*************************************************
 * 합답형 선택지 정규화: ᄀᄂᄃ(호환 자모) → ㄱㄴㄷ로 통일 + "ㄱ, ㄴ" 형식
 *************************************************/
function normalizeComboChoice_(s) {
  const t0 = String(s ?? '').trim()
    .replace(/ᄀ/g, 'ㄱ')
    .replace(/ᄂ/g, 'ㄴ')
    .replace(/ᄃ/g, 'ㄷ');

  const hasG = t0.includes('ㄱ');
  const hasN = t0.includes('ㄴ');
  const hasD = t0.includes('ㄷ');

  const arr = [];
  if (hasG) arr.push('ㄱ');
  if (hasN) arr.push('ㄴ');
  if (hasD) arr.push('ㄷ');

  return arr.join(', ');
}

/**
 * 메인메뉴에서 호출: 행번호 입력(예: 15, 17, 123, 10-15)
 */
function ds_runNormalizeAndValidate_byRowInput() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('정규화+검증(문제) 행 번호 입력', '예: 15, 17, 123, 10-15', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const rows = parseRowInput_(res.getResponseText());
  if (!rows.length) return;

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(DSN.SHEET);
  if (!sh) throw new Error(`시트 없음: ${DSN.SHEET}`);

  let ok = 0, fail = 0;

  for (const row of rows) {
    try {
      const raw = String(sh.getRange(row, DSN.COL.raw).getDisplayValue() || '').trim();
      if (!raw) {
        writeNormResult_(sh, row, { ok: false, reason: 'RAW_EMPTY' });
        fail++;
        continue;
      }

      // overwrite=false면 이미 stem(E)이 있으면 skip
      if (!DSN.OVERWRITE_NORMALIZE) {
        const existingStem = String(sh.getRange(row, DSN.OUT.stem).getDisplayValue() || '').trim();
        if (existingStem) continue;
      }

      // 1) MCQ 파싱 시도
      const mcq = parseMcqFromRaw_(raw);

      if (mcq.ok) {
        const answer_type = detectAnswerTypeFromChoices_(mcq.choices);

        // type에 따라 choice 정규화
        let choicesOut = mcq.choices.slice();
        if (answer_type === 'mcq_math') {
          choicesOut = choicesOut.map(x => normalizeChoiceToLatex_(x));
        } else {
          // mcq_combo
          choicesOut = choicesOut.map(x => normalizeComboChoice_(x));
        }

        writeNormResult_(sh, row, {
          ok: true,
          stem: mcq.stem,
          choices: choicesOut,
          type: answer_type
        });
        ok++;
        continue;
      }

      // 2) MCQ 아니면 단답형으로 분류
      writeNormResult_(sh, row, {
        ok: true,
        stem: raw,
        choices: ['', '', '', '', ''],
        type: 'short_int'
      });
      ok++;

    } catch (e) {
      writeNormResult_(sh, row, { ok: false, reason: 'EXCEPTION: ' + (e?.message || String(e)) });
      fail++;
    }
  }

  SpreadsheetApp.getActive().toast(`정규화 완료: 성공 ${ok}, 실패 ${fail}`, 'Data_DS', 5);
}