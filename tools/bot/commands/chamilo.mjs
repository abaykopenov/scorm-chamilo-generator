import { sendMessage } from "../api.mjs";
import { escapeMarkdown, errorMessage } from "../config.mjs";
import { getCourse } from "../../../lib/course-store.js";
import { exportCourseToScormArchive } from "../../../lib/scorm/exporter.js";
import { t } from "../i18n/index.mjs";
import { getChamiloProfile, setChamiloProfile, clearChamiloProfile, addChamiloProfile, getChamiloProfiles, switchChamiloProfile, saveState } from "../state.mjs";

// Chamilo upload flow state per chat
const chamiloFlows = new Map();

export function getChamiloFlow(chatId) {
  return chamiloFlows.get(`${chatId}`);
}

export function clearChamiloFlow(chatId) {
  chamiloFlows.delete(`${chatId}`);
}

/**
 * Start Chamilo upload flow. If saved profile exists, skip prompts.
 */
export async function startChamiloFlow(chatId, courseId) {
  const saved = getChamiloProfile(chatId);

  if (saved && saved.baseUrl && saved.username && saved.password && saved.courseCode) {
    // Auto-upload using saved profile
    await sendMessage(chatId,
      `📤 Авто-загрузка в Chamilo...\n` +
      `📍 ${escapeMarkdown(saved.baseUrl)}\n` +
      `👤 ${escapeMarkdown(saved.username)}\n` +
      `📁 Курс: ${escapeMarkdown(saved.courseCode)}`
    );
    await performChamiloUpload(chatId, courseId, saved);
    return;
  }

  // No saved profile — start interactive flow
  chamiloFlows.set(`${chatId}`, { courseId, step: "url" });
  await sendMessage(chatId, t("chamiloPromptUrl"));
}

/**
 * Handle Chamilo settings command — show/edit/delete profile.
 */
export async function handleChamiloSettings(chatId) {
  const saved = getChamiloProfile(chatId);
  const allProfiles = getChamiloProfiles(chatId);
  
  if (saved) {
    const masked = saved.password ? "••••" + saved.password.slice(-2) : "(не задан)";
    
    // Build profile list buttons
    const profileButtons = allProfiles.length > 1
      ? allProfiles.map((p, i) => {
          const isActive = p.baseUrl === saved.baseUrl && p.username === saved.username;
          return { text: `${isActive ? "✅" : "⬜"} ${p.username}@${(p.baseUrl || "").replace(/https?:\/\//, "").slice(0, 20)}`, callback_data: `chm_switch_${i}` };
        })
      : [];

    const rows = [];
    // Profile switcher row (max 3 per row)
    for (let i = 0; i < profileButtons.length; i += 2) {
      rows.push(profileButtons.slice(i, i + 2));
    }
    rows.push([
      { text: "🌐 URL", callback_data: "chm_set_url" },
      { text: "👤 Логин", callback_data: "chm_set_user" }
    ]);
    rows.push([
      { text: "🔑 Пароль", callback_data: "chm_set_pass" },
      { text: "📁 Курс", callback_data: "chm_set_course" }
    ]);
    rows.push([{ text: "➕ Добавить профиль", callback_data: "chamilo_edit" }]);
    rows.push([{ text: "🗑 Удалить активный", callback_data: "chamilo_delete" }]);

    await sendMessage(chatId,
      `⚙️ <b>Настройки Chamilo</b>` +
      (allProfiles.length > 1 ? ` (${allProfiles.length} профилей)` : "") + `\n\n` +
      `🌐 URL: <code>${escapeMarkdown(saved.baseUrl || "(не задан)")}</code>\n` +
      `👤 Логин: <code>${escapeMarkdown(saved.username || "(не задан)")}</code>\n` +
      `🔑 Пароль: <code>${masked}</code>\n` +
      `📁 Код курса: <code>${escapeMarkdown(saved.courseCode || "(не задан)")}</code>\n\n` +
      `Нажмите чтобы изменить:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  } else {
    await sendMessage(chatId,
      `⚙️ <b>Chamilo не настроен</b>\n\n` +
      `Профиль будет сохранён автоматически при первой загрузке.\n` +
      `Или настройте вручную:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Настроить Chamilo", callback_data: "chamilo_edit" }]
          ]
        }
      }
    );
  }
}

