import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { deflateSync, inflateSync } from "node:zlib";

const PACKAGE_RUN_COMMAND = "npx pi-my-setup";
const SETUP_CODE_VERSION = 1;
const SETUP_CODE_PREFIX = `pisetup:v${SETUP_CODE_VERSION}:`;
const SUPPORTED_URL_PROTOCOL = /^(https?|ssh|git):\/\//i;
const UNSAFE_WINDOWS_SOURCE_CHAR = /["%\r\n]/;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

const DEFAULT_DESCRIPTIONS = new Map([
  ["npm:pi-mcp-adapter", "MCP adapter for connecting Pi to MCP servers."],
  ["npm:pi-init", "Pi initialization helpers, including AGENTS.md generation."],
  ["npm:pi-multi-pass", "Multi-pass agent workflow support for Pi."],
  ["npm:pi-web-access", "Web access tools and bundled research skills for Pi."],
  ["npm:pi-commandcode-provider", "CommandCode model provider integration for Pi."],
  ["npm:@howaboua/pi-markdown-workflows", "Markdown workflow package for Pi."],
  ["npm:pi-image-tools", "Image-oriented tools and helpers for Pi."],
  ["npm:pi-agent-browser-native", "Native agent-browser automation package for Pi."],
  ["npm:@mermaid-js/mermaid-cli", "Mermaid CLI dependency used by diagram workflows."],
  ["npm:@cnife/pi-simple-plannotator", "Simple Plannotator package for Pi plan annotation workflows."],
]);

export async function runCli(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  if (options.command === "save" || options.command === "export") {
    await saveSetupCode();
    return;
  }

  if (options.command === "decode") {
    printDecodedSetupCode(options.setupCode);
    return;
  }

  if (options.command === "restore") {
    await restoreSetupCode(options.setupCode, options);
    return;
  }

  throw new Error(`Unknown command: ${options.command}`);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    command: "save",
    dryRun: false,
    help: false,
    setupCode: "",
    yes: false,
  };

  if (args[0] && !args[0].startsWith("-")) {
    options.command = args.shift();
  }

  const positionals = [];
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    switch (arg) {
      case "--command":
      case "--from-pi":
        // Accepted for compatibility with the earlier explicit export spelling.
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.command === "restore" || options.command === "decode") {
    if (!positionals[0]) throw new Error(`${options.command} requires a setup code`);
    options.setupCode = positionals[0];
  } else if (positionals.length > 0) {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }

  if (positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]}`);
  }

  return options;
}

function printHelp() {
  console.log(`pi-my-setup

Usage:
  npx pi-my-setup                  Print one restore command from this machine's Pi settings
  npx pi-my-setup save             Print one restore command from this machine's Pi settings
  npx pi-my-setup restore <code>   Decode a setup code, then install selected packages
  npx pi-my-setup decode <code>    Print packages inside a setup code without installing

Options:
  --yes, -y                        Skip checkbox UI and install every decoded package
  --dry-run                        Print pi install commands without running them
  --help, -h                       Show this help
`);
}

async function saveSetupCode() {
  const { settingsPath, sources } = await readPiSettingsPackageSources();
  if (sources.length === 0) {
    throw new Error(`No shareable Pi package sources found in ${settingsPath}.`);
  }

  console.log(`${PACKAGE_RUN_COMMAND} restore ${encodeSetupCode(sources)}`);
}

function printDecodedSetupCode(setupCode) {
  printSetupPackageSources(decodeSetupCode(setupCode));
}

async function restoreSetupCode(setupCode, options) {
  const sources = decodeSetupCode(setupCode);
  const packages = sources.map((source) => ({
    source,
    description: DEFAULT_DESCRIPTIONS.get(source) || "",
    selected: true,
  }));

  if (options.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    printSetupPackageSources(sources);
    console.log("");
  }

  await installPackages(packages, options);
}

function printSetupPackageSources(sources) {
  console.log(`Decoded ${sources.length} package(s):`);
  for (const source of sources) {
    console.log(`- ${source}`);
  }
}

function encodeSetupCode(sources) {
  const payload = JSON.stringify({
    v: SETUP_CODE_VERSION,
    packages: normalizeSetupPackageSources(sources),
  });
  const encoded = deflateSync(Buffer.from(payload, "utf8")).toString("base64url");
  return `${SETUP_CODE_PREFIX}${encoded}`;
}

function decodeSetupCode(setupCode) {
  if (typeof setupCode !== "string") {
    throw new Error(`Setup code must start with ${SETUP_CODE_PREFIX}`);
  }

  const match = /^pisetup:v(\d+):(.+)$/.exec(setupCode);
  if (!match) {
    throw new Error(`Setup code must start with ${SETUP_CODE_PREFIX}`);
  }

  const prefixVersion = Number(match[1]);
  if (prefixVersion !== SETUP_CODE_VERSION) {
    throw new Error(`Unsupported setup code version: ${prefixVersion}`);
  }

  const encoded = match[2];
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Setup code is not valid base64url data");
  }

  let payload;
  try {
    const json = inflateSync(Buffer.from(encoded, "base64url")).toString("utf8");
    payload = JSON.parse(json);
  } catch {
    throw new Error("Setup code payload is malformed");
  }

  return normalizeSetupPayload(payload);
}

function normalizeSetupPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Setup code payload must be a JSON object");
  }

  const allowedKeys = new Set(["v", "packages"]);
  const unknownKey = Object.keys(payload).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new Error(`Setup code payload contains unsupported field: ${unknownKey}`);
  }

  if (payload.v !== SETUP_CODE_VERSION) {
    throw new Error(`Unsupported setup code version: ${payload.v}`);
  }

  if (!Array.isArray(payload.packages)) {
    throw new Error("Setup code payload packages must be an array");
  }

  return normalizeSetupPackageSources(payload.packages);
}

function normalizeSetupPackageSources(sources) {
  const byIdentity = new Map();
  sources.forEach((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`Setup code packages[${index}] must be a string source`);
    }

    const source = entry.trim();
    if (!isSupportedSource(source)) {
      throw new Error(
        `Setup code packages[${index}] must be a shareable Pi package source; local paths are not supported: ${source || "<empty>"}`,
      );
    }

    if (UNSAFE_WINDOWS_SOURCE_CHAR.test(source)) {
      throw new Error(`Setup code packages[${index}] contains unsupported shell characters: ${source}`);
    }

    byIdentity.set(sourceIdentity(source), source);
  });

  return [...byIdentity.values()];
}

function isSupportedSource(source) {
  return source.startsWith("npm:") || source.startsWith("git:") || SUPPORTED_URL_PROTOCOL.test(source);
}

async function installPackages(packages, options) {
  const result = options.yes ? { cancelled: false, packages } : await selectPackages(packages);

  if (result.cancelled) {
    console.log(`${style("✕", ANSI.red)} Restore cancelled.`);
    return;
  }

  const selected = result.packages.filter((pkg) => pkg.selected);
  if (selected.length === 0) {
    console.log("No packages selected.");
    return;
  }

  const verb = options.dryRun ? "Previewing" : "Installing";
  console.log(`${style("◆", ANSI.cyan)} ${verb} ${selected.length} package${selected.length === 1 ? "" : "s"}`);

  for (const pkg of selected) {
    const commandText = `pi install ${pkg.source}`;
    if (options.dryRun) {
      console.log(`${style("$", ANSI.dim)} ${commandText}`);
      continue;
    }

    console.log(`\n${style("→", ANSI.cyan)} ${commandText}`);
    await runCommand("pi", ["install", pkg.source]);
  }

  console.log(`${style("✓", ANSI.green)} ${options.dryRun ? "Dry run complete." : "Restore complete."}`);
}

async function readPiSettingsPackageSources() {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  if (!existsSync(settingsPath)) {
    throw new Error(`Pi settings not found: ${settingsPath}`);
  }

  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  return {
    settingsPath,
    sources: extractSupportedPackageSources(settings.packages ?? []),
  };
}

function extractSupportedPackageSources(entries) {
  const sources = [];
  for (const entry of entries) {
    const source = typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : "";
    if (isSupportedSource(source)) {
      sources.push(source);
    }
  }
  return normalizeSetupPackageSources(sources);
}

function sourceIdentity(source) {
  if (source.startsWith("npm:")) {
    return `npm:${npmPackageName(source.slice(4)).toLowerCase()}`;
  }
  return stripGitRef(source).toLowerCase();
}

function npmPackageName(spec) {
  if (spec.startsWith("@")) {
    const slashIndex = spec.indexOf("/");
    if (slashIndex === -1) return spec;
    const versionIndex = spec.indexOf("@", slashIndex + 1);
    return versionIndex === -1 ? spec : spec.slice(0, versionIndex);
  }

  const versionIndex = spec.indexOf("@");
  return versionIndex === -1 ? spec : spec.slice(0, versionIndex);
}

function stripGitRef(source) {
  const slashIndex = Math.max(source.lastIndexOf("/"), source.lastIndexOf(":"));
  const refIndex = source.lastIndexOf("@");
  if (refIndex > slashIndex) {
    return source.slice(0, refIndex);
  }
  return source;
}

async function selectPackages(inputPackages) {
  const packages = inputPackages.map((pkg) => ({ ...pkg }));
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { cancelled: false, packages };
  }

  let cursor = 0;
  let finished = false;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?25l");

  return await new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdout.write("\x1b[?25h\n");
    };

    const finish = (cancelled) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({ cancelled, packages });
    };

    const render = () => {
      const selectedCount = packages.filter((pkg) => pkg.selected).length;
      process.stdout.write("\x1b[2J\x1b[H");
      console.log(`${style("◆", ANSI.cyan)} ${style("pi-my-setup", ANSI.bold)}`);
      console.log(style(`Restore ${packages.length} shareable Pi package${packages.length === 1 ? "" : "s"}`, ANSI.dim));
      console.log("");
      console.log(`${style("Select packages to install", ANSI.bold)} ${style(`(${selectedCount}/${packages.length} selected)`, ANSI.dim)}`);
      console.log("");

      packages.forEach((pkg, index) => {
        const active = index === cursor;
        const pointer = active ? style("❯", ANSI.cyan) : " ";
        const checked = pkg.selected ? style("●", ANSI.green) : style("○", ANSI.dim);
        const source = active ? style(pkg.source, ANSI.bold) : pkg.source;
        const description = pkg.description ? ` ${style(`— ${pkg.description}`, ANSI.dim)}` : "";
        console.log(`${pointer} ${checked} ${source}${description}`);
      });

      console.log("");
      console.log(style("Space toggle · A all · N none · Enter install · Esc/q cancel", ANSI.dim));
    };

    const onKeypress = (_str, key) => {
      if (finished) return;

      if (key.name === "up") {
        cursor = Math.max(0, cursor - 1);
      } else if (key.name === "down") {
        cursor = Math.min(Math.max(0, packages.length - 1), cursor + 1);
      } else if (key.name === "space") {
        if (packages[cursor]) packages[cursor].selected = !packages[cursor].selected;
      } else if (key.name === "a") {
        packages.forEach((pkg) => {
          pkg.selected = true;
        });
      } else if (key.name === "n") {
        packages.forEach((pkg) => {
          pkg.selected = false;
        });
      } else if (key.name === "return") {
        finish(false);
        return;
      } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        finish(true);
        return;
      }

      render();
    };

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

function style(text, code) {
  return process.stdout.isTTY ? `${code}${text}${ANSI.reset}` : text;
}

function runCommand(command, args) {
  const prepared = prepareCommand(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.command, prepared.args, {
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

function prepareCommand(command, args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }

  return { command, args };
}
