import { NextResponse } from "next/server";
import prisma from "../../../../lib/db.js";

const ADMIN_PASS = process.env.ADMIN_PANEL_PASSWORD || "admin123";

function checkAuth(req) {
  const auth = req.headers.get("Authorization");
  return auth === `Bearer ${ADMIN_PASS}`;
}

export async function GET(req) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const users = await prisma.telegramUser.findMany({
      orderBy: { createdAt: "desc" }
    });
    const logsCount = await prisma.generationLog.count();
    
    return NextResponse.json({
      users,
      globals: { generatedCourses: logsCount }
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  
  try {
    const body = await req.json();
    const { id, action } = body; 
    
    if (action === "ban") {
      await prisma.telegramUser.update({ where: { id }, data: { status: "banned" } });
    } else if (action === "unban") {
      await prisma.telegramUser.update({ where: { id }, data: { status: "approved" } });
    } else if (action === "delete") {
      await prisma.telegramUser.delete({ where: { id } });
    }
    
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
