function escapeHtml(value) {
  return `${value}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

function htmlPage({ title, heading, payload }) {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="../assets/style.css" />
  </head>
  <body>
    <main class="shell">
      <header class="runtime-header">
        <span class="runtime-badge">SCORM 1.2</span>
        <h1>${escapeHtml(heading)}</h1>
      </header>
      <section id="app"></section>
    </main>
    <script>window.SCORM_RUNTIME = ${safeJson(payload)};</script>
    <script src="../assets/runtime.js"></script>
  </body>
</html>`;
}

export function createRuntimeAssets(course) {
  return [
    {
      name: "assets/style.css",
      content: `:root {
  --bg: #f2ede4;
  --surface: rgba(255,255,255,0.92);
  --line: rgba(38,20,13,0.12);
  --ink: #26140d;
  --muted: #6c564a;
  --accent: #af3d1e;
  --accent-strong: #8e2e14;
  --success: #256f49;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: linear-gradient(160deg, #f5efe6, #eadac4);
  color: var(--ink);
  font-family: "Avenir Next", "Segoe UI", sans-serif;
}
.shell {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px;
}
.runtime-header {
  margin-bottom: 20px;
}
.runtime-badge {
  display: inline-flex;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(175,61,30,0.12);
  color: var(--accent-strong);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1, h2, h3 { font-family: "Iowan Old Style", Georgia, serif; }
.card {
  padding: 22px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: 0 20px 50px rgba(61,33,17,0.1);
}
.screen-meta,
.status {
  color: var(--muted);
}
.nav {
  display: flex;
  gap: 12px;
  margin-top: 20px;
  flex-wrap: wrap;
}
button {
  min-height: 42px;
  border-radius: 999px;
  border: none;
  padding: 0 16px;
  background: linear-gradient(180deg, var(--accent), var(--accent-strong));
  color: #fff;
  font: inherit;
  cursor: pointer;
}
button.secondary {
  background: rgba(255,255,255,0.84);
  color: var(--ink);
  border: 1px solid var(--line);
}
.result.ok { color: var(--success); }
.question {
  display: grid;
  gap: 10px;
  padding: 16px 0;
  border-bottom: 1px solid rgba(38,20,13,0.08);
}
.question:last-child { border-bottom: none; }
.option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.timer {
  display: inline-flex;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(38,20,13,0.06);
}
a { color: var(--accent-strong); }`
    },
    {
      name: "assets/runtime.js",
      content: `(function () {
  var runtime = window.SCORM_RUNTIME;
  var state = { startedAt: Date.now(), finished: false };

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function createFallbackApi() {
    var storage = window.sessionStorage;
    return {
      LMSInitialize: function () { return "true"; },
      LMSFinish: function () { return "true"; },
      LMSGetValue: function (key) { return storage.getItem(key) || ""; },
      LMSSetValue: function (key, value) { storage.setItem(key, value); return "true"; },
      LMSCommit: function () { return "true"; },
      LMSGetLastError: function () { return "0"; }
    };
  }

  function findApi(win) {
    var tries = 0;
    while (win && tries < 12) {
      if (win.API) return win.API;
      tries += 1;
      if (win.parent && win.parent !== win) {
        win = win.parent;
      } else {
        break;
      }
    }
    return null;
  }

  var api = findApi(window) || findApi(window.opener) || createFallbackApi();

  function init() {
    try { api.LMSInitialize(""); } catch (error) { console.warn(error); }
  }

  function finish() {
    if (state.finished) return;
    state.finished = true;
    setValue("cmi.core.session_time", formatSessionTime(Date.now() - state.startedAt));
    commit();
    try { api.LMSFinish(""); } catch (error) { console.warn(error); }
  }

  function getValue(key) {
    try { return api.LMSGetValue(key) || ""; } catch (error) { return ""; }
  }

  function setValue(key, value) {
    try { api.LMSSetValue(key, String(value)); } catch (error) { console.warn(error); }
  }

  function commit() {
    try { api.LMSCommit(""); } catch (error) { console.warn(error); }
  }

  function formatSessionTime(milliseconds) {
    var totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    var hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    var minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    var seconds = String(totalSeconds % 60).padStart(2, "0");
    return hours + ":" + minutes + ":" + seconds;
  }

  function readSuspendData() {
    var raw = getValue("cmi.suspend_data");
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (error) { return {}; }
  }

  function writeSuspendData(value) {
    setValue("cmi.suspend_data", JSON.stringify(value));
    commit();
  }

  function createCard(innerHtml) {
    var app = document.getElementById("app");
    app.innerHTML = '<div class="card">' + innerHtml + "</div>";
    return app;
  }

  function renderBlocks(blocks) {
    return blocks.map(function (block) {
      if (block.type === "note") {
        return '<p class="status"><strong>Примечание:</strong> ' + escapeHtml(block.text) + "</p>";
      }
      if (block.type === "list") {
        return "<ul>" + block.items.map(function (item) { return "<li>" + escapeHtml(item) + "</li>"; }).join("") + "</ul>";
      }
      if (block.type === "image" && block.src) {
        return '<figure><img alt="' + escapeHtml(block.alt || "") + '" src="' + escapeHtml(block.src) + '" style="max-width:100%;border-radius:14px;" /></figure>';
      }
      return "<p>" + escapeHtml(block.text) + "</p>";
    }).join("");
  }

  function renderContentSco() {
    var screens = runtime.screens || [];
    var currentIndex = Number(getValue("cmi.core.lesson_location") || 0);
    if (!Number.isFinite(currentIndex) || currentIndex < 0 || currentIndex >= screens.length) {
      currentIndex = 0;
    }

    function saveIndex(nextIndex) {
      setValue("cmi.core.lesson_location", nextIndex);
      if (nextIndex >= screens.length - 1) {
        setValue("cmi.core.lesson_status", "completed");
      } else if (!getValue("cmi.core.lesson_status")) {
        setValue("cmi.core.lesson_status", "incomplete");
      }
      commit();
    }

    function draw() {
      var screen = screens[currentIndex];
      createCard(
        '<div class="screen-meta">SCO ' + escapeHtml(runtime.title) + " • Экран " + (currentIndex + 1) + " / " + screens.length + '</div>' +
        "<h2>" + escapeHtml(screen.title) + "</h2>" +
        renderBlocks(screen.blocks || []) +
        '<div class="nav">' +
          (currentIndex > 0 ? '<button class="secondary" id="prev-btn">Назад</button>' : "") +
          '<button id="next-btn">' + (currentIndex === screens.length - 1 ? "Завершить SCO" : "Далее") + "</button>" +
        "</div>"
      );

      if (currentIndex > 0) {
        document.getElementById("prev-btn").addEventListener("click", function () {
          currentIndex -= 1;
          saveIndex(currentIndex);
          draw();
        });
      }

      document.getElementById("next-btn").addEventListener("click", function () {
        if (currentIndex < screens.length - 1) {
          currentIndex += 1;
          saveIndex(currentIndex);
          draw();
          return;
        }
        setValue("cmi.core.lesson_status", "completed");
        setValue("cmi.core.lesson_location", screens.length - 1);
        commit();
        createCard('<h2>SCO завершен</h2><p class="status">Прогресс сохранен в SCORM 1.2.</p>');
      });
    }

    if (!getValue("cmi.core.lesson_status")) {
      setValue("cmi.core.lesson_status", "incomplete");
      commit();
    }

    draw();
  }

  function renderQuizSco() {
    var suspend = readSuspendData();
    var attemptsUsed = suspend.attemptsUsed || 0;
    var lastResult = suspend.lastResult || null;
    var questions = runtime.questions || [];
    var maxAttempts = runtime.attemptsLimit;
    var passScore = runtime.passingScore;
    var maxTimeMinutes = runtime.maxTimeMinutes;

    function showLocked() {
      createCard(
        "<h2>Попытки исчерпаны</h2>" +
        '<p class="status">Разрешено попыток: ' + maxAttempts + ".</p>" +
        (lastResult ? '<p class="result ' + (lastResult.passed ? "ok" : "") + '">Последний результат: ' + lastResult.score + "%.</p>" : "")
      );
    }

    if (attemptsUsed >= maxAttempts) {
      setValue("cmi.core.lesson_status", lastResult && lastResult.passed ? "passed" : "failed");
      if (lastResult) setValue("cmi.core.score.raw", lastResult.score);
      commit();
      showLocked();
      return;
    }

    var startedAt = Date.now();
    var timerId;
    var submitted = false;

    function completeExam(forceTimeout) {
      if (submitted) return;
      submitted = true;
      window.clearInterval(timerId);

      var score = 0;
      var interactionIndex = 0;
      questions.forEach(function (question, qIndex) {
        var checked = document.querySelector('input[name="' + question.id + '"]:checked');
        var studentResponse = checked ? checked.value : "";
        var isCorrect = studentResponse === question.correctOptionId;
        if (isCorrect) score += 1;

        // SCORM 1.2 cmi.interactions
        var prefix = "cmi.interactions." + interactionIndex;
        setValue(prefix + ".id", "q" + qIndex);
        setValue(prefix + ".type", "choice");
        setValue(prefix + ".student_response", studentResponse);
        setValue(prefix + ".correct_responses.0.pattern", question.correctOptionId);
        setValue(prefix + ".result", isCorrect ? "correct" : "wrong");
        setValue(prefix + ".time", new Date().toLocaleTimeString("en-US", { hour12: false }));
        setValue(prefix + ".latency", formatSessionTime(Date.now() - startedAt));

        interactionIndex += 1;
      });

      var percent = questions.length ? Math.round((score / questions.length) * 100) : 0;
      var passed = percent >= passScore;
      var nextSuspend = {
        attemptsUsed: attemptsUsed + 1,
        lastResult: {
          score: percent,
          passed: passed,
          timeout: Boolean(forceTimeout),
          finishedAt: new Date().toISOString()
        }
      };

      writeSuspendData(nextSuspend);
      setValue("cmi.core.score.raw", percent);
      setValue("cmi.core.score.min", 0);
      setValue("cmi.core.score.max", 100);
      setValue("cmi.core.lesson_status", passed ? "passed" : "failed");
      setValue("cmi.core.lesson_location", "submitted");
      commit();

      createCard(
        "<h2>Тест завершен</h2>" +
        '<p class="result ' + (passed ? "ok" : "") + '">Результат: ' + percent + "%.</p>" +
        '<p class="status">Порог прохождения: ' + passScore + "%.</p>" +
        '<p class="status">Использовано попыток: ' + nextSuspend.attemptsUsed + " из " + maxAttempts + ".</p>" +
        (forceTimeout ? '<p class="status">Тест завершен автоматически по таймеру.</p>' : "")
      );
    }

      createCard(
        "<h2>" + escapeHtml(runtime.title) + "</h2>" +
        '<p class="status">Проходной балл: ' + passScore + '% • Попытки: ' + (attemptsUsed + 1) + "/" + maxAttempts + "</p>" +
        '<div class="timer" id="timer"></div>' +
        '<form id="quiz-form">' +
          questions.map(function (question, index) {
          return '<section class="question">' +
            "<strong>" + (index + 1) + ". " + escapeHtml(question.prompt) + "</strong>" +
            question.options.map(function (option) {
              return '<label class="option"><input type="radio" name="' + escapeHtml(question.id) + '" value="' + escapeHtml(option.id) + '" /> <span>' + escapeHtml(option.text) + "</span></label>";
            }).join("") +
          "</section>";
        }).join("") +
        '<div class="nav"><button type="submit">Завершить тест</button></div>' +
      "</form>"
    );

    function updateTimer() {
      var remaining = Math.max(0, maxTimeMinutes * 60 - Math.floor((Date.now() - startedAt) / 1000));
      var minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
      var seconds = String(remaining % 60).padStart(2, "0");
      document.getElementById("timer").textContent = "Оставшееся время: " + minutes + ":" + seconds;
      if (remaining <= 0) {
        completeExam(true);
      }
    }

    timerId = window.setInterval(updateTimer, 1000);
    updateTimer();

    document.getElementById("quiz-form").addEventListener("submit", function (event) {
      event.preventDefault();
      completeExam(false);
    });
  }

  window.addEventListener("beforeunload", finish);
  init();

  if (runtime.type === "quiz") {
    renderQuizSco();
  } else {
    renderContentSco();
  }
})();`
    },
    {
      name: "index.html",
      content: `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(course.title)}</title>
    <link rel="stylesheet" href="assets/style.css" />
  </head>
  <body>
    <main class="shell">
      <header class="runtime-header">
        <span class="runtime-badge">Package</span>
        <h1>${escapeHtml(course.title)}</h1>
      </header>
      <section class="card">
        <p>${escapeHtml(course.description)}</p>
        <h2>Содержимое курса</h2>
        <ul>
          ${course.modules
          .flatMap((moduleItem) =>
            moduleItem.sections.flatMap((sectionItem) =>
              sectionItem.scos.map(
                (sco) => `<li><a href="sco/${escapeHtml(sco.id)}.html">${escapeHtml(moduleItem.title)} / ${escapeHtml(sectionItem.title)} / ${escapeHtml(sco.title)}</a></li>`
              )
            )
          )
          .join("")}
          ${course.finalTest?.enabled ? `<li><a href="sco/${escapeHtml(course.finalTest.id)}.html">${escapeHtml(course.finalTest.title)}</a></li>` : ""}
        </ul>
      </section>
    </main>
  </body>
</html>`
    }
  ];
}

export function createScoHtmlFiles(course) {
  const files = [];

  course.modules.forEach((moduleItem) => {
    moduleItem.sections.forEach((sectionItem) => {
      sectionItem.scos.forEach((sco) => {
        files.push({
          name: `sco/${sco.id}.html`,
          content: htmlPage({
            title: sco.title,
            heading: `${moduleItem.title} / ${sectionItem.title} / ${sco.title}`,
            payload: {
              type: "content",
              title: sco.title,
              screens: sco.screens
            }
          })
        });
      });
    });
  });

  // Final test is NOT included in SCORM — created as native Chamilo exercise

  return files;
}