export async function handleChamiloFlowStep(chatId, text) {
  const flow = chamiloFlows.get(`${chatId}`);
  if (!flow) return false;

  const value = `${text || ""}`.trim();
  if (!value) return true;

  if (flow.step === "url") {
    let url = value;
    if (!url.startsWith("http")) url = `https://${url}`;
    try { new URL(url); } catch {
      await sendMessage(chatId, "⚠️ Некорректный URL. Введите адрес Chamilo (например: https://lms.university.edu):");
      return true;
    }
    flow.url = url.replace(/\/$/, "");
    flow.step = "user";
    await sendMessage(chatId, t("chamiloPromptUser"));
    return true;
  }

  if (flow.step === "user") {
    flow.username = value;
    flow.step = "pass";
    await sendMessage(chatId, t("chamiloPromptPass"));
    return true;
  }

  if (flow.step === "pass") {
    flow.password = value;
    flow.step = "course";
    await sendMessage(chatId, t("chamiloPromptCourse"));
    return true;
  }

  if (flow.step === "course") {
    flow.courseCode = value;
    flow.step = "uploading";

    const profile = {
      baseUrl: flow.url,
      username: flow.username,
      password: flow.password,
      courseCode: flow.courseCode
    };

    // Save profile to profiles list AND set as active
    addChamiloProfile(chatId, profile);
    await saveState();
    await sendMessage(chatId, `💾 Профиль Chamilo сохранён. В следующий раз загрузка будет автоматической.`);

    await performChamiloUpload(chatId, flow.courseId, profile);
    chamiloFlows.delete(`${chatId}`);
    return true;
  }

  // Setup flow (from settings)
  if (flow.step === "setup_url") {
    let url = value;
    if (!url.startsWith("http")) url = `https://${url}`;
    try { new URL(url); } catch {
      await sendMessage(chatId, "⚠️ Некорректный URL:");
      return true;
    }
    flow.url = url.replace(/\/$/, "");
    flow.step = "setup_user";
    await sendMessage(chatId, "👤 Введите логин Chamilo:");
    return true;
  }

  if (flow.step === "setup_user") {
    flow.username = value;
    flow.step = "setup_pass";
    await sendMessage(chatId, "🔑 Введите пароль Chamilo:");
    return true;
  }

  if (flow.step === "setup_pass") {
    flow.password = value;
    flow.step = "setup_course";
    await sendMessage(chatId, "📁 Введите код курса Chamilo (cidReq):");
    return true;
  }

  if (flow.step === "setup_course") {
    flow.courseCode = value;
    addChamiloProfile(chatId, {
      baseUrl: flow.url,
      username: flow.username,
      password: flow.password,
      courseCode: flow.courseCode
    });
    await saveState();
    chamiloFlows.delete(`${chatId}`);
    await sendMessage(chatId,
      `✅ <b>Профиль Chamilo сохранён!</b>\n\n` +
      `🌐 ${escapeMarkdown(flow.url)}\n` +
      `👤 ${escapeMarkdown(flow.username)}\n` +
      `📁 ${escapeMarkdown(flow.courseCode)}\n\n` +
      `Теперь загрузка будет автоматической.`
    );
    return true;
  }

  // Single field edit flow
  if (flow.step === "field_edit") {
    const field = flow.field;
    const current = getChamiloProfile(chatId) || {};

    if (field === "url") {
      let url = value;
      if (!url.startsWith("http")) url = `https://${url}`;
      try { new URL(url); } catch {
        await sendMessage(chatId, "⚠️ Некорректный URL. Попробуйте ещё раз:");
        return true;
      }
      current.baseUrl = url.replace(/\/$/, "");
    } else if (field === "username") {
      current.username = value;
    } else if (field === "password") {
      current.password = value;
    } else if (field === "courseCode") {
      current.courseCode = value;
    }

    setChamiloProfile(chatId, current);
    await saveState();
    chamiloFlows.delete(`${chatId}`);

    const labels = { url: "URL", username: "Логин", password: "Пароль", courseCode: "Код курса" };
    await sendMessage(chatId,
      `✅ ${labels[field] || field} обновлён!\n\n` +
      `Используйте /chamilo для просмотра настроек.`
    );
    return true;
  }

  return false;
}

/**
 * Start setup flow (from settings button).
 */
export function startChamiloSetup(chatId) {
  chamiloFlows.set(`${chatId}`, { step: "setup_url" });
}

/**
 * Start single-field edit flow.
 */
export function startChamiloFieldEdit(chatId, field) {
  chamiloFlows.set(`${chatId}`, { step: "field_edit", field });
}

/**
 * Delete saved Chamilo profile.
 */
export async function deleteChamiloProfile(chatId) {
  clearChamiloProfile(chatId);
  await saveState();
  await sendMessage(chatId, "🗑 Профиль Chamilo удалён.");
}

/**
 * Perform the actual SCORM upload to Chamilo.
 */
