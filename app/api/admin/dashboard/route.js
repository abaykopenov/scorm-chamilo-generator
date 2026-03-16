import { NextResponse } from "next/server";
import prisma from "@/lib/db";
import { listCourses } from "@/lib/course-store";

const ADMIN_PASSWORD = process.env.ADMIN_PANEL_PASSWORD || "";

function checkAuth(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!ADMIN_PASSWORD || token !== ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request) {
  const authError = checkAuth(request);
  if (authError) return authError;

  try {
    const [users, logs, courses] = await Promise.all([
      prisma.telegramUser.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.generationLog.findMany({ orderBy: { createdAt: "desc" } }),
      listCourses()
    ]);

    const totalGenerations = logs.length;
    const completedGenerations = logs.filter(l => l.status === "completed").length;
    const failedGenerations = logs.filter(l => l.status === "failed").length;
    const totalUsers = users.length;
    const approvedUsers = users.filter(u => u.status === "approved").length;

    // Generations per day (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const recentLogs = logs.filter(l => new Date(l.createdAt) > thirtyDaysAgo);
    const perDay = {};
    for (const log of recentLogs) {
      const day = new Date(log.createdAt).toISOString().slice(0, 10);
      perDay[day] = (perDay[day] || 0) + 1;
    }

    // Fill missing days
    const dailyStats = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      dailyStats.push({ date: key, count: perDay[key] || 0 });
    }

    // Top users by generations
    const topUsers = users
      .sort((a, b) => b.generationsCount - a.generationsCount)
      .slice(0, 10)
      .map(u => ({ id: u.id, email: u.email, generations: u.generationsCount, status: u.status }));

    // Recent generations
    const recentGenerations = logs.slice(0, 20).map(l => ({
      id: l.id,
      title: l.title,
      status: l.status,
      chatId: l.chatId,
      createdAt: l.createdAt
    }));

    // Course stats
    const totalCourses = courses.length;
    const completedCourses = courses.filter(c => c.generationStatus === "completed").length;

    return NextResponse.json({
      overview: {
        totalUsers,
        approvedUsers,
        totalGenerations,
        completedGenerations,
        failedGenerations,
        successRate: totalGenerations > 0
          ? Math.round((completedGenerations / totalGenerations) * 100)
          : 0,
        totalCourses,
        completedCourses
      },
      dailyStats,
      topUsers,
      recentGenerations
    });
  } catch (err) {
    console.error(`[dashboard-api] Error: ${err?.message || err}`);
    return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
  }
}
