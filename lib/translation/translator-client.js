const TRANSLATOR_URL = "http://127.0.0.1:5005";

async function isTranslatorAvailable() {
  try {
    const res = await fetch(`${TRANSLATOR_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function translateTextArray(textsArray, sourceLang = "ru", targetLang = "ru") {
  if (sourceLang === targetLang) return textsArray;
  if (!Array.isArray(textsArray) || textsArray.length === 0) return textsArray;

  try {
    const response = await fetch(`${TRANSLATOR_URL}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: textsArray,
        source: sourceLang,
        target: targetLang
      })
    });

    if (!response.ok) {
      throw new Error(`Translator API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.translatedText || textsArray;
  } catch (err) {
    console.error(`[Translator] Failed to translate:`, err.message || err);
    return textsArray; // Graceful fallback: return original text if translation fails
  }
}

export async function translateCourse(course, sourceLang = "ru", targetLang = "ru") {
  if (sourceLang === targetLang) return course;

  // Pre-flight check: is the translation server running?
  const available = await isTranslatorAvailable();
  if (!available) {
    console.warn(`[Translator] Translation server at ${TRANSLATOR_URL} is not available. Skipping translation.`);
    return course;
  }

  console.log(`[Translator] Translating course from ${sourceLang} to ${targetLang}...`);

  // Translate top level
  const topLevel = await translateTextArray([course.title || "", course.description || ""], sourceLang, targetLang);
  course.title = topLevel[0] || course.title;
  course.description = topLevel[1] || course.description;
  course.language = targetLang;

  // Translate modules and sections
  for (const mod of (course.modules || [])) {
    const modTitle = await translateTextArray([mod.title || ""], sourceLang, targetLang);
    mod.title = modTitle[0] || mod.title;

    for (const sec of (mod.sections || [])) {
      const secTitle = await translateTextArray([sec.title || ""], sourceLang, targetLang);
      sec.title = secTitle[0] || sec.title;

      for (const sco of (sec.scos || [])) {
        const scoTitle = await translateTextArray([sco.title || ""], sourceLang, targetLang);
        sco.title = scoTitle[0] || sco.title;

        // Translate screens
        for (const screen of (sco.screens || [])) {
          const screenTitle = await translateTextArray([screen.title || ""], sourceLang, targetLang);
          screen.title = screenTitle[0] || screen.title;

          if (screen.bodyLong) {
            const bodyLong = await translateTextArray([screen.bodyLong], sourceLang, targetLang);
            screen.bodyLong = bodyLong[0] || screen.bodyLong;
          }

          if (Array.isArray(screen.keyTakeaways) && screen.keyTakeaways.length > 0) {
            screen.keyTakeaways = await translateTextArray(screen.keyTakeaways, sourceLang, targetLang);
          }

          if (screen.practicalStep) {
            const practicalStep = await translateTextArray([screen.practicalStep], sourceLang, targetLang);
            screen.practicalStep = practicalStep[0] || screen.practicalStep;
          }

          // Translate blocks
          for (const block of (screen.blocks || [])) {
            if (block.text) {
              const bText = await translateTextArray([block.text], sourceLang, targetLang);
              block.text = bText[0] || block.text;
            }
            if (Array.isArray(block.items) && block.items.length > 0) {
              block.items = await translateTextArray(block.items, sourceLang, targetLang);
            }
            if (Array.isArray(block.columns) && block.columns.length > 0) {
              block.columns = await translateTextArray(block.columns, sourceLang, targetLang);
            }
            if (Array.isArray(block.rows) && block.rows.length > 0) {
              // Rows is an array of arrays. Translate each row individually.
              for (let r = 0; r < block.rows.length; r++) {
                if (Array.isArray(block.rows[r]) && block.rows[r].length > 0) {
                  block.rows[r] = await translateTextArray(block.rows[r], sourceLang, targetLang);
                }
              }
            }
          }
        }
      }
    }
  }

  // Translate final test
  if (course.finalTest && Array.isArray(course.finalTest.questions)) {
    const ftTitle = await translateTextArray([course.finalTest.title || ""], sourceLang, targetLang);
    course.finalTest.title = ftTitle[0] || course.finalTest.title;

    for (const q of course.finalTest.questions) {
      const qText = await translateTextArray([q.prompt || "", q.explanation || ""], sourceLang, targetLang);
      q.prompt = qText[0] || q.prompt;
      if (qText[1]) q.explanation = qText[1];

      if (Array.isArray(q.options)) {
        const optionTexts = q.options.map(o => o.text || "");
        const translatedOptions = await translateTextArray(optionTexts, sourceLang, targetLang);
        q.options.forEach((o, idx) => {
          o.text = translatedOptions[idx] || o.text;
        });
      }
    }
  }

  console.log(`[Translator] Translation completed.`);
  return course;
}
