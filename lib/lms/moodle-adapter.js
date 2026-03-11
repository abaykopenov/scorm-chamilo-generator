/**
 * MoodleAdapter — Stub adapter for Moodle LMS.
 *
 * This is a placeholder that will be implemented when Moodle integration
 * is needed. All methods throw descriptive errors until then.
 */
import { LmsAdapter } from "./adapter.js";

export class MoodleAdapter extends LmsAdapter {
  get id() {
    return "moodle";
  }

  get label() {
    return "Moodle LMS";
  }

  normalizeProfile(rawProfile) {
    const base = { ...(rawProfile || {}) };
    return {
      name: `${base.name || "moodle"}`.trim(),
      baseUrl: `${base.baseUrl || ""}`.replace(/\/+$/, ""),
      token: `${base.token || ""}`.trim(),
      courseId: base.courseId ? Number(base.courseId) : null,
      username: `${base.username || ""}`.trim(),
      password: `${base.password || ""}`.trim()
    };
  }

  async connect(profile) {
    const normalized = this.normalizeProfile(profile);
    if (!normalized.baseUrl) {
      throw new Error("Moodle base URL is required.");
    }
    if (!normalized.token && (!normalized.username || !normalized.password)) {
      throw new Error("Moodle API token or username/password are required.");
    }

    // TODO: Implement Moodle Web Services REST API connection
    // Endpoint: {baseUrl}/webservice/rest/server.php
    // Function: core_course_get_courses
    throw new Error(
      "Moodle adapter is not yet implemented. " +
      "To add Moodle support, implement the Web Services REST API calls in this file."
    );
  }

  async uploadTheory({ zipBuffer, fileName, profile }) {
    // TODO: Implement Moodle SCORM upload via Web Services
    // Function: mod_scorm_get_scorms or direct file upload
    throw new Error("Moodle SCORM upload is not yet implemented.");
  }

  async createNativeTest({ profile, finalTest, courseTitle }) {
    // TODO: Implement Moodle quiz creation via Web Services
    // Function: mod_quiz_add_questions or local plugin API
    throw new Error("Moodle native test creation is not yet implemented.");
  }

  async findLearningPathId({ profile, cookieJar }) {
    // Moodle doesn't have a direct "learning path" concept like Chamilo,
    // but courses/sections serve a similar role.
    return null;
  }

  async linkTestToLearningPath({ profile, lpId, exerciseId, exerciseTitle, cookieJar }) {
    // TODO: Implement adding quiz to a Moodle course section
    throw new Error("Moodle learning path linking is not yet implemented.");
  }
}