async function performChamiloUpload(chatId, courseId, profile) {
  try {
    const course = await getCourse(courseId);
    if (!course) throw new Error("Курс не найден в системе. Возможно, он был удалён.");

    await sendMessage(chatId, `📦 Упаковываю SCORM...`);
    const courseForScorm = { ...course };
    if (courseForScorm.finalTest?.enabled) {
      courseForScorm.finalTest = { ...courseForScorm.finalTest, enabled: false };
    }
    const archive = await exportCourseToScormArchive(courseForScorm);

    await sendMessage(chatId, `🔐 Авторизация в Chamilo (${escapeMarkdown(profile.baseUrl)})...`);

    const { uploadScormToChamilo } = await import("../../../lib/chamilo/upload-helpers.js");

    const result = await uploadScormToChamilo({
      zipBuffer: archive.zipBuffer,
      fileName: archive.fileName,
      profile: {
        baseUrl: profile.baseUrl,
        username: profile.username,
        password: profile.password,
        courseCode: profile.courseCode
      }
    });

    if (result.ok) {
      const lpInfo = result.lpId ? `\nLP ID: <code>${escapeMarkdown(result.lpId)}</code>` : "";
      await sendMessage(chatId,
        `✅ <b>SCORM успешно загружен в Chamilo!</b>\n\n` +
        `📍 Курс: <code>${escapeMarkdown(profile.courseCode)}</code>\n` +
        `📁 Файл: <code>${escapeMarkdown(archive.fileName)}</code>${lpInfo}`
      );

      // ═══ Create native Chamilo exercise from finalTest ═══
      const finalTest = course?.finalTest;
      const testQuestions = Array.isArray(finalTest?.questions) ? finalTest.questions : [];
      if (finalTest?.enabled && testQuestions.length > 0) {
        try {
          await sendMessage(chatId, `📝 Создаю тест (${testQuestions.length} вопросов) как упражнение Chamilo...`);

          const { createFinalTestExerciseInChamilo, findLatestLpId, addExerciseToLearningPath } = await import("../../../lib/chamilo/test-helpers.js");

          const chamiloQuestions = testQuestions.map((q, i) => ({
            prompt: q.prompt || q.text || `Вопрос ${i + 1}`,
            options: Array.isArray(q.options) ? q.options.map(opt => typeof opt === "string" ? opt : (opt?.text || opt?.label || "")) : [],
            correctIndex: Number.isFinite(q.correctOptionIndex) ? q.correctOptionIndex : (Number.isFinite(q.correctIndex) ? q.correctIndex : 0)
          }));

          const testResult = await createFinalTestExerciseInChamilo({
            profile,
            finalTest: {
              enabled: true,
              title: `${course.title || "Курс"} — Финальный тест`,
              attemptsLimit: finalTest.attemptsLimit || 3,
              passingScore: finalTest.passingScore || 80,
              questions: chamiloQuestions
            },
            courseTitle: course.title
          });

          if (testResult.ok && testResult.exerciseId) {
            await sendMessage(chatId,
              `✅ <b>Тест создан!</b>\n` +
              `Exercise ID: <code>${testResult.exerciseId}</code>\n` +
              `Вопросов: ${testResult.questionCount}`
            );

            const uploadLpId = result.lpId;
            const lpId = uploadLpId || await findLatestLpId({ profile, cookieJar: testResult._cookieJar });
            if (lpId) {
              try {
                const linkResult = await addExerciseToLearningPath({
                  profile,
                  lpId,
                  exerciseId: testResult.exerciseId,
                  exerciseTitle: `${course.title || "Курс"} — Финальный тест`,
                  cookieJar: testResult._cookieJar
                });
                if (linkResult.ok) {
                  await sendMessage(chatId, `🔗 Тест привязан к учебной траектории (LP ID: ${lpId}).`);
                } else {
                  await sendMessage(chatId,
                    `⚠️ Тест создан, но привязка к LP не подтверждена.\n` +
                    `💡 Привяжите вручную: Chamilo → Курс → Учебные траектории → Добавить упражнение.`
                  );
                }
              } catch (lpErr) {
                await sendMessage(chatId,
                  `⚠️ Тест создан (ID: ${testResult.exerciseId}), но привязка к LP не удалась:\n${escapeMarkdown(lpErr?.message || "unknown")}\n` +
                  `💡 Привяжите вручную в Chamilo.`
                );
              }
            } else {
              await sendMessage(chatId,
                `⚠️ Тест создан (ID: ${testResult.exerciseId}), но LP ID не найден.\n` +
                `💡 Привяжите тест к учебной траектории вручную в Chamilo.`
              );
            }
          } else {
            await sendMessage(chatId,
              `⚠️ Не удалось создать тест в Chamilo: ${escapeMarkdown(testResult.message || "unknown")}`
            );
          }
        } catch (testErr) {
          await sendMessage(chatId,
            `⚠️ SCORM загружен, но создание теста не удалось:\n${escapeMarkdown(testErr?.message || "unknown")}\n\n` +
            `💡 Создайте тест вручную в Chamilo через «Упражнения».`
          );
        }
      }
    } else {
      await sendMessage(chatId,
        `⚠️ <b>Chamilo ответил, но импорт не подтверждён:</b>\n\n` +
        `${escapeMarkdown(result.message || "Нет подтверждения от Chamilo.")}\n\n` +
        `💡 Проверьте вручную: ${escapeMarkdown(profile.baseUrl)}/main/newscorm/lp_controller.php?cidReq=${escapeMarkdown(profile.courseCode)}`
      );
    }
  } catch (err) {
    const msg = errorMessage(err, "Неизвестная ошибка");
    const hint = msg.includes("username") || msg.includes("password")
      ? "\n\n💡 Проверьте логин/пароль. Попробуйте /chamilo_settings"
      : msg.includes("upload form")
        ? "\n\n💡 Убедитесь, что код курса верный и у вас есть права на загрузку SCORM."
        : "";
    await sendMessage(chatId, `❌ <b>Ошибка загрузки в Chamilo:</b>\n\n${escapeMarkdown(msg)}${hint}`);
  }
}
