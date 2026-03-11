/**
 * ChamiloAdapter — LMS adapter wrapping the existing chamilo-client.js.
 *
 * This adapter delegates every call to the battle-tested functions in
 * chamilo-client.js without modifying their internal logic. It simply
 * maps the universal LmsAdapter interface onto the Chamilo-specific API.
 */
import { LmsAdapter } from "./adapter.js";
import {
  connectToChamilo,
  normalizeChamiloProfile,
  uploadScormToChamilo,
  createFinalTestExerciseInChamilo,
  findLatestLpId,
  addExerciseToLearningPath
} from "../chamilo-client.js";

export class ChamiloAdapter extends LmsAdapter {
  get id() {
    return "chamilo";
  }

  get label() {
    return "Chamilo LMS";
  }

  normalizeProfile(rawProfile) {
    return normalizeChamiloProfile(rawProfile);
  }

  async connect(profile) {
    const normalized = this.normalizeProfile(profile);
    const connection = await connectToChamilo({ profile: normalized });
    return {
      ok: Boolean(connection.ok),
      courses: Array.isArray(connection.courses) ? connection.courses : [],
      cookieJar: connection.cookieJar || null,
      uploadUrl: connection.uploadUrl || "",
      uploadPageTitle: connection.uploadPageTitle || ""
    };
  }

  async uploadTheory({ zipBuffer, fileName, profile }) {
    const normalized = this.normalizeProfile(profile);
    const result = await uploadScormToChamilo({
      zipBuffer,
      fileName,
      profile: normalized
    });
    return {
      ok: Boolean(result.ok),
      message: result.message || "",
      lpId: result.lpId || null,
      raw: result
    };
  }

  async createNativeTest({ profile, finalTest, courseTitle }) {
    const normalized = this.normalizeProfile(profile);
    const result = await createFinalTestExerciseInChamilo({
      profile: normalized,
      finalTest,
      courseTitle
    });
    return {
      ok: Boolean(result.ok),
      exerciseId: result.exerciseId || null,
      questionCount: result.questionCount || 0,
      message: result.message || "",
      skipped: Boolean(result.skipped),
      _cookieJar: result._cookieJar || null
    };
  }

  async findLearningPathId({ profile, cookieJar }) {
    const normalized = this.normalizeProfile(profile);
    const lpId = await findLatestLpId({
      profile: normalized,
      cookieJar: cookieJar || undefined
    });
    return lpId || null;
  }

  async linkTestToLearningPath({ profile, lpId, exerciseId, exerciseTitle, cookieJar }) {
    const normalized = this.normalizeProfile(profile);
    const result = await addExerciseToLearningPath({
      profile: normalized,
      lpId,
      exerciseId,
      exerciseTitle,
      cookieJar: cookieJar || undefined
    });
    return {
      ok: Boolean(result?.ok),
      error: result?.error || ""
    };
  }
}
