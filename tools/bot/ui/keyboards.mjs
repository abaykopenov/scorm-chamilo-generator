import { t } from "../i18n/index.mjs";
import { GENERATION_MODEL } from "../config.mjs";

export function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: t("kbCreateCourse") }, { text: t("kbCreateQuiz") }],
        [{ text: t("kbMyFiles") }, { text: t("kbMyCourses") }],
        [{ text: t("kbSettings") }, { text: t("kbHelp") }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

export function afterUploadKeyboard(fileName) {
  const short = `${fileName || ""}`.slice(0, 30);
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: t("btnCreateCourse"), callback_data: `create_course^${short}` }],
        [{ text: t("btnCreateQuiz"), callback_data: `create_quiz^${short}` }],
        [{ text: t("btnClearMaterials"), callback_data: "clear_materials" }]
      ]
    }
  };
}

export function courseSettingsKeyboard(settings, topic) {
  const s = settings;
  const safeTopic = `${topic || ""}`.slice(0, 18);
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "◀️", callback_data: `cfg_dec^moduleCount^${safeTopic}` },
          { text: `📦 Модулей: ${s.moduleCount}`, callback_data: "noop" },
          { text: "▶️", callback_data: `cfg_inc^moduleCount^${safeTopic}` }
        ],
        [
          { text: "◀️", callback_data: `cfg_dec^sectionsPerModule^${safeTopic}` },
          { text: `📑 Разделов: ${s.sectionsPerModule}`, callback_data: "noop" },
          { text: "▶️", callback_data: `cfg_inc^sectionsPerModule^${safeTopic}` }
        ],
        [
          { text: "◀️", callback_data: `cfg_dec^screensPerSco^${safeTopic}` },
          { text: `⏱ Экранов: ${s.screensPerSco || 2}`, callback_data: "noop" },
          { text: "▶️", callback_data: `cfg_inc^screensPerSco^${safeTopic}` }
        ],
        [
          { text: "◀️", callback_data: `cfg_dec^questionCount^${safeTopic}` },
          { text: `❓ Вопросов: ${s.questionCount}`, callback_data: "noop" },
          { text: "▶️", callback_data: `cfg_inc^questionCount^${safeTopic}` }
        ],
        [
          { text: "◀️", callback_data: `cfg_dec^passingScore^${safeTopic}` },
          { text: `🎯 Балл: ${s.passingScore}%`, callback_data: "noop" },
          { text: "▶️", callback_data: `cfg_inc^passingScore^${safeTopic}` }
        ],
        [
          { text: "◀️", callback_data: `cfg_lang^${safeTopic}` },
          { text: `🌐 Язык: ${s.outputLanguage === "ru" ? "🇷🇺 Рус" : s.outputLanguage === "kk" ? "🇰🇿 Каз" : s.outputLanguage === "en" ? "🇬🇧 Англ" : "🔄 Авто"}`, callback_data: "noop" },
          { text: "▶️", callback_data: `cfg_lang^${safeTopic}` }
        ],
        [
          { text: t("settingsStart"), callback_data: `cfg_go^${safeTopic}` },
          { text: t("settingsCancel"), callback_data: "cfg_cancel" }
        ]
      ]
    }
  };
}

export function profileSettingsKeyboard(settings, modelName, cloudProvider) {
  const s = settings;
  const cloudLabel = cloudProvider ? `☁️ ${cloudProvider.toUpperCase()}` : "💻 Ollama";
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🎓 Аудитория", callback_data: "profile_audience" },
          { text: "📝 Стиль", callback_data: "profile_style" }
        ],
        [
          { text: "🤖 Модель", callback_data: "profile_model" },
          { text: "🌐 Язык", callback_data: "profile_lang" }
        ],
        [
          { text: `☁️ Провайдер: ${cloudLabel}`, callback_data: "profile_cloud" }
        ],
        [
          { text: "📚 Материалы", callback_data: "profile_mats" },
          { text: "🔗 URL", callback_data: "profile_url" }
        ]
      ]
    }
  };
}

export function courseActionsKeyboard(courseId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: t("btnPreview"), callback_data: `prev_${courseId}_0` },
          { text: t("btnSendChamilo"), callback_data: `chamilo_${courseId}` }
        ],
        [
          { text: "📥 ZIP", callback_data: `dl_${courseId}` },
          { text: "📄 PDF", callback_data: `dlpdf_${courseId}` },
          { text: "📊 PPTX", callback_data: `dlpptx_${courseId}` }
        ]
      ]
    }
  };
}

export function courseListKeyboard(courses) {
  const rows = courses.slice(0, 10).map(c => ([
    { text: `📄 ${`${c.title || "Без названия"}`.slice(0, 32)}`, callback_data: `prev_${c.id}_0` },
    { text: "📥", callback_data: `dl_${c.id}` }
  ]));
  return { reply_markup: { inline_keyboard: rows } };
}

export function navigationKeyboard(courseId, index, total) {
  const navRow = [];
  if (index > 0) navRow.push({ text: "⬅️ Назад", callback_data: `prev_${courseId}_${index - 1}` });
  navRow.push({ text: `${index + 1}/${total}`, callback_data: "noop" });
  if (index < total - 1) navRow.push({ text: "Вперед ➡️", callback_data: `prev_${courseId}_${index + 1}` });

  const actionsRow = [
    { text: "📥 ZIP", callback_data: `dl_${courseId}` },
    { text: "📄 PDF", callback_data: `dlpdf_${courseId}` },
    { text: "📊 PPTX", callback_data: `dlpptx_${courseId}` }
  ];
  const extraRow = [
    { text: "📤 Chamilo", callback_data: `chamilo_${courseId}` },
    { text: "🗑", callback_data: `delbtn_${courseId}` }
  ];

  const rows = [];
  if (navRow.length > 0) rows.push(navRow);
  rows.push(actionsRow);
  rows.push(extraRow);
  return rows.length > 0 ? JSON.stringify({ inline_keyboard: rows }) : null;
}
