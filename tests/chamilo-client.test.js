import test from "node:test";
import assert from "node:assert/strict";
import { parseForms } from "../lib/chamilo-client.js";

test("parseForms detects login and upload forms", () => {
  const html = `
    <html>
      <body>
        <form action="/index.php" method="post">
          <input type="hidden" name="token" value="abc">
          <input type="text" name="login" value="">
          <input type="password" name="password" value="">
          <input type="submit" name="submitAuth" value="Login">
        </form>
        <form action="/main/newscorm/lp_controller.php?action=import&cidReq=DEMO" method="post" enctype="multipart/form-data">
          <input type="hidden" name="sec_token" value="xyz">
          <input type="file" name="user_file">
          <input type="submit" name="submitImport" value="Upload">
        </form>
      </body>
    </html>
  `;

  const forms = parseForms(html, "https://lms.example.com/index.php");
  assert.equal(forms.length, 2);
  assert.equal(forms[0].hasPassword, true);
  assert.equal(forms[1].hasFileInput, true);
  assert.equal(forms[1].fileInputName, "user_file");
  assert.equal(forms[1].action, "https://lms.example.com/main/newscorm/lp_controller.php?action=import&cidReq=DEMO");
});
