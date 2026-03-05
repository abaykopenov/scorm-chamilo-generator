import "./globals.css";

export const metadata = {
  title: "Chamilo SCORM Generator",
  description: "SCORM 1.2 course generator with editable structure and quiz rules."
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
