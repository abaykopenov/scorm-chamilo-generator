import { notFound } from "next/navigation";
import { CourseEditor } from "@/components/course-editor";
import { getCourse } from "@/lib/course-store";

export default async function CoursePage({ params }) {
  const { courseId } = await params;
  const course = await getCourse(courseId);
  if (!course) {
    notFound();
  }

  return (
    <main className="page-shell stack">
      <section className="hero">
        <span className="eyebrow">Course Workspace</span>
        <h1>{course.title}</h1>
        <p>{course.description}</p>
      </section>

      <CourseEditor initialCourse={course} />
    </main>
  );
}
