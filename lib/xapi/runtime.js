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
        <span class="runtime-badge">xAPI / TIN CAN</span>
        <h1>${escapeHtml(heading)}</h1>
      </header>
      <section id="app"></section>
    </main>
    <script>window.XAPI_RUNTIME = ${safeJson(payload)};</script>
    <script src="../assets/xapi-runtime.js"></script>
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
  --accent: #1e5a8c;
  --accent-strong: #144066;
  --success: #256f49;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: linear-gradient(160deg, #e6eff5, #c4d9ea);
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
  background: rgba(30,90,140,0.12);
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
  box-shadow: 0 20px 50px rgba(17,45,61,0.1);
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
      name: "assets/xapi-runtime.js",
      content: `(function () {
  var runtime = window.XAPI_RUNTIME;
  var state = { startedAt: Date.now(), finished: false };

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function safeText(val) {
    if (val == null) return "";
    if (typeof val === "string") return val;
    if (typeof val === "object") return val.text || val.label || val.value || JSON.stringify(val);
    return String(val);
  }

  // --- xAPI Logic ---
  var urlParams = new URLSearchParams(window.location.search);
  var endpoint = urlParams.get('endpoint') || (window.parent && window.parent.XAPI_ENDPOINT) || '';
  var auth = urlParams.get('auth') || (window.parent && window.parent.XAPI_AUTH) || '';
  var actorStr = urlParams.get('actor') || (window.parent && window.parent.XAPI_ACTOR) || '{"mbox":"mailto:anonymous@example.com","name":"Anonymous User"}';
  var actor;
  try { actor = JSON.parse(actorStr); } catch (e) { actor = { mbox: "mailto:anonymous@example.com", name: "Anonymous" }; }

  function sendStatement(verb, objectDesc, result) {
    if (!endpoint) {
      console.log("[xAPI Dummy] Statement generated. (No LRS endpoint defined in URL parameters)", verb.display["en-US"], objectDesc.name["en-US"]);
      return;
    }

    var statement = {
      actor: actor,
      verb: verb,
      object: {
        id: "http://example.com/course/" + runtime.courseId + "/" + runtime.id + (objectDesc.idSuffix || ""),
        definition: {
          name: objectDesc.name,
          description: {"en-US": "Generated from screen / test"}
        }
      },
      timestamp: new Date().toISOString()
    };

    if (result) {
      statement.result = result;
    }

    fetch(endpoint + "statements", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Experience-API-Version': '1.0.3',
        ...(auth ? {'Authorization': auth} : {})
      },
      body: JSON.stringify(statement)
    }).catch(function(err) {
      console.warn("xAPI send failed:", err);
    });
  }

  function reportExperienced(objDesc) {
    sendStatement({ id: "http://adlnet.gov/expapi/verbs/experienced", display: { "en-US": "experienced" } }, objDesc);
  }

  function reportPassed(objDesc, score, maxScore) {
    sendStatement({ id: "http://adlnet.gov/expapi/verbs/passed", display: { "en-US": "passed" } }, objDesc, {
      score: { raw: score, min: 0, max: maxScore, scaled: score / maxScore },
      success: true,
      completion: true
    });
  }

  function reportFailed(objDesc, score, maxScore) {
    sendStatement({ id: "http://adlnet.gov/expapi/verbs/failed", display: { "en-US": "failed" } }, objDesc, {
      score: { raw: score, min: 0, max: maxScore, scaled: score / maxScore },
      success: false,
      completion: true
    });
  }

  // Fallback local storage for session progression (since LRS doesn't track current slide out-of-the-box simply)
  var storage = window.sessionStorage;

  function getValue(key) {
    return storage.getItem(key) || "";
  }

  function setValue(key, value) {
    storage.setItem(key, String(value));
  }

  function createCard(innerHtml) {
    var app = document.getElementById("app");
    app.innerHTML = '<div class="card">' + innerHtml + "</div>";
    return app;
  }

  function renderBlocks(blocks) {
    return blocks.map(function (block) {
      if (block.type === "note") {
        return "";
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
    var storageKey = "xapi_loc_" + runtime.id;
    var currentIndex = Number(getValue(storageKey) || 0);
    if (!Number.isFinite(currentIndex) || currentIndex < 0 || currentIndex >= screens.length) {
      currentIndex = 0;
    }
    var screenTimer;

    function saveIndex(nextIndex) {
      setValue(storageKey, nextIndex);
    }

    function setupXapiTracker(screen) {
      if (screenTimer) clearTimeout(screenTimer);
      // Wait 10 seconds, then send the "experienced" statement silently
      screenTimer = setTimeout(function() {
        reportExperienced({
          idSuffix: "/screen-" + (currentIndex + 1),
          name: { "en-US": "Slide " + (currentIndex + 1) + ": " + screen.title }
        });
      }, 10000); // 10s
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

      setupXapiTracker(screen);

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
        setValue(storageKey, screens.length - 1);
        if (screenTimer) clearTimeout(screenTimer); // Cancel if finished early
        reportExperienced({ idSuffix: "/completed", name: { "en-US": "Completed " + runtime.title } });
        createCard('<h2>SCO завершен</h2><p class="status">xAPI: Статусы чтения отправлены (Tin Can).</p>');
      });
    }

    draw();
  }

  function renderQuizSco() {
    var storageKey = "xapi_quiz_" + runtime.id;
    var rawParams = getValue(storageKey);
    var suspend = rawParams ? JSON.parse(rawParams) : { attemptsUsed: 0, lastResult: null };
    
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
      questions.forEach(function (question) {
        if (userAnswers[question.id] === question.correctOptionId) {
          score += 1;
        }
      });

      var percent = questions.length ? Math.round((score / questions.length) * 100) : 0;
      var passed = percent >= passScore;
      var nextSuspend = {
        attemptsUsed: attemptsUsed + 1,
        lastResult: {
          score: percent,
          passed: passed,
          timeout: Boolean(forceTimeout)
        }
      };

      setValue(storageKey, JSON.stringify(nextSuspend));

      var objDesc = {
        name: { "en-US": "Final Test" },
        idSuffix: "/test-attempt-" + nextSuspend.attemptsUsed
      };

      if (passed) {
        reportPassed(objDesc, percent, 100);
      } else {
        reportFailed(objDesc, percent, 100);
      }

      createCard(
        "<h2>Тест завершен</h2>" +
        '<p class="result ' + (passed ? "ok" : "") + '">Результат: ' + percent + "%.</p>" +
        '<p class="status">Порог прохождения: ' + passScore + "%.</p>" +
        '<p class="status">Использовано попыток: ' + nextSuspend.attemptsUsed + " из " + maxAttempts + ".</p>" +
        (forceTimeout ? '<p class="status">Тест завершен автоматически по таймеру.</p>' : "")
      );
    }

    var currentQuestionIndex = 0;
    var userAnswers = {};

    function renderActiveQuestion() {
      var question = questions[currentQuestionIndex];
      var isLast = currentQuestionIndex === questions.length - 1;

      createCard(
        "<h2>" + escapeHtml(runtime.title) + " (Вопрос " + (currentQuestionIndex + 1) + " из " + questions.length + ")</h2>" +
        '<p class="status">Проходной балл: ' + passScore + '% • Попытки: ' + (attemptsUsed + 1) + "/" + maxAttempts + "</p>" +
        '<div class="timer" id="timer"></div>' +
        '<form id="quiz-form">' +
          '<section class="question">' +
            "<strong>" + escapeHtml(question.prompt) + "</strong>" +
            question.options.map(function (option) {
              var isChecked = userAnswers[question.id] === option.id ? "checked" : "";
              return '<label class="option"><input type="radio" name="' + escapeHtml(question.id) + '" value="' + escapeHtml(option.id) + '" ' + isChecked + ' /> <span>' + escapeHtml(safeText(option.text)) + "</span></label>";
            }).join("") +
          '</section>' +
          '<div class="nav">' +
            (currentQuestionIndex > 0 ? '<button type="button" class="secondary" id="quiz-prev-btn">Назад</button>' : '') +
            '<button type="submit" id="quiz-next-btn">' + (isLast ? "Завершить тест" : "Далее") + '</button>' +
          '</div>' +
        '</form>'
      );

      if (currentQuestionIndex > 0) {
        document.getElementById("quiz-prev-btn").addEventListener("click", function() {
          saveCurrentAnswer();
          currentQuestionIndex -= 1;
          renderActiveQuestion();
        });
      }

      document.getElementById("quiz-form").addEventListener("submit", function (event) {
        event.preventDefault();
        saveCurrentAnswer();
        if (isLast) {
          completeExam(false);
        } else {
          currentQuestionIndex += 1;
          renderActiveQuestion();
        }
      });
      
      updateTimerDisplay();
    }

    function saveCurrentAnswer() {
      var question = questions[currentQuestionIndex];
      var checked = document.querySelector('input[name="' + escapeHtml(question.id) + '"]:checked');
      if (checked) {
        userAnswers[question.id] = checked.value;
      }
    }

    function updateTimerDisplay() {
      var el = document.getElementById("timer");
      if (!el) return;
      var remaining = Math.max(0, maxTimeMinutes * 60 - Math.floor((Date.now() - startedAt) / 1000));
      var minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
      var seconds = String(remaining % 60).padStart(2, "0");
      el.textContent = "Оставшееся время: " + minutes + ":" + seconds;
    }

    function updateTimer() {
      var remaining = Math.max(0, maxTimeMinutes * 60 - Math.floor((Date.now() - startedAt) / 1000));
      updateTimerDisplay();
      if (remaining <= 0) {
        completeExam(true);
      }
    }

    timerId = window.setInterval(updateTimer, 1000);
    renderActiveQuestion();
  }

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
        <span class="runtime-badge">xAPI Package</span>
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
  const files = course.modules.flatMap((moduleItem) =>
    moduleItem.sections.flatMap((sectionItem) =>
      sectionItem.scos.map((sco) => ({
        name: `sco/${sco.id}.html`,
        content: htmlPage({
          title: sco.title || "Module",
          heading: moduleItem.title,
          payload: {
            ...sco,
            courseId: course.id,
            type: "content"
          }
        })
      }))
    )
  );

  if (course.finalTest?.enabled) {
    files.push({
      name: `sco/${course.finalTest.id}.html`,
      content: htmlPage({
        title: course.finalTest.title || "Final Test",
        heading: "Экзамен",
        payload: {
          ...course.finalTest,
          courseId: course.id,
          type: "quiz"
        }
      })
    });
  }

  return files;
}
