import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const script = fileURLToPath(new URL("../scripts/windows-desktop.ps1", import.meta.url));

export const desktopMethods = [
  "list_windows", "list_apps", "get_window", "observe", "launch_app",
  "focus", "click", "scroll", "type", "keypress"
];

export class DesktopError extends Error {}

export class DesktopBridge {
  constructor({ enabled = false } = {}) {
    this.enabled = enabled;
    this.child = null;
    this.reader = null;
    this.pending = [];
    this.starting = null;
  }

  ensureAvailable() {
    if (!this.enabled)
      throw new DesktopError("Desktop control is disabled. Re-run configure with --enable-desktop after reviewing the risks.");
    if (process.platform !== "win32")
      throw new DesktopError("Desktop control is currently implemented for Windows only.");
  }

  async start() {
    this.ensureAvailable();
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const shell = process.env.WEB_AGENT_POWERSHELL || "powershell.exe";
      const child = spawn(shell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", script
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      child.once("error", error => {
        this.failPending(error);
        reject(new DesktopError(`Could not start the Windows desktop helper: ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        this.child = null;
        this.reader?.close();
        this.reader = null;
        const error = new DesktopError(
          `Windows desktop helper exited (${code ?? "signal " + signal}).${stderr ? ` ${stderr.trim()}` : ""}`
        );
        this.failPending(error);
      });
      this.child = child;
      this.reader = createInterface({ input: child.stdout });
      this.reader.on("line", line => this.resolveLine(line));
      resolve();
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  resolveLine(line) {
    const pending = this.pending.shift();
    if (!pending) return;
    try {
      const result = JSON.parse(line);
      if (!result.ok) pending.reject(new DesktopError(result.error || "Desktop helper failed."));
      else pending.resolve(result.value);
    } catch (error) {
      pending.reject(new DesktopError(`Invalid desktop helper response: ${error.message}`));
    }
  }

  failPending(error) {
    const pending = this.pending.splice(0);
    for (const item of pending) item.reject(error);
  }

  async call(op, input = {}) {
    await this.start();
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      try {
        this.child.stdin.write(JSON.stringify({ op, ...input }) + "\n");
      } catch (error) {
        this.pending.pop();
        reject(error);
      }
    });
  }

  async close() {
    this.reader?.close();
    this.reader = null;
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
    }
    this.failPending(new DesktopError("Desktop helper closed."));
  }
}

export function createDesktopBridge(config) {
  return new DesktopBridge({ enabled: config.desktop?.enabled === true });
}
