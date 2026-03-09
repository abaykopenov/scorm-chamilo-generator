import test from "node:test";
import assert from "node:assert/strict";
import { postprocessGeneratedCourse } from "../lib/course-postprocess.js";

test("postprocessGeneratedCourse builds final test from course screen content", () => {
  const course = {
    id: "course_1",
    title: "ROS onboarding",
    description: "Draft",
    language: "en",
    modules: [
      {
        id: "module_1",
        title: "ROS basics",
        order: 1,
        sections: [
          {
            id: "section_1",
            title: "Foundations",
            order: 1,
            scos: [
              {
                id: "sco_1",
                title: "Core concepts",
                order: 1,
                screens: [
                  {
                    id: "screen_1",
                    title: "ROS topics",
                    order: 1,
                    blocks: [
                      {
                        type: "text",
                        text: "ROS uses nodes and topics for communication between components in a robot system."
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    finalTest: {
      id: "final_test_1",
      enabled: true,
      title: "Final test",
      questionCount: 1,
      passingScore: 70,
      attemptsLimit: 1,
      maxTimeMinutes: 10,
      questions: [
        {
          id: "q1",
          prompt: "Control question 1",
          options: [
            { id: "o1", text: "Option 1" },
            { id: "o2", text: "Option 2" },
            { id: "o3", text: "Option 3" },
            { id: "o4", text: "Option 4" }
          ],
          correctOptionId: "o1",
          explanation: ""
        }
      ]
    }
  };

  const input = {
    titleHint: "ROS onboarding",
    audience: "New employees",
    structure: {
      moduleCount: 1,
      sectionsPerModule: 1,
      scosPerSection: 1,
      screensPerSco: 1
    },
    finalTest: {
      enabled: true,
      questionCount: 1,
      passingScore: 70,
      attemptsLimit: 1,
      maxTimeMinutes: 10
    }
  };

  const result = postprocessGeneratedCourse(course, input);
  const question = result.finalTest.questions[0];

  assert.ok(question.prompt.length > 10);
  assert.ok(!/^control question/i.test(question.prompt));
  assert.ok(!/which statement is correct for/i.test(question.prompt));
  assert.ok(question.options.every((option) => !/^option\s+\d+$/i.test(option.text)));
  assert.ok(question.options.some((option) => /ros|topics|nodes/i.test(option.text)));
  assert.ok(question.options.some((option) => option.id === question.correctOptionId));
});

test("postprocessGeneratedCourse expands short placeholder-like screen text", () => {
  const course = {
    id: "course_2",
    title: "Corporate onboarding",
    description: "Draft",
    language: "en",
    modules: [
      {
        id: "module_1",
        title: "Module 1",
        order: 1,
        sections: [
          {
            id: "section_1",
            title: "Section 1",
            order: 1,
            scos: [
              {
                id: "sco_1",
                title: "SCO 1",
                order: 1,
                screens: [
                  {
                    id: "screen_1",
                    title: "Current topic",
                    order: 1,
                    blocks: [
                      {
                        type: "text",
                        text: "Topic focus: \"current topic\". Core points: 1) Key point 1; 2) Key point 2; 3) Key point 3. Action: do one step."
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    finalTest: {
      id: "final_test_2",
      enabled: false,
      title: "Final test",
      questionCount: 0,
      passingScore: 70,
      attemptsLimit: 1,
      maxTimeMinutes: 10,
      questions: []
    }
  };

  const input = {
    titleHint: "Corporate onboarding",
    audience: "New employees",
    structure: {
      moduleCount: 1,
      sectionsPerModule: 1,
      scosPerSection: 1,
      screensPerSco: 1
    },
    finalTest: {
      enabled: false,
      questionCount: 0,
      passingScore: 70,
      attemptsLimit: 1,
      maxTimeMinutes: 10
    }
  };

  const result = postprocessGeneratedCourse(course, input);
  const screen = result.modules[0].sections[0].scos[0].screens[0];
  const textBlock = screen.blocks.find((block) => block.type === "text");

  assert.ok(textBlock);
  assert.ok(textBlock.text.length >= 220);
  assert.ok(!/current topic/i.test(textBlock.text));
  assert.ok(screen.blocks.some((block) => block.type === "list" && Array.isArray(block.items) && block.items.length === 3));
  assert.ok(!screen.blocks.some((block) => block.type === "note"));
});

test("postprocessGeneratedCourse rebuilds missing sections without empty third section", () => {
  const course = {
    id: "course_3",
    title: "Safety basics",
    description: "Draft",
    language: "en",
    modules: [
      {
        id: "module_1",
        title: "Module 1",
        order: 1,
        sections: [
          {
            id: "section_1",
            title: "Section 1",
            order: 1,
            scos: [
              {
                id: "sco_1",
                title: "SCO 1",
                order: 1,
                screens: [
                  {
                    id: "screen_1",
                    title: "Intro",
                    order: 1,
                    blocks: [
                      { type: "text", text: "Personal protective equipment reduces risk during routine operations." }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    finalTest: {
      id: "final_test_3",
      enabled: false,
      title: "Final test",
      questionCount: 0,
      passingScore: 70,
      attemptsLimit: 1,
      maxTimeMinutes: 10,
      questions: []
    }
  };

  const input = {
    titleHint: "Safety basics",
    audience: "Operators",
    structure: {
      moduleCount: 1,
      sectionsPerModule: 3,
      scosPerSection: 1,
      screensPerSco: 1
    },
    finalTest: {
      enabled: false,
      questionCount: 0,
      passingScore: 70,
      attemptsLimit: 1,
      maxTimeMinutes: 10
    }
  };

  const result = postprocessGeneratedCourse(course, input);
  assert.equal(result.modules[0].sections.length, 3);

  const thirdSectionScreen = result.modules[0].sections[2].scos[0].screens[0];
  const textBlock = thirdSectionScreen.blocks.find((block) => block.type === "text");

  assert.ok(textBlock);
  assert.ok(textBlock.text.trim().length >= 120);
});
