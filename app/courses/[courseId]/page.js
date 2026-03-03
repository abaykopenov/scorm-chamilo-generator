import { notFound } from "next/navigation";
import { getCourse } from "@/lib/course-store";
import CourseClientPage from "./client";

export default async function CoursePage({ params }) {
  const { courseId } = await params;
  const course = await getCourse(courseId);
  if (!course) {
    notFound();
  }

  return <CourseClientPage initialCourse={course} />;
}
