import path from "node:path";

export function parseCommandArgv(command: string): string[] {
  if (!command.trim()) {
    throw new Error("command must not be empty");
  }
  if (/[\u0000-\u001f\u007f]/.test(command)) {
    throw new Error("command contains unsupported control characters");
  }
  if (/[;&|<>`]/.test(command) || command.includes("$(")) {
    throw new Error("iHPC live command must be argv-style and must not use shell operators");
  }

  const argv: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped || quote) {
    throw new Error("command has an unterminated escape or quote");
  }
  if (current) {
    argv.push(current);
  }
  if (!argv.length) {
    throw new Error("command did not produce argv tokens");
  }
  const executable = path.posix.basename(argv[0]).toLowerCase();
  if (["bash", "sh", "zsh", "fish", "csh", "tcsh"].includes(executable)) {
    throw new Error("iHPC live start does not allow shell interpreters; use a direct experiment argv");
  }
  return argv;
}
