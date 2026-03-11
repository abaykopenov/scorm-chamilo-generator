import { fetchWithNetworkHint, getConfiguredBaseUrls, rotateBaseUrls } from "../llm/utils.js";

/**
 * Sends an image to a Vision LLM (like LLaVA, Moondream, qwen2.5-vl) via Ollama
 * to get a descriptive text that can be indexed into Qdrant.
 *
 * @param {object} config - Generation config (provider, model, baseUrl, etc.)
 * @param {string} imageBase64 - The image data as a base64 string
 * @param {string} [promptText] - The instruction for the vision model
 * @returns {Promise<string>} The extracted text describing the image
 */
export async function callVisionModel(config, imageBase64, promptText = "Describe this image in detail, focusing on facts, data, text, diagrams and key elements that would be useful for a training course. Provide only the description, without preamble.") {
  const allBaseUrls = getConfiguredBaseUrls(config);
  const rotationKey = `vision:${config?.model || ""}:${allBaseUrls.join("|")}`;
  const orderedBaseUrls = rotateBaseUrls(allBaseUrls, rotationKey);

  let lastError = null;

  for (const baseUrl of orderedBaseUrls) {
    const url = config.provider === "openai-compatible" 
      ? `${baseUrl}/chat/completions` 
      : `${baseUrl}/api/generate`;

    try {
      let body;
      
      if (config.provider === "openai-compatible") {
        // OpenAI-compatible Chat format for vision
        body = JSON.stringify({
          model: config.model,
          temperature: 0.1, // low temperature for factual description
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: promptText },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
              ]
            }
          ]
        });
      } else {
        // Standard Ollama format for /api/generate with images
        body = JSON.stringify({
          model: config.model,
          prompt: promptText,
          stream: false,
          images: [imageBase64],
          options: {
            temperature: 0.1
          }
        });
      }

      const response = await fetchWithNetworkHint(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      }, config.provider === "openai-compatible" ? "OpenAI-compatible" : "Ollama", { stage: "vision-generate" });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Vision API request failed with status ${response.status} (${url}) => ${errorBody}`);
      }

      const payload = await response.json();
      let content = "";
      
      if (config.provider === "openai-compatible") {
        content = payload?.choices?.[0]?.message?.content ?? "";
      } else {
        content = payload?.response ?? "";
      }

      if (content) {
        return content.trim();
      }
      
      throw new Error("Vision model response is empty.");
    } catch (error) {
      lastError = error;
      console.warn(`[Vision LLM] Attempt failed on ${baseUrl}:`, error instanceof Error ? error.message : error);
    }
  }

  throw lastError || new Error("Vision call failed on all configured nodes.");
}
