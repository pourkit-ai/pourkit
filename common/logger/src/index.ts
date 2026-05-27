import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { styleText } from "node:util";

export interface PourkitLogger {
  line(msg: string): void;
  raw(msg: string): void;
  step(step: string, msg: string): void;
  status(status: string): void;
  kv(key: string, value: string): void;
  close(): Promise<void>;
}

export function createLogger(name: string, filePath?: string): PourkitLogger {
  let fileStream: import("fs").WriteStream | undefined;

  if (filePath) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    fileStream = createWriteStream(filePath, { flags: "a" });
  }

  const write = (terminal: string, plain = terminal) => {
    process.stdout.write(`${terminal}\n`);
    if (fileStream) {
      fileStream.write(`${plain}\n`);
    }
  };

  return {
    line(msg: string) {
      const ts = timestamp();
      write(`${ts.terminal} ${msg}`, `${ts.plain} ${msg}`);
    },

    raw(msg: string) {
      write(msg);
    },

    step(step: string, msg: string) {
      const ts = timestamp();
      write(
        `${ts.terminal} ${formatStep(step)} ${formatStepMessage(step, msg)}`,
        `${ts.plain} [${step}] ${msg}`
      );
    },

    status(status: string) {
      const ts = timestamp();
      write(
        `${ts.terminal} ${color(["bold", "cyan"], "POURKIT")} ${color("cyan", status)}`,
        `${ts.plain} POURKIT ${status}`
      );
    },

    kv(key: string, value: string) {
      const ts = timestamp();
      write(
        `${ts.terminal} ${color("dim", key)}=${formatValue(key, value)}`,
        `${ts.plain} ${key}=${value}`
      );
    },

    async close() {
      await new Promise<void>((resolve) => {
        if (!fileStream) {
          resolve();
          return;
        }

        const timer = setTimeout(() => {
          if (!fileStream.destroyed) {
            fileStream.destroy();
          }
          resolve();
        }, 2000);

        fileStream.end(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function timestamp() {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const plain = `${time}.${ms}`;
  return { terminal: color("dim", plain), plain };
}

function formatStep(step: string) {
  return color(stepStyle(step), `[${step}]`);
}

function formatStepMessage(step: string, msg: string) {
  if (step === "error") {
    return color("red", msg);
  }
  if (step === "warn") {
    return color("yellow", msg);
  }
  return msg;
}

function formatValue(key: string, value: string) {
  if (/SUCCESS|CREATED|COMMITS/.test(key)) {
    return color("green", value);
  }
  if (/BRANCH|PATH|FILE|URL/.test(key)) {
    return color("cyan", value);
  }
  return color("bold", value);
}

function stepStyle(step: string): Parameters<typeof styleText>[0] {
  switch (step) {
    case "sandcastle":
      return ["bold", "cyan"];
    case "git":
      return ["bold", "magenta"];
    case "review":
    case "reviewer":
      return ["bold", "blue"];
    case "cleanup":
      return ["bold", "yellow"];
    case "error":
      return ["bold", "red"];
    case "warn":
      return ["bold", "yellow"];
    case "info":
      return "cyan";
    default:
      return "green";
  }
}

function color(format: Parameters<typeof styleText>[0], text: string) {
  if (process.env.NO_COLOR) {
    return text;
  }

  try {
    return styleText(format, text);
  } catch {
    return text;
  }
}
