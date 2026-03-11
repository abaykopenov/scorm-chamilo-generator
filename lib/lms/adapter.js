/**
 * LmsAdapter — Abstract base class for LMS integrations.
 *
 * Every LMS plugin (Chamilo, Moodle, iSpring, etc.) must extend this class
 * and implement all methods. The course generation pipeline is completely
 * agnostic to the target LMS: it only talks through this interface.
 *
 * Lifecycle:
 *   1. connect(profile)          → authenticate & discover courses
 *   2. uploadTheory(archive, profile) → upload SCORM package
 *   3. createNativeTest(profile, finalTest, courseTitle) → make exercise
 *   4. linkTestToLearningPath(...)  → attach exercise to LP
 */
export class LmsAdapter {
  /** @returns {string} unique key, e.g. "chamilo", "moodle" */
  get id() {
    throw new Error("LmsAdapter subclass must implement get id()");
  }

  /** @returns {string} human-readable label for the UI dropdown */
  get label() {
    throw new Error("LmsAdapter subclass must implement get label()");
  }

  /**
   * Authenticate with the LMS and return a list of available courses.
   *
   * @param {object} profile  – credentials & connection settings
   * @returns {Promise<{ok: boolean, courses: Array, cookieJar?: any, uploadUrl?: string, uploadPageTitle?: string}>}
   */
  async connect(profile) {
    throw new Error("LmsAdapter subclass must implement connect()");
  }

  /**
   * Upload a SCORM zip to the LMS.
   *
   * @param {object} params
   * @param {Buffer} params.zipBuffer
   * @param {string} params.fileName
   * @param {object} params.profile
   * @returns {Promise<{ok: boolean, message?: string, lpId?: number}>}
   */
  async uploadTheory({ zipBuffer, fileName, profile }) {
    throw new Error("LmsAdapter subclass must implement uploadTheory()");
  }

  /**
   * Create a native test/exercise in the LMS from finalTest questions.
   *
   * @param {object} params
   * @param {object} params.profile
   * @param {object} params.finalTest
   * @param {string} params.courseTitle
   * @returns {Promise<{ok: boolean, exerciseId?: number, questionCount?: number, message?: string, _cookieJar?: any}>}
   */
  async createNativeTest({ profile, finalTest, courseTitle }) {
    throw new Error("LmsAdapter subclass must implement createNativeTest()");
  }

  /**
   * Find the most recent Learning Path id in the LMS.
   *
   * @param {object} params
   * @param {object} params.profile
   * @param {any}    [params.cookieJar]
   * @returns {Promise<number|null>}
   */
  async findLearningPathId({ profile, cookieJar }) {
    throw new Error("LmsAdapter subclass must implement findLearningPathId()");
  }

  /**
   * Attach an exercise to a Learning Path in the LMS.
   *
   * @param {object} params
   * @param {object} params.profile
   * @param {number} params.lpId
   * @param {number} params.exerciseId
   * @param {string} params.exerciseTitle
   * @param {any}    [params.cookieJar]
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async linkTestToLearningPath({ profile, lpId, exerciseId, exerciseTitle, cookieJar }) {
    throw new Error("LmsAdapter subclass must implement linkTestToLearningPath()");
  }

  /**
   * Normalize a raw profile object (fill defaults, trim strings, etc.)
   *
   * @param {object} rawProfile
   * @returns {object} normalized profile
   */
  normalizeProfile(rawProfile) {
    return rawProfile;
  }
}
