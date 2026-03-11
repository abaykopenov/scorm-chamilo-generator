import nodemailer from "nodemailer";

export async function sendAuthCode(email, code) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 465;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn("[MAILER] Не настроен SMTP (host/user/pass). Выводим код в консоль:");
    console.warn(`[MAILER] Отправка на ${email} кода: ${code}`);
    return true; // For local dev fallback
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for other ports
    auth: {
      user,
      pass,
    },
  });

  try {
    const info = await transporter.sendMail({
      from: `"University SCORM Bot" <${user}>`,
      to: email,
      subject: "Verification Code for SCORM Bot",
      text: `Your verification code is: ${code}\n\nThis code will expire in 10 minutes.`,
      html: `<b>Your verification code is:</b> <h2>${code}</h2><p>This code will expire in 10 minutes.</p>`,
    });
    console.log("[MAILER] Письмо отправлено: %s", info.messageId);
    return true;
  } catch (error) {
    console.error("[MAILER] Ошибка отправки:", error);
    return false;
  }
}
