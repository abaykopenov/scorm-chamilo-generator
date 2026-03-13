import { sendMessage } from "../api.mjs";
import { escapeMarkdown, errorMessage } from "../config.mjs";
import { getCourse } from "../../../lib/course-store.js";
import { exportCourseToScormArchive } from "../../../lib/scorm/exporter.js";
import { t } from "../i18n/index.mjs";

// Chamilo upload flow state per chat
const chamiloFlows = new Map();

export function getChamiloFlow(chatId) {
  return chamiloFlows.get(`${chatId}`);
}

export function clearChamiloFlow(chatId) {
  chamiloFlows.delete(`${chatId}`);
}

export async function startChamiloFlow(chatId, courseId) {
  chamiloFlows.set(`${chatId}`, { courseId, step: "url" });
  await sendMessage(chatId, t("chamiloPromptUrl"));
}

export async function handleChamiloFlowStep(chatId, text) {
  const flow = chamiloFlows.get(`${chatId}`);
  if (!flow) return false;

  const value = `${text || ""}`.trim();
  if (!value) return true;

  if (flow.step === "url") {
    // Validate URL
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

    await sendMessage(chatId, t("chamiloUploading"));

    try {
      const course = await getCourse(flow.courseId);
      if (!course) throw new Error("Курс не найден в системе. Возможно, он был удалён.");

      await sendMessage(chatId, `📦 Упаковываю SCORM...`);
      // When uploading to Chamilo, exclude the final test from SCORM package.
      // The test will be created as a native Chamilo exercise (interactive, with scoring).
      const courseForScorm = { ...course };
      if (courseForScorm.finalTest?.enabled) {
        courseForScorm.finalTest = { ...courseForScorm.finalTest, enabled: false };
      }
      const archive = await exportCourseToScormArchive(courseForScorm);

      await sendMessage(chatId, `🔐 Авторизация в Chamilo (${escapeMarkdown(flow.url)})...`);

      // Use the real Chamilo upload API
      const { uploadScormToChamilo } = await import("../../../lib/chamilo/upload-helpers.js");

      const result = await uploadScormToChamilo({
        zipBuffer: archive.zipBuffer,
        fileName: archive.fileName,
        profile: {
          baseUrl: flow.url,
          username: flow.username,
          password: flow.password,
          courseCode: flow.courseCode
        }
      });

      if (result.ok) {
        const lpInfo = result.lpId ? `\nLP ID: <code>${escapeMarkdown(result.lpId)}</code>` : "";
        await sendMessage(chatId,
          `✅ <b>SCORM успешно загружен в Chamilo!</b>\n\n` +
          `📍 Курс: <code>${escapeMarkdown(flow.courseCode)}</code>\n` +
          `📁 Файл: <code>${escapeMarkdown(archive.fileName)}</code>${lpInfo}`
        );

        // ═══════ Create native Chamilo exercise from finalTest ═══════
        const finalTest = course?.finalTest;
        const testQuestions = Array.isArray(finalTest?.questions) ? finalTest.questions : [];
        if (finalTest?.enabled && testQuestions.length > 0) {
          try {
            await sendMessage(chatId, `📝 Создаю тест (${testQuestions.length} вопросов) как упражнение Chamilo...`);

            const { createFinalTestExerciseInChamilo, findLatestLpId, addExerciseToLearningPath } = await import("../../../lib/chamilo/test-helpers.js");

            const profile = {
              baseUrl: flow.url,
              username: flow.username,
              password: flow.password,
              courseCode: flow.courseCode
            };

            // Map generated questions to Chamilo format
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

              // Link exercise to Learning Path
              const uploadLpId = result.lpId;
              console.log(`[chamilo] Upload result lpId: ${uploadLpId || "NOT FOUND"}`);
              const lpId = uploadLpId || await findLatestLpId({ profile, cookieJar: testResult._cookieJar });
              console.log(`[chamilo] Using LP ID: ${lpId} (source: ${uploadLpId ? "upload" : "findLatest"})`);
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
          `💡 Проверьте вручную: ${escapeMarkdown(flow.url)}/main/newscorm/lp_controller.php?cidReq=${escapeMarkdown(flow.courseCode)}`
        );
      }
    } catch (err) {
      const msg = errorMessage(err, "Неизвестная ошибка");
      const hint = msg.includes("username") || msg.includes("password")
        ? "\n\n💡 Проверьте логин/пароль Chamilo."
        : msg.includes("upload form")
          ? "\n\n💡 Убедитесь, что код курса верный и у вас есть права на загрузку SCORM."
          : "";
      await sendMessage(chatId, `❌ <b>Ошибка загрузки в Chamilo:</b>\n\n${escapeMarkdown(msg)}${hint}`);
    } finally {
      chamiloFlows.delete(`${chatId}`);
    }
    return true;
  }

  return false;
}
