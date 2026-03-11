import { cleanNarrativeText } from "./text-utils.js";
import { 
  looksCorruptedNarrative, 
  looksTechnicalNoise 
} from "./quality-check.js";

export function isPlaceholderTitle(value) {
  const text = cleanNarrativeText(value, 120);
  if (!text) {
    return true;
  }
  return /^(screen|topic|module|section|sco)\b/i.test(text)
    || /^\u044d\u043a\u0440\u0430\u043d\b/i.test(text)
    || /\b\d+(?:\.\d+){0,5}\b/.test(text);
}

export function isWeakHierarchyTitle(value) {
  const normalized = cleanNarrativeText(value, 120).toLowerCase();
  if (!normalized) {
    return true;
  }
  return isPlaceholderTitle(normalized)
    || looksCorruptedNarrative(normalized)
    || looksTechnicalNoise(normalized)
    || /\|\s*(module|section|sco)\s*\d+/i.test(normalized)
    || /^(?:module|section|sco)\s*\d+/i.test(normalized)
    || /^(?:\u043c\u043e\u0434\u0443\u043b\u044c|\u0440\u0430\u0437\u0434\u0435\u043b)\s*\d+(?:\.\d+){0,3}$/i.test(normalized);
}

export function normalizeHierarchyTitles(modules, courseTitle) {
  const fallbackTopic = cleanNarrativeText(courseTitle || "Тема курса", 120)
    || "Тема курса";

  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const moduleItem = modules[moduleIndex];
    const moduleRaw = cleanNarrativeText(moduleItem?.title || "", 140);
    const moduleFallback = `Модуль ${moduleIndex + 1}: ${fallbackTopic}`;
    moduleItem.title = isWeakHierarchyTitle(moduleRaw) ? moduleFallback : moduleRaw;

    const sections = Array.isArray(moduleItem?.sections) ? moduleItem.sections : [];
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      const section = sections[sectionIndex];
      const sectionRaw = cleanNarrativeText(section?.title || "", 120);
      const sectionFallback = `Раздел ${moduleIndex + 1}.${sectionIndex + 1}`;
      section.title = isWeakHierarchyTitle(sectionRaw) ? sectionFallback : sectionRaw;

      const scos = Array.isArray(section?.scos) ? section.scos : [];
      for (let scoIndex = 0; scoIndex < scos.length; scoIndex += 1) {
        const sco = scos[scoIndex];
        const scoRaw = cleanNarrativeText(sco?.title || "", 120);
        const scoFallback = `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`;
        sco.title = isWeakHierarchyTitle(scoRaw) ? scoFallback : scoRaw;

        const screens = Array.isArray(sco?.screens) ? sco.screens : [];
        for (let screenIndex = 0; screenIndex < screens.length; screenIndex += 1) {
          const screen = screens[screenIndex];
          const screenRaw = cleanNarrativeText(screen?.title || "", 120);
          const screenFallback = `Экран ${screenIndex + 1}`;
          screen.title = isWeakHierarchyTitle(screenRaw) ? screenFallback : screenRaw;
        }
      }
    }
  }
}

