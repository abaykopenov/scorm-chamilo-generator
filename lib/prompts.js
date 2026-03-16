function estimateScreenCount(input) {
  const moduleCount = Math.max(1, Math.trunc(Number(input?.structure?.moduleCount) || 1));
  const sectionsPerModule = Math.max(1, Math.trunc(Number(input?.structure?.sectionsPerModule) || 1));
  const scosPerSection = Math.max(1, Math.trunc(Number(input?.structure?.scosPerSection) || 1));
  const screensPerSco = Math.max(1, Math.trunc(Number(input?.structure?.screensPerSco) || 1));
  return moduleCount * sectionsPerModule * scosPerSection * screensPerSco;
}

function buildSourceContext(input, limits = {}) {
  const screenCount = estimateScreenCount(input);
  // Increase chunk limits so LLM gets enough source material for substantive content
  const adaptiveItemCap = screenCount >= 120
    ? 10
    : (screenCount >= 60 ? 12 : (screenCount >= 30 ? 14 : 16));
  const adaptiveCharCap = screenCount >= 120
    ? 900
    : (screenCount >= 60 ? 1000 : (screenCount >= 30 ? 1200 : 1400));

  const requestedItems = Number(limits.maxItems) || Math.min(16, Number(input?.rag?.topK) || 10);
  const requestedChars = Number(limits.maxChars) || 1200;

  const maxItems = Math.max(1, Math.min(20, adaptiveItemCap, requestedItems));
  const maxChars = Math.max(200, Math.min(2000, adaptiveCharCap, requestedChars));

  return Array.isArray(input?.ragContext?.chunks)
    ? input.ragContext.chunks.slice(0, maxItems).map((chunk, index) => ({
      order: index + 1,
      source: chunk.fileName || chunk.materialId || `source_${index + 1}`,
      score: chunk.score,
      text: `${chunk.text || ""}`.slice(0, maxChars)
    }))
    : [];
}
function buildScreenPlanHints(input, limits = {}) {
  const hints = Array.isArray(input?.ragContext?.screenPlanHints)
    ? input.ragContext.screenPlanHints
    : [];
  const maxItems = Math.max(1, Math.min(60, Number(limits.maxItems) || 24));

  return hints.slice(0, maxItems).map((hint) => ({
    label: hint?.label,
    objective: `${hint?.objective || ""}`.slice(0, 180),
    keyFacts: Array.isArray(hint?.keyFacts)
      ? hint.keyFacts.slice(0, 3).map((fact) => `${fact || ""}`.slice(0, 200))
      : []
  }));
}

