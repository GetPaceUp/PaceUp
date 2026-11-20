// The commit this process was started from, so a deploy can be confirmed over HTTPS (/health)
// for both the API and the WhatsApp worker.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const codeVersion = (() => {
  try { return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
})();
