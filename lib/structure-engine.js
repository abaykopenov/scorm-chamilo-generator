import { createId } from "./ids.js";
import { normalizeStructureSettings } from "./validation.js";

function clone(value) {
  return structuredClone(value);
}

function createScreen(screenIndex) {
  return {
    id: createId("screen"),
    title: `Экран ${screenIndex + 1}`,
    order: screenIndex + 1,
    blocks: [
      {
        type: "text",
        text: `Заполните содержимое для экрана ${screenIndex + 1}.`
      }
    ]
  };
}

function createSco(moduleIndex, sectionIndex, scoIndex, screensPerSco) {
  return {
    id: createId("sco"),
    title: `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
    order: scoIndex + 1,
    screens: Array.from({ length: screensPerSco }, (_, screenIndex) => createScreen(screenIndex))
  };
}

function createSection(moduleIndex, sectionIndex, structure) {
  return {
    id: createId("section"),
    title: `Раздел ${moduleIndex + 1}.${sectionIndex + 1}`,
    order: sectionIndex + 1,
    scos: Array.from({ length: structure.scosPerSection }, (_, scoIndex) =>
      createSco(moduleIndex, sectionIndex, scoIndex, structure.screensPerSco)
    )
  };
}

function createModule(moduleIndex, structure) {
  return {
    id: createId("module"),
    title: `Модуль ${moduleIndex + 1}`,
    order: moduleIndex + 1,
    sections: Array.from({ length: structure.sectionsPerModule }, (_, sectionIndex) =>
      createSection(moduleIndex, sectionIndex, structure)
    )
  };
}

export function rebuildCourseStructure(course, requestedStructure) {
  const structure = normalizeStructureSettings(requestedStructure);
  const currentCourse = clone(course);

  currentCourse.modules = Array.from({ length: structure.moduleCount }, (_, moduleIndex) => {
    const existingModule = currentCourse.modules[moduleIndex];
    const moduleValue = existingModule
      ? { ...existingModule }
      : createModule(moduleIndex, structure);

    moduleValue.order = moduleIndex + 1;
    moduleValue.title ||= `Модуль ${moduleIndex + 1}`;

    moduleValue.sections = Array.from({ length: structure.sectionsPerModule }, (_, sectionIndex) => {
      const existingSection = existingModule?.sections?.[sectionIndex];
      const sectionValue = existingSection
        ? { ...existingSection }
        : createSection(moduleIndex, sectionIndex, structure);

      sectionValue.order = sectionIndex + 1;
      sectionValue.title ||= `Раздел ${moduleIndex + 1}.${sectionIndex + 1}`;

      sectionValue.scos = Array.from({ length: structure.scosPerSection }, (_, scoIndex) => {
        const existingSco = existingSection?.scos?.[scoIndex];
        const scoValue = existingSco
          ? { ...existingSco }
          : createSco(moduleIndex, sectionIndex, scoIndex, structure.screensPerSco);

        scoValue.order = scoIndex + 1;
        scoValue.title ||= `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`;
        scoValue.screens = Array.from({ length: structure.screensPerSco }, (_, screenIndex) => {
          const existingScreen = existingSco?.screens?.[screenIndex];
          if (existingScreen) {
            return {
              ...existingScreen,
              order: screenIndex + 1,
              title: existingScreen.title || `Экран ${screenIndex + 1}`
            };
          }
          return createScreen(screenIndex);
        });

        return scoValue;
      });

      return sectionValue;
    });

    return moduleValue;
  });

  return currentCourse;
}
