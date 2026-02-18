/**
 * pmt 시트의 프롬프트 데이터를 CSV로 변환하여 GitHub에 push
 */
function pushPromptCsvToGithub() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO'); // kimdeoksoo-71/gas-project-audition

  if (!token || !repo) {
    throw new Error('GITHUB_TOKEN 또는 GITHUB_REPO가 설정되지 않았습니다.');
  }

  // 1) pmt 시트에서 데이터 읽기
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('pmt');
  if (!sheet) throw new Error('pmt 시트를 찾을 수 없습니다.');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('데이터가 없습니다.');
    return;
  }

  const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues(); // 헤더 제외

  // 2) CSV 생성
  const csvContent = buildCsv(data);

  // 3) GitHub에 push
  const filePath = 'prompts/pmt.csv';
  pushToGithub(token, repo, filePath, csvContent, 'Update pmt prompt CSV');

  Logger.log('GitHub push 완료: ' + filePath);
  SpreadsheetApp.getUi().alert('프롬프트 CSV가 GitHub에 push되었습니다.');
}

/**
 * 2차원 배열을 CSV 문자열로 변환
 */
function buildCsv(data) {
  const header = 'key,role,content,enabled';
  const rows = data
    .filter(row => row[0] !== '') // key가 비어있는 행 제외
    .map(row => {
      const key = escapeCsvField(String(row[0]));
      const role = escapeCsvField(String(row[1]));
      const content = escapeCsvField(String(row[2]));
      const enabled = escapeCsvField(String(row[3]));
      return `${key},${role},${content},${enabled}`;
    });

  return header + '\n' + rows.join('\n');
}

/**
 * CSV 필드 이스케이프 처리
 * - 쉼표, 줄바꿈, 큰따옴표가 포함된 경우 큰따옴표로 감싸기
 */
function escapeCsvField(value) {
  if (value.includes(',') || value.includes('\n') || value.includes('"')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/**
 * GitHub REST API를 사용하여 파일을 push (생성 또는 업데이트)
 */
function pushToGithub(token, repo, filePath, content, commitMessage) {
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;

  // 기존 파일의 SHA 확인 (업데이트 시 필요)
  let sha = null;
  try {
    const getRes = UrlFetchApp.fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'token ' + token,
        'Accept': 'application/vnd.github.v3+json'
      },
      muteHttpExceptions: true
    });

    if (getRes.getResponseCode() === 200) {
      sha = JSON.parse(getRes.getContentText()).sha;
    }
  } catch (e) {
    Logger.log('기존 파일 없음 (새로 생성): ' + e.message);
  }

  // 파일 생성/업데이트
  const payload = {
    message: commitMessage,
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8)
  };

  if (sha) {
    payload.sha = sha;
  }

  const putRes = UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = putRes.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error(`GitHub push 실패 (${code}): ${putRes.getContentText()}`);
  }

  Logger.log(`GitHub push 성공: ${filePath} (${code})`);
  return JSON.parse(putRes.getContentText());
}

function debugGithubConnection() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO');
  
  Logger.log('GITHUB_REPO: [' + repo + ']');
  Logger.log('GITHUB_TOKEN 길이: ' + (token ? token.length : 'null'));
  
  // repo 접근 테스트
  const apiUrl = 'https://api.github.com/repos/' + repo;
  const res = UrlFetchApp.fetch(apiUrl, {
    method: 'GET',
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github.v3+json'
    },
    muteHttpExceptions: true
  });
  
  Logger.log('응답코드: ' + res.getResponseCode());
  Logger.log('응답: ' + res.getContentText().substring(0, 500));
}