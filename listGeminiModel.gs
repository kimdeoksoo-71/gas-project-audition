function listGeminiModels() {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  
  const options = { 
    method: "get",
    muteHttpExceptions: true 
  };
  
  const resp = UrlFetchApp.fetch(url, options);
  const data = JSON.parse(resp.getContentText());
  
  Logger.log("=== 사용 가능한 Gemini 모델 ===");
  if (data.models) {
    data.models.forEach(model => {
      if (model.supportedGenerationMethods && 
          model.supportedGenerationMethods.includes("generateContent")) {
        Logger.log(`- ${model.name.replace("models/", "")}`);
      }
    });
  }
}