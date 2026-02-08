/***********************
 * Dual Engine Runner
 ***********************/
const SHEET_NAME_DATA = 'Data_DS';
const SHEET_NAME_PROMPT = 'prompt';

// ✅ prompt key 분리
const PROMPT_KEY_GPT = 'solution_verify_gpt';
const PROMPT_KEY_GEMINI = 'solution_verify_gemini';

// ✅ 상태키
const PROP_CURRENT_ROW = 'AUTO_CURRENT_ROW';
const PROP_END_ROW = 'AUTO_END_ROW';
const PROP_STOP_SIGNAL = 'AUTO_STOP_SIGNAL';
const PROP_RUNNING = 'AUTO_RUNNING';
const PROP_LAST_TRIGGER_TIME = 'AUTO_LAST_TRIGGER';
const PROP_PROVIDER = 'AUTO_PROVIDER'; // "gpt" | "gemini"

// ✅ API KEY (스크립트 속성)
const OPENAI_API_KEY = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

// ✅ 모델명
const OPENAI_MODEL = 'gpt-5.2';
const GEMINI_MODEL = 'gemini-2.5-pro';

function startProcessGPT() {
  startAutomaticProcess_('gpt');
}

function startProcessGemini() {
  startAutomaticProcess_('gemini');
}

function startAutomaticProcess_(provider) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  // 키 체크
  if (provider === 'gpt' && !OPENAI_API_KEY) return ui.alert('OPENAI_API_KEY가 설정되지 않았습니다.');
  if (provider === 'gemini' && !GEMINI_API_KEY) return ui.alert('GEMINI_API_KEY가 설정되지 않았습니다.');

  if (props.getProperty(PROP_RUNNING) === 'true') {
    ui.alert('이미 작업이 실행 중입니다.');
    return;
  }

  props.setProperty(PROP_STOP_SIGNAL, 'false');
  props.deleteProperty(PROP_LAST_TRIGGER_TIME);
  deleteAllTriggers();

  const input = ui.prompt('범위 입력', '전체 범위를 입력하세요 (예: 2-200)', ui.ButtonSet.OK_CANCEL);
  if (input.getSelectedButton() !== ui.Button.OK) return;

  const range = parseRowRange(input.getResponseText());
  if (!range) return ui.alert('형식이 잘못되었습니다.');

  props.setProperties({
    [PROP_PROVIDER]: provider,
    [PROP_CURRENT_ROW]: String(range.startRow),
    [PROP_END_ROW]: String(range.endRow),
    [PROP_RUNNING]: 'true'
  });

  ss.toast(`${range.startRow}행부터 자동 검수 시작 (${provider.toUpperCase()})`, '자동화 시작');
  mainLoop();
}

function forceStopProcess() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_STOP_SIGNAL, 'true');
  props.deleteProperty(PROP_RUNNING);
  props.deleteProperty(PROP_LAST_TRIGGER_TIME);
  props.deleteProperty(PROP_PROVIDER);
  deleteAllTriggers();
  SpreadsheetApp.getActiveSpreadsheet().toast('작업을 완전히 중단했습니다.', '중단 알림');
}

function mainLoop() {
  const lock = LockService.getScriptLock();
  const props = PropertiesService.getScriptProperties();

  // 중복 실행 방지
  const now = Date.now();
  const lastTrigger = parseInt(props.getProperty(PROP_LAST_TRIGGER_TIME) || '0', 10);
  if (now - lastTrigger < 30000) return;
  props.setProperty(PROP_LAST_TRIGGER_TIME, String(now));

  if (!lock.tryLock(5000)) return;

  const startTime = Date.now();
  const MAX_RUNTIME = 270000;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME_DATA);

  let shouldContinue = false;

  try {
    const provider = (props.getProperty(PROP_PROVIDER) || 'gpt').toLowerCase();
    const promptKey = provider === 'gemini' ? PROMPT_KEY_GEMINI : PROMPT_KEY_GPT;
    const systemPrompt = getSystemPromptByKey_(ss, promptKey);

    if (!systemPrompt) {
      props.deleteProperty(PROP_RUNNING);
      return;
    }

    let currentRow = parseInt(props.getProperty(PROP_CURRENT_ROW), 10);
    const endRow = parseInt(props.getProperty(PROP_END_ROW), 10);

    while (currentRow <= endRow) {
      if (props.getProperty(PROP_STOP_SIGNAL) === 'true') {
        sheet.getRange(currentRow, 17).setValue("STOP (USER)");
        props.deleteProperty(PROP_RUNNING);
        props.deleteProperty(PROP_LAST_TRIGGER_TIME);
        SpreadsheetApp.flush();
        return;
      }

      Utilities.sleep(1000);
      sheet.getRange(currentRow, 17).setValue("RUN");
      SpreadsheetApp.flush();

      const rowData = sheet.getRange(currentRow, 1, 1, 5).getValues()[0];
      const solution = rowData[2]; // C
      const problem = rowData[4];  // E

      if (problem && solution) {
        const result = (provider === 'gemini')
          ? callGemini_(systemPrompt, problem, solution)
          : callOpenAI_(systemPrompt, problem, solution);

        sheet.getRange(currentRow, 17, 1, 2).setValues([[result.verdict, result.error_report]]);
      } else {
        sheet.getRange(currentRow, 17).setValue("SKIP");
      }

      currentRow++;
      props.setProperty(PROP_CURRENT_ROW, String(currentRow));
      SpreadsheetApp.flush();

      if (Date.now() - startTime > MAX_RUNTIME) {
        sheet.getRange(currentRow, 17).setValue("PAUSED");
        SpreadsheetApp.flush();
        shouldContinue = true;
        break;
      }
    }

    if (!shouldContinue) {
      ss.toast('모든 검수가 완료되었습니다.', '완료');
      props.deleteProperty(PROP_CURRENT_ROW);
      props.deleteProperty(PROP_END_ROW);
      props.deleteProperty(PROP_RUNNING);
      props.deleteProperty(PROP_LAST_TRIGGER_TIME);
      props.deleteProperty(PROP_PROVIDER);
      deleteAllTriggers();
    } else {
      ss.toast(`${props.getProperty(PROP_CURRENT_ROW)}행에서 일시정지. 60초 후 재개`, '시간 보호');
    }

  } finally {
    try { lock.releaseLock(); } catch(e) {}

    if (shouldContinue) {
      deleteAllTriggers();
      ScriptApp.newTrigger('mainLoop').timeBased().after(60000).create();
    }
  }
}

/***************
 * Provider Calls
 ***************/
function callOpenAI_(systemPrompt, problem, solution) {
  const payload = {
    model: OPENAI_MODEL,
    store: false,
    reasoning: { effort: "none" },
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `[문제]\n${problem}\n\n[풀이]\n${solution}` }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "solution_verification",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            verdict: { type: "string", enum: ["ok", "error", "check"] },
            error_report: { type: "string" }
          },
          required: ["verdict", "error_report"]
        }
      }
    }
  };

  const res = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + OPENAI_API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    return { verdict: "error", error_report: `HTTP ${res.getResponseCode()}: ${res.getContentText().slice(0, 200)}` };
  }

  const obj = JSON.parse(res.getContentText());
  const text = extractResponseText_(obj);
  try {
    const j = JSON.parse(text);
    return { verdict: j.verdict || "check", error_report: j.error_report || "" };
  } catch (e) {
    return { verdict: "check", error_report: "JSON parse 실패" };
  }
}

function extractResponseText_(resObj) {
  const out = resObj && resObj.output;
  if (!Array.isArray(out)) return "";
  for (const item of out) {
    const content = item && item.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c && typeof c.text === "string") return c.text;
    }
  }
  return "";
}

function callGemini_(systemPrompt, problem, solution) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: `[문제]\n${problem}\n[풀이]\n${solution}` }] }],
    generationConfig: { response_mime_type: "application/json", temperature: 0.1 }
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    return { verdict: "error", error_report: `HTTP ${res.getResponseCode()}: ${res.getContentText().slice(0, 200)}` };
  }

  const txt = JSON.parse(res.getContentText())?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const match = txt.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: "check", error_report: "JSON 없음" };

  try {
    const j = JSON.parse(match[0].replace(/```json|```/g, "").trim());
    return { verdict: j.verdict || "check", error_report: j.error_report || "" };
  } catch (e) {
    return { verdict: "check", error_report: "JSON parse 실패" };
  }
}

/***************
 * Utils
 ***************/
function deleteAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'mainLoop') ScriptApp.deleteTrigger(t);
  }
}

function getSystemPromptByKey_(ss, key) {
  const sheet = ss.getSheetByName(SHEET_NAME_PROMPT);
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const k = String(data[i][0]).trim();
    const enabled = (data[i][2] === true || String(data[i][2]).toUpperCase() === 'TRUE');
    if (k === key && enabled) return data[i][1];
  }
  return null;
}

function parseRowRange(text) {
  const t = String(text || "").trim();
  const m = t.match(/^(\d+)-(\d+)$/) || t.match(/^(\d+)$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start;
  return { startRow: start, endRow: end };
}