export function createOutlineJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "description", "modules", "finalTest"],
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      modules: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "sections"],
          properties: {
            title: { type: "string" },
            sections: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "scos"],
                properties: {
                  title: { type: "string" },
                  scos: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["title", "screens"],
                      properties: {
                        title: { type: "string" },
                        screens: {
                          type: "array",
                          items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["title", "blocks"],
                            properties: {
                              title: { type: "string" },
                              blocks: {
                                type: "array",
                                items: {
                                  type: "object",
                                  additionalProperties: false,
                                  required: ["type"],
                                  properties: {
                                    type: { type: "string", enum: ["text", "note", "list", "table"] },
                                    text: { type: "string" },
                                    items: {
                                      type: "array",
                                      items: { type: "string" }
                                    },
                                    columns: {
                                      type: "array",
                                      items: { type: "string" }
                                    },
                                    rows: {
                                      type: "array",
                                      items: {
                                        type: "array",
                                        items: { type: "string" }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      finalTest: {
        type: "object",
        additionalProperties: false,
        required: ["title", "questions"],
        properties: {
          title: { type: "string" },
          questions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["prompt", "options", "correctOptionIndex", "explanation"],
              properties: {
                prompt: { type: "string" },
                options: {
                  type: "array",
                  minItems: 4,
                  items: { type: "string" }
                },
                correctOptionIndex: { type: "number" },
                explanation: { type: "string" }
              }
            }
          }
        }
      }
    }
  };
}

export function createOutlinePrompt(input) {
  const screenCount = estimateScreenCount(input);
  const generationPhase = `${input?.generation?.generationPhase || "full"}`.trim().toLowerCase();
  const structureOnly = generationPhase === "structure";
  const writerPhase = generationPhase === "writer";
  const sourceContext = buildSourceContext(input, {
    maxItems: structureOnly ? 10 : (writerPhase ? 16 : 14),
    maxChars: structureOnly ? 800 : (writerPhase ? 1400 : 1200)
  });
  const screenPlanHints = buildScreenPlanHints(input, {
    maxItems: structureOnly
      ? Math.max(6, Math.min(14, Math.ceil(screenCount / 2)))
      : Math.max(8, Math.min(18, Math.ceil(screenCount / 2)))
  });

  const system = [
    "Generate JSON for an e-learning course without markdown and without explanations.",
    "The response must be a valid JSON object only.",
    "Follow requested structure and requested item counts exactly.",
    input.previousBodyText ? `CRITICAL CONTEXT: The previous screen discussed: "... ${input.previousBodyText.slice(-400)}". You must continue the flow logically from this point. DO NOT repeat the exact same sentences or introductory phrases. Build upon the previous context.` : "",
    structureOnly
      ? "Structure phase only: produce short skeleton content with descriptive, meaningful titles (never 'Module 1' or 'Screen 1') and minimal blocks."
      : (writerPhase
        ? "Writer phase: generate deep instructional content strictly grounded in sourceContext and screenPlanHints."
        : "Every screen must contain substantive content and descriptive, meaningful titles (never generic 'Section X' or 'Screen Y')."),
    structureOnly
      ? "For each screen return one short text block (2-3 sentences). Avoid long narratives and avoid list blocks unless required."
      : (writerPhase
        ? "For each screen return: 1) one substantive text block of 600-1200 characters (3-5 detailed paragraphs explaining the topic in depth with facts and examples from sourceContext), 2) one list block with 3-5 concrete takeaways. IMPORTANT: Write comprehensive, detailed educational text. Short screens of 1-2 sentences are NOT acceptable."
        : "For each screen write a detailed text block of at least 400-800 characters covering the topic with concrete facts and examples. Do not add any extra fields outside schema."),

    // ===== QUALITY RULES =====
    "QUALITY RULE — NO FILLER TEXT: Do not write generic introductory phrases like 'it is important to note', 'in the framework of', 'it should be understood that'. Every sentence must carry NEW information. If a sentence can be removed without losing information, do not write it.",
    "QUALITY RULE — NO REPETITION ACROSS SCREENS: Each screen MUST cover a DIFFERENT topic. If you already wrote about 'filesystem and computation graph' on one screen, you MUST NOT write about it again on another screen. Each screen must introduce entirely NEW concepts, tools, commands, or procedures from the sourceContext. Repeating the same topic across screens is STRICTLY PROHIBITED.",
    "QUALITY RULE — TOPIC DIVERSITY: The course must cover the FULL BREADTH of topics from sourceContext. If the source material discusses simulation (Gazebo), navigation, visualization (rviz), motion planning (MoveIt), sensor integration, URDF, tf transforms, etc., each of these MUST appear in separate screens. Do NOT focus on only one aspect of the material.",
    "QUALITY RULE — STRUCTURED CONTENT: Prefer bullet-point lists (type: 'list') over walls of text. Break long explanations into list blocks with short, concrete items. Each text block should be a focused paragraph, NOT a multi-paragraph essay.",
    "QUALITY RULE — TABLES: If the source material contains a data table, markdown table, or structured data logic, use a block with `type: \"table\"`. Do NOT try to format tables as raw text. Set the `columns` array to the list of header strings, and the `rows` array to an array of arrays containing the cell string values. Reproduce the exact data.",
    "QUALITY RULE — USE TERMINOLOGY FROM EVIDENCE: When sourceContext provides factual content, preserve key terminology and domain-specific terms. Paraphrase into clear, well-structured educational text while keeping the core concepts accurate. Write in professional academic style.",
    "QUALITY RULE — IGNORE METADATA IN SOURCE: If sourceContext contains author biographical info (credentials, titles, affiliations), publisher/copyright info, ISBN codes, contact details, page numbers, or garbled text with merged words (no spaces between them), COMPLETELY IGNORE those fragments. NEVER include author names, credentials, contact information, or publishing metadata in educational content. Use ONLY the substantive educational/scientific content from sources.",
    "QUALITY RULE — NO INTERNAL LABELS: NEVER include internal markers like 'Evidence 1 (...)', 'Practical step:', 'The screen explains...', source file names, or any meta-commentary in the educational text. The student must see ONLY clean educational content.",

    // ===== NEW: ANTI-GARBAGE RULES =====
    "CRITICAL — NEVER COPY VERBATIM: Do NOT copy text from sourceContext word-for-word. ALWAYS rephrase and restructure the information in your own words. The student should read clean, well-written educational text, not raw excerpts from a PDF. If sourceContext contains garbled or merged text, IGNORE those fragments entirely.",
    "CRITICAL — LATIN SCRIPT FOR TECHNICAL TERMS: All programming commands, file names, package names, and tool names MUST use Latin (English) characters ONLY. Write 'CMakeLists.txt' NOT 'СМаkеLists.txt', write 'package.xml' NOT 'расkage.xml', write 'catkin_make' NOT 'catkin_mаkе', write '.py' NOT '.ру'. NEVER mix Cyrillic and Latin characters in technical terms.",
    "CRITICAL — HUMAN WRITING STYLE: Write like a university lecturer explaining to students, NOT like a Wikipedia article or technical reference. Use conversational yet professional tone. Start with motivation ('Why do we need this?'), then explain the concept, then give a practical example. The text must feel like it was written by a human expert.",
    "CRITICAL — IGNORE PDF ARTIFACTS: If sourceContext contains '(cid:NNN)', dot leaders ('... . . . 36'), table of contents fragments ('2.9 Исследованиепакета'), page numbers, or merged words without spaces — COMPLETELY IGNORE those parts. These are PDF parsing artifacts, NOT educational content.",
    "CRITICAL — NO MERGED WORDS: Every word in your output MUST be separated by spaces. NEVER output merged words like 'КакназываетсяутилитадлявизуализацииROS'. If you see merged text in sourceContext, extract the meaning and rewrite it properly with spaces: 'Как называется утилита для визуализации ROS'.",
    "CRITICAL — LOGICAL FLOW: Arrange topics in logical learning order — from basic to advanced. Do NOT explain advanced tools before explaining the concepts they depend on. For example: explain what a workspace is BEFORE explaining how to create packages in it.",

    writerPhase
      ? "Do not invent facts beyond sourceContext. Every claim must be traceable to provided facts. NEVER mention source file names or hint indices in the educational text directly. NEVER write 'Note:' or similar annotations."
      : "Do not use placeholder phrases like 'Screen X introduces topic'. Write concrete content.",
    sourceContext.length > 0
      ? "CRITICAL — GROUND IN SOURCE MATERIAL: Use sourceContext as the PRIMARY and AUTHORITATIVE source for ALL content. Extract specific technical details, commands, parameters, code examples, architecture descriptions, and procedures from the provided chunks. Do NOT write generic overviews — use the ACTUAL content, terminology, and examples from sourceContext. If sourceContext describes specific tools, commands, or workflows, include them by name with details. Do NOT introduce topics or technologies that are NOT mentioned in sourceContext — this counts as hallucination. EVERY question in finalTest must test actual knowledge found in sourceContext."
      : "If sourceContext is empty, rely only on user brief. The test questions must be meaningful and check real knowledge.",
    "CRITICAL: All generated 'title' fields (for course, modules, sections, scos, screens) MUST be descriptive and reflect the actual content (e.g. 'Introduction to Digital Twins'). NEVER use generic placeholder titles like 'Module 1', 'Section 2', 'SCO 3', or 'Screen 4'. NEVER generate 'Knowledge check', 'Quiz', or 'Test' screens inside the modules. Testing is handled separately.",
    "If bookTableOfContents is provided, use it as a GUIDE for naming and organizing modules and sections. Align course structure with the book's chapter structure when possible.",
    screenPlanHints.length > 0
      ? "Use screenPlanHints in order. Each next screen must use its own hints and must not repeat previous screen wording."
      : "",
    // — Shared Memory: inject summary of already-generated modules —
    Array.isArray(input.moduleMemory) && input.moduleMemory.length > 0
      ? [
          "ALREADY COVERED MODULES (DO NOT REPEAT these topics, terms, or explanations):",
          ...input.moduleMemory.map(m => {
            const kw = m.topics?.keywords?.length > 0 ? `: ${m.topics.keywords.join(", ")}` : "";
            const sc = m.topics?.screenTitles?.length > 0 ? `\n    Screens: ${m.topics.screenTitles.join("; ")}` : "";
            return `  - Module ${m.module} "${m.title}"${kw}${sc}`;
          }),
          "You MUST generate ONLY NEW content that is NOT covered in the modules above.",
          "Do NOT re-explain concepts, terms, or commands that were already introduced."
        ].join("\n")
      : "",
    "CRITICAL QUALITY CHECK: Ensure perfect spelling and flowing, natural grammar strictly in the requested language (Russian or English).",
    "ABSOLUTELY NO weird formatting, NO accidental spaces between letters inside words (like 'с л о в о' or 'w o r d'), NO random characters, and NO hallucinatory unicode symbols.",
    input.language === "en"
      ? "LANGUAGE: Generate ALL content (titles, descriptions, text blocks, list items, test questions, and explanations) in ENGLISH. Do NOT mix languages."
      : "LANGUAGE: Generate ALL content (titles, descriptions, text blocks, list items, test questions, and explanations) in RUSSIAN. Do NOT mix languages."
  ].filter(Boolean).join(" ");

  // Build book TOC if available from RAG context
  const tocEntries = Array.isArray(input.ragContext?.toc) ? input.ragContext.toc : [];
  const bookToc = tocEntries.length > 0
    ? tocEntries.map(e => {
        const indent = "  ".repeat(Math.max(0, (e.level || 1) - 1));
        return `${indent}${e.title}`;
      }).join("\n")
    : undefined;

  return {
    system,
    user: {
      language: input.language,
      title: input.titleHint,
      audience: input.audience,
      durationMinutes: input.durationMinutes,
      learningGoals: input.learningGoals,
      structure: input.structure,
      finalTest: input.finalTest,
      previousBodyText: input.previousBodyText ? `... ${input.previousBodyText.slice(-400)}` : undefined,
      generationPhase,
      sourceContext,
      screenPlanHints,
      bookTableOfContents: bookToc
    }
  };
}
export function createOutlineRepairPrompt(input, invalidResponse, parseErrorMessage) {
  const generationPhase = `${input?.generation?.generationPhase || "full"}`.trim().toLowerCase();
  return {
    system: [
      "Convert draft model output into strictly valid course JSON.",
      "Return JSON object only.",
      "No markdown, no explanations, no comments.",
      "Follow schema exactly.",
      "CRITICAL: Replace any generic outline titles (like 'Module 1', 'Screen 2') with actual descriptive names based on the content."
    ].join(" "),
    user: {
      language: input.language,
      title: input.titleHint,
      audience: input.audience,
      durationMinutes: input.durationMinutes,
      learningGoals: input.learningGoals,
      structure: input.structure,
      finalTest: input.finalTest,
      generationPhase,
      parseErrorMessage,
      invalidResponse: `${invalidResponse || ""}`.slice(0, 16_000),
      schema: createOutlineJsonSchema()
    }
  };
}

export function createLinePlanPrompt(input) {
  const sourceContext = buildSourceContext(input, { maxItems: 10, maxChars: 1000 });
  const screenPlanHints = buildScreenPlanHints(input, { maxItems: 18 });
  const screenCount =
    Number(input?.structure?.moduleCount || 1) *
    Number(input?.structure?.sectionsPerModule || 1) *
    Number(input?.structure?.scosPerSection || 1) *
    Number(input?.structure?.screensPerSco || 1);
  const topicCount = Math.max(4, Math.min(18, screenCount));
  const questionCount = Math.max(1, Number(input?.finalTest?.questionCount || 8));

  return {
    system: [
      "Generate course plan and test in strict line format (no JSON, no markdown).",
      "No extra text before or after lines.",
      "Line format:",
      "TITLE|...",
      "DESCRIPTION|...",
      "TOPIC|<title>|<explanation>|<bullet1>; <bullet2>; <bullet3>",
      "TOPIC explanation must be concrete and complete (at least 2 full sentences, avoid generic filler).",
      "QUESTION|<prompt>|<option1>|<option2>|<option3>|<option4>|<correctOptionIndex1to4>|<explanation>",
      "All TOPIC and QUESTION lines must be grounded in sourceContext.",
      "CRITICAL: QUESTION prompts MUST ask about actual concepts (e.g. 'What is a Digital Twin?'). NEVER write placeholder questions like 'Which statement matches question 1?'.",
      "Use screenPlanHints to avoid repetition between consecutive topics/screens.",
      "Do not use placeholder text.",
      "QUALITY RULE — NO FILLER: Every sentence must carry new information. Do not write 'it is important', 'it should be noted', or similar empty phrases.",
      "QUALITY RULE — NO REPETITION: Never rephrase the same idea twice. Each TOPIC must cover a distinct aspect.",
      "QUALITY RULE — USE TERMINOLOGY: Preserve key terminology and domain terms from sourceContext. Paraphrase into clear educational text while keeping concepts accurate.",
      "QUALITY RULE — IGNORE METADATA: If sourceContext contains author bios, credentials, publisher info, ISBN, contact details, page numbers, or garbled/merged text — COMPLETELY IGNORE those parts. Use ONLY substantive educational content.",
      "QUALITY RULE — NO INTERNAL LABELS: Never include 'Evidence', 'Practical step:', source file names, or meta-commentary in the text.",
      "CRITICAL — NEVER COPY VERBATIM: ALWAYS rephrase sourceContext in your own words. Never copy raw text from PDF. Ignore (cid:NNN), dot-leaders, merged words.",
      "CRITICAL — LATIN FOR TECH TERMS: Write 'CMakeLists.txt' not 'СМаkеLists.txt', 'package.xml' not 'расkage.xml', '.py' not '.ру'. NEVER mix Cyrillic and Latin in technical terms.",
      "CRITICAL — HUMAN STYLE: Write like a lecturer, not Wikipedia. Motivate, explain, give examples.",
      "CRITICAL — NO MERGED WORDS: Every word MUST be separated by spaces. If sourceContext has merged text, extract meaning and rewrite properly.",
      "CRITICAL QUALITY CHECK: Ensure perfect spelling and flowing, natural grammar strictly in the requested language (Russian or English).",
      "ABSOLUTELY NO weird formatting, NO accidental spaces between letters inside words (like 'с л о в о' or 'w o r d'), NO random characters, and NO hallucinatory unicode symbols."
    ].join(" "),
    user: {
      language: input.language,
      title: input.titleHint,
      audience: input.audience,
      durationMinutes: input.durationMinutes,
      learningGoals: input.learningGoals,
      requiredTopicCount: topicCount,
      requiredQuestionCount: questionCount,
      sourceContext,
      screenPlanHints
    }
  };
}

export function createLinePlanRepairPrompt(input, invalidResponse, parseErrorMessage) {
  const sourceContext = buildSourceContext(input, { maxItems: 8, maxChars: 800 });
  const screenPlanHints = buildScreenPlanHints(input, { maxItems: 24 });
  const questionCount = Math.max(1, Number(input?.finalTest?.questionCount || 8));

  return {
    system: [
      "Reformat draft model output into strict line format (no JSON, no markdown).",
      "Allowed lines only: TITLE|, DESCRIPTION|, TOPIC| and QUESTION|.",
      "Keep semantic connection with sourceContext."
    ].join(" "),
    user: {
      parseErrorMessage,
      invalidResponse: `${invalidResponse || ""}`.slice(0, 12_000),
      requiredQuestionCount: questionCount,
      sourceContext,
      screenPlanHints
    }
  };
}

export function createFinalTestPrompt(input, combinedCourseText) {
  const desiredCount = Math.max(1, Math.trunc(Number(input?.finalTest?.questionCount) || 8));
  const lang = input?.language === "en" ? "English" : "Russian";

  return {
    system: [
      "You are an expert instructional designer and testing specialist.",
      "Your task is to generate a comprehensive, situational Final Test based ONLY on the provided course material.",
      "The output must be a valid JSON object ONLY, containing a single array property 'questions'.",
      "No markdown, no explanations, ONLY raw JSON.",
      `You must generate EXACTLY ${desiredCount} questions.`,
      `LANGUAGE: ALL question prompts, options, and explanations MUST be in ${lang}. Do NOT mix languages.`,

      "CRITICAL RULE 1 — SITUATIONAL QUESTIONS: Formulate REAL, situational, or case-based questions that test application of knowledge. Example: 'Вы хотите запустить несколько узлов ROS одновременно. Какой инструмент следует использовать?'",
      "CRITICAL RULE 2 — NO META-QUESTIONS: NEVER generate placeholder or meta-questions like 'Which statement matches screen 2?' or 'What is discussed in chapter 1?'.",
      "CRITICAL RULE 3 — BALANCED OPTIONS: Do not make the correct option obviously longer than the distractors. All 4 options must be similar in length and style.",

      "CRITICAL RULE 4 — ANSWER MUST MATCH EXPLANATION: The option at correctOptionIndex MUST be the one supported by the explanation. SELF-CHECK: Before outputting each question, verify that options[correctOptionIndex] is actually the correct answer according to the courseContextText and your explanation. If the explanation says 'a package includes code, dependencies, and resources', then correctOptionIndex MUST point to the option that says 'code, dependencies, and resources', NOT to 'only source code'. VIOLATING THIS RULE IS THE MOST CRITICAL ERROR.",
      "CRITICAL RULE 5 — VERIFY AGAINST SOURCE: Every correct answer MUST be verifiable from courseContextText. Do NOT invent facts. If the text says 'catkin_create_pkg' is used to create packages, the correct answer must reflect this exactly.",
      "CRITICAL RULE 6 — NO TRICK OPTIONS: Distractors (wrong options) must be PLAUSIBLE but CLEARLY wrong based on the course material. Do NOT create trick options that are also partially correct.",
      "CRITICAL RULE 7 — SELF-CHECK PROCEDURE: After generating all questions, mentally verify EACH one: read the explanation, find the option it supports, and confirm correctOptionIndex points to THAT option. If there is any mismatch, fix the correctOptionIndex.",

      "JSON Schema:",
      "{",
      "  \"questions\": [",
      "    {",
      "      \"prompt\": \"Ситуационный вопрос, проверяющий реальные знания\",",
      "      \"options\": [\"Вариант 1\", \"Вариант 2\", \"Вариант 3\", \"Вариант 4\"],",
      "      \"correctOptionIndex\": 0,",
      "      \"explanation\": \"Почему это правильно, со ссылкой на текст курса.\"",
      "    }",
      "  ]",
      "}"
    ].join(" "),
    user: {
      instructions: `Create ${desiredCount} questions in ${lang}. Use the course context to create plausible distractors (wrong options). SELF-CHECK each answer: read the explanation, then verify that correctOptionIndex actually points to the correct option.`,
      courseContextText: String(combinedCourseText).slice(0, 16000)
    }
  };
}








