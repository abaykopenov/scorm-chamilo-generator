export function CourseContentAccordion({
  course,
  updateCourse,
  regenerateModule,
  regenerateScreen,
  regenerationTarget,
  isPending
}) {
  return (
    <details className="accordion-panel" open>
      <summary>
        <span>Содержимое курса</span>
        <small>Модули открываются по клику</small>
      </summary>
      <div className="accordion-body">
        <div className="tree compact-tree">
          {course.modules.map((moduleItem, moduleIndex) => (
            <details className="nested-accordion module-accordion" key={moduleItem.id} open={moduleIndex === 0}>
              <summary>
                <span>{moduleItem.title || `Модуль ${moduleIndex + 1}`}</span>
                <small>{moduleItem.sections.length} разделов</small>
              </summary>
              <div className="accordion-body stack">
                <div className="field">
                  <label htmlFor={`module-title-${moduleIndex}`}>Название модуля</label>
                  <input
                    id={`module-title-${moduleIndex}`}
                    value={moduleItem.title}
                    onChange={(event) => updateCourse((draft) => {
                      draft.modules[moduleIndex].title = event.target.value;
                    })}
                  />
                </div>
                <div className="actions">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => regenerateModule(moduleIndex)}
                    disabled={isPending || Boolean(regenerationTarget)}
                  >
                    {regenerationTarget === "module:" + moduleIndex ? "Regenerating module..." : "Regenerate this module"}
                  </button>
                </div>
                {moduleItem.sections.map((sectionItem, sectionIndex) => (
                  <details className="nested-accordion" key={sectionItem.id}>
                    <summary>
                      <span>{sectionItem.title || `Раздел ${moduleIndex + 1}.${sectionIndex + 1}`}</span>
                      <small>{sectionItem.scos.length} SCO</small>
                    </summary>
                    <div className="accordion-body stack">
                      <div className="field">
                        <label htmlFor={`section-title-${moduleIndex}-${sectionIndex}`}>Название раздела</label>
                        <input
                          id={`section-title-${moduleIndex}-${sectionIndex}`}
                          value={sectionItem.title}
                          onChange={(event) => updateCourse((draft) => {
                            draft.modules[moduleIndex].sections[sectionIndex].title = event.target.value;
                          })}
                        />
                      </div>
                      {sectionItem.scos.map((sco, scoIndex) => (
                        <details className="nested-accordion" key={sco.id}>
                          <summary>
                            <span>{sco.title || `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`}</span>
                            <small>{sco.screens.length} экранов</small>
                          </summary>
                          <div className="accordion-body stack">
                            <div className="field">
                              <label htmlFor={`sco-title-${moduleIndex}-${sectionIndex}-${scoIndex}`}>Название SCO</label>
                              <input
                                id={`sco-title-${moduleIndex}-${sectionIndex}-${scoIndex}`}
                                value={sco.title}
                                onChange={(event) => updateCourse((draft) => {
                                  draft.modules[moduleIndex].sections[sectionIndex].scos[scoIndex].title = event.target.value;
                                })}
                              />
                            </div>
                            {sco.screens.map((screen, screenIndex) => (
                              <details className="nested-accordion" key={screen.id}>
                                <summary>
                                  <span>{screen.title || `Экран ${screenIndex + 1}`}</span>
                                  <small>редактирование контента</small>
                                </summary>
                                <div className="accordion-body">
                                  <div className="field">
                                    <label htmlFor={`screen-title-${moduleIndex}-${sectionIndex}-${scoIndex}-${screenIndex}`}>Название экрана</label>
                                    <input
                                      id={`screen-title-${moduleIndex}-${sectionIndex}-${scoIndex}-${screenIndex}`}
                                      value={screen.title}
                                      onChange={(event) => updateCourse((draft) => {
                                        draft.modules[moduleIndex].sections[sectionIndex].scos[scoIndex].screens[screenIndex].title = event.target.value;
                                      })}
                                    />
                                  </div>
                                  <div className="field">
                                    <label htmlFor={`screen-text-${moduleIndex}-${sectionIndex}-${scoIndex}-${screenIndex}`}>Текст экрана</label>
                                    <textarea
                                      id={`screen-text-${moduleIndex}-${sectionIndex}-${scoIndex}-${screenIndex}`}
                                      value={screen.blocks[0]?.text ?? ""}
                                      onChange={(event) => updateCourse((draft) => {
                                        draft.modules[moduleIndex].sections[sectionIndex].scos[scoIndex].screens[screenIndex].blocks[0] = {
                                          type: "text",
                                          text: event.target.value
                                        };
                                      })}
                                    />
                                  </div>
                                  <div className="actions">
                                    <button
                                      className="ghost-button"
                                      type="button"
                                      onClick={() => regenerateScreen(moduleIndex, sectionIndex, scoIndex, screenIndex)}
                                      disabled={isPending || Boolean(regenerationTarget)}
                                    >
                                      {regenerationTarget === ["screen", moduleIndex, sectionIndex, scoIndex, screenIndex].join(":")
                                        ? "Regenerating screen..."
                                        : "Regenerate this screen"}
                                    </button>
                                  </div>
                                </div>
                              </details>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          ))}
        </div>
      </div>
    </details>
  );
}
