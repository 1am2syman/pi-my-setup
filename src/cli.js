import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { deflateSync, inflateSync } from "node:zlib";

const PACKAGE_RUN_COMMAND = "npx pi-my-setup";
const PACKAGE_VERSION = readPackageVersion();
const SETUP_CODE_VERSION = 2;
const SETUP_CODE_PREFIX = `pisetup:v${SETUP_CODE_VERSION}:`;
const SUPPORTED_URL_PROTOCOL = /^(https?|ssh|git):\/\//i;
const GITHUB_SHORTHAND_SOURCE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SKILL_NAME = /^[A-Za-z0-9_.:-]+$/;
const UNSAFE_WINDOWS_SOURCE_CHAR = /["%\r\n]/;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

const DEFAULT_DESCRIPTIONS = new Map([
  ["npm:pi-mcp-adapter", "Adds MCP server support."],
  ["npm:pi-init", "Creates AGENTS.md context."],
  ["npm:pi-multi-pass", "Adds multi-pass workflows."],
  ["npm:pi-web-access", "Adds web research tools."],
  ["npm:pi-commandcode-provider", "Adds CommandCode models."],
  ["npm:@howaboua/pi-markdown-workflows", "Adds Markdown workflows."],
  ["npm:pi-image-tools", "Adds image tools."],
  ["npm:pi-agent-browser-native", "Adds browser automation."],
  ["npm:@mermaid-js/mermaid-cli", "Adds Mermaid rendering."],
  ["npm:@cnife/pi-simple-plannotator", "Adds plan annotations."],
]);

export async function runCli(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  if (options.version) {
    printVersion();
    return;
  }

  if (options.command === "save" || options.command === "export") {
    await saveSetupCode(options);
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
    version: false,
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
      case "--version":
      case "-v":
        options.version = true;
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
  npx pi-my-setup                  Select packages and skills, then print one restore command
  npx pi-my-setup save             Select packages and skills, then print one restore command
  npx pi-my-setup restore <code>   Decode a setup code, then install selected packages and skills
  npx pi-my-setup decode <code>    Print packages and skills inside a setup code without installing

Options:
  --yes, -y                        Skip checkbox UI and use every decoded/discovered item
  --dry-run                        Print restore commands without running them
  --version, -v                    Print pi-my-setup version
  --help, -h                       Show this help
`);
}

function printVersion() {
  console.log(PACKAGE_VERSION);
}

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function saveSetupCode(options) {
  const { settingsPath, setup, skillSummary } = await readShareableSetup();
  if (setup.packages.length === 0 && setup.skills.length === 0) {
    throw new Error(`No shareable Pi package sources or skill sources found in ${settingsPath}.`);
  }

  const items = createRestoreItems(setup);
  const result = options.yes ? { cancelled: false, items } : await selectItems(items, {
    summaryVerb: "Save",
    prompt: "Select items to save",
    enterAction: "save",
  });

  if (result.cancelled) {
    console.log(`${style("✕", ANSI.red)} Save cancelled.`);
    return;
  }

  const selectedSetup = createSetupFromSelectedItems(result.items);
  if (selectedSetup.packages.length === 0 && selectedSetup.skills.length === 0) {
    console.log("No items selected.");
    return;
  }

  const restoreCommand = `${PACKAGE_RUN_COMMAND} restore ${encodeSetupCode(selectedSetup)}`;
  console.log(restoreCommand);
  await copyRestoreCommandToClipboard(restoreCommand);
  printSkillMetadataWarning(skillSummary);
}

async function copyRestoreCommandToClipboard(restoreCommand) {
  const result = await copyTextToClipboard(`${restoreCommand}${os.EOL}`);
  if (result.ok) {
    console.error(`${style("✓", ANSI.green)} Copied restore command to clipboard.`);
    return;
  }

  const reason = result.error instanceof Error ? result.error.message : String(result.error);
  console.error(`${style("!", ANSI.yellow)} Could not copy restore command to clipboard. Copy the command above manually.`);
  console.error(style(`  ${reason}`, ANSI.dim));
}

async function copyTextToClipboard(text) {
  const candidates = getClipboardCommands();
  let lastError = new Error("No supported clipboard command found for this platform");

  for (const candidate of candidates) {
    const result = await runClipboardCommand(candidate, text);
    if (result.ok) {
      return result;
    }
    lastError = result.error;
  }

  return { ok: false, error: lastError };
}

function getClipboardCommands() {
  if (process.platform === "win32") {
    return [{ command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "clip"] }];
  }

  if (process.platform === "darwin") {
    return [{ command: "pbcopy", args: [] }];
  }

  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

function runClipboardCommand(candidate, text) {
  return new Promise((resolve) => {
    const child = spawn(candidate.command, candidate.args, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => {
      finish({ ok: false, error: new Error(`${candidate.command} timed out`) });
      child.kill();
    }, 2500);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish({ ok: false, error }));
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }

      const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
      finish({ ok: false, error: new Error(`${candidate.command} exited with code ${code}${suffix}`) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

function printDecodedSetupCode(setupCode) {
  printDecodedSetup(decodeSetupCode(setupCode));
}

async function restoreSetupCode(setupCode, options) {
  const setup = decodeSetupCode(setupCode);
  const items = createRestoreItems(setup);

  if (options.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    printDecodedSetup(setup);
    console.log("");
  }

  await installSetupItems(items, options);
}

function createRestoreItems(setup) {
  return [
    ...setup.packages.map((source) => ({
      kind: "package",
      source,
      label: source,
      description: DEFAULT_DESCRIPTIONS.get(source) || "Pi package",
      selected: true,
    })),
    ...setup.skills.map((skill) => ({
      kind: "skill",
      source: skill.source,
      skill: skill.skill,
      label: `${skill.source}@${skill.skill}`,
      description: "Agent skill",
      selected: true,
    })),
  ];
}

function createSetupFromSelectedItems(items) {
  const selected = items.filter((item) => item.selected);
  return {
    packages: selected.filter((item) => item.kind === "package").map((item) => item.source),
    skills: selected
      .filter((item) => item.kind === "skill")
      .map((item) => ({ source: item.source, skill: item.skill })),
  };
}

function printDecodedSetup(setup) {
  console.log(`Decoded ${setup.packages.length} package(s) and ${setup.skills.length} skill(s):`);
  if (setup.packages.length > 0) {
    console.log("Packages:");
    for (const source of setup.packages) {
      console.log(`- ${source}`);
    }
  }
  if (setup.skills.length > 0) {
    console.log("Skills:");
    for (const skill of setup.skills) {
      console.log(`- ${skill.source}@${skill.skill}`);
    }
  }
}

function encodeSetupCode(setup) {
  const payload = JSON.stringify({
    v: SETUP_CODE_VERSION,
    packages: normalizeSetupPackageSources(setup.packages ?? []),
    skills: normalizeSetupSkills(setup.skills ?? []),
  });
  const encoded = deflateSync(Buffer.from(payload, "utf8")).toString("base64url");
  return `${SETUP_CODE_PREFIX}${encoded}`;
}

function decodeSetupCode(setupCode) {
  if (typeof setupCode !== "string") {
    throw new Error(`Setup code must start with pisetup:v<version>:`);
  }

  const match = /^pisetup:v(\d+):(.+)$/.exec(setupCode);
  if (!match) {
    throw new Error(`Setup code must start with pisetup:v<version>:`);
  }

  const prefixVersion = Number(match[1]);
  if (![1, SETUP_CODE_VERSION].includes(prefixVersion)) {
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

  return normalizeSetupPayload(payload, prefixVersion);
}

function normalizeSetupPayload(payload, prefixVersion) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Setup code payload must be a JSON object");
  }

  const allowedKeys = prefixVersion === 1 ? new Set(["v", "packages"]) : new Set(["v", "packages", "skills"]);
  const unknownKey = Object.keys(payload).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new Error(`Setup code payload contains unsupported field: ${unknownKey}`);
  }

  if (payload.v !== prefixVersion) {
    throw new Error(`Unsupported setup code version: ${payload.v}`);
  }

  if (!Array.isArray(payload.packages)) {
    throw new Error("Setup code payload packages must be an array");
  }

  return {
    packages: normalizeSetupPackageSources(payload.packages),
    skills: prefixVersion === 1 ? [] : normalizeSetupSkills(payload.skills ?? []),
  };
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

    assertSafeRestoreArgument(source, `Setup code packages[${index}]`);
    byIdentity.set(sourceIdentity(source), source);
  });

  return [...byIdentity.values()];
}

function normalizeSetupSkills(skills) {
  if (!Array.isArray(skills)) {
    throw new Error("Setup code payload skills must be an array");
  }

  const byIdentity = new Map();
  skills.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Setup code skills[${index}] must be an object`);
    }

    const unknownKey = Object.keys(entry).find((key) => key !== "source" && key !== "skill");
    if (unknownKey) {
      throw new Error(`Setup code skills[${index}] contains unsupported field: ${unknownKey}`);
    }

    const source = typeof entry.source === "string" ? entry.source.trim() : "";
    const skill = typeof entry.skill === "string" ? entry.skill.trim() : "";
    if (!isSupportedSkillSource(source)) {
      throw new Error(`Setup code skills[${index}].source must be a GitHub repo or URL: ${source || "<empty>"}`);
    }
    if (!SKILL_NAME.test(skill)) {
      throw new Error(`Setup code skills[${index}].skill must be a skill name: ${skill || "<empty>"}`);
    }

    assertSafeRestoreArgument(source, `Setup code skills[${index}].source`);
    assertSafeRestoreArgument(skill, `Setup code skills[${index}].skill`);
    byIdentity.set(`${source.toLowerCase()}@${skill.toLowerCase()}`, { source, skill });
  });

  return [...byIdentity.values()];
}

function assertSafeRestoreArgument(value, label) {
  if (UNSAFE_WINDOWS_SOURCE_CHAR.test(value)) {
    throw new Error(`${label} contains unsupported shell characters: ${value}`);
  }
}

function isSupportedSource(source) {
  return source.startsWith("npm:") || source.startsWith("git:") || SUPPORTED_URL_PROTOCOL.test(source);
}

function isSupportedSkillSource(source) {
  return GITHUB_SHORTHAND_SOURCE.test(source) || SUPPORTED_URL_PROTOCOL.test(source);
}

async function installSetupItems(items, options) {
  const result = options.yes ? { cancelled: false, items } : await selectItems(items);

  if (result.cancelled) {
    console.log(`${style("✕", ANSI.red)} Restore cancelled.`);
    return;
  }

  const selected = result.items.filter((item) => item.selected);
  const packages = selected.filter((item) => item.kind === "package");
  const skills = selected.filter((item) => item.kind === "skill");
  const skillGroups = groupSkillsBySource(skills);
  const operationCount = packages.length + skillGroups.length;

  if (operationCount === 0) {
    console.log("No items selected.");
    return;
  }

  const verb = options.dryRun ? "Previewing" : "Installing";
  console.log(
    `${style("◆", ANSI.cyan)} ${verb} ${packages.length} package${packages.length === 1 ? "" : "s"} and ${skills.length} skill${skills.length === 1 ? "" : "s"}`,
  );

  let operationIndex = 1;
  for (const pkg of packages) {
    const commandText = `pi install ${pkg.source}`;
    if (options.dryRun) {
      console.log(`${style("$", ANSI.dim)} ${commandText}`);
      operationIndex += 1;
      continue;
    }

    await runCommandQuiet("pi", ["install", pkg.source], {
      label: `Installing ${pkg.source}`,
      index: operationIndex,
      total: operationCount,
    });
    operationIndex += 1;
  }

  for (const group of skillGroups) {
    const args = ["--yes", "skills", "add", group.source, "-g", "--yes", "--full-depth", "--skill", ...group.skills];
    const commandText = `npx ${args.join(" ")}`;
    if (options.dryRun) {
      console.log(`${style("$", ANSI.dim)} ${commandText}`);
      operationIndex += 1;
      continue;
    }

    await runCommandQuiet("npx", args, {
      label: `Installing ${group.skills.length} skill${group.skills.length === 1 ? "" : "s"} from ${group.source}`,
      index: operationIndex,
      total: operationCount,
    });
    operationIndex += 1;
  }

  console.log(`${style("✓", ANSI.green)} ${options.dryRun ? "Dry run complete." : "Restore complete."}`);
}

function groupSkillsBySource(skills) {
  const groups = new Map();
  for (const skill of skills) {
    const existing = groups.get(skill.source) ?? [];
    existing.push(skill.skill);
    groups.set(skill.source, existing);
  }
  return [...groups.entries()].map(([source, groupSkills]) => ({ source, skills: groupSkills }));
}

async function readShareableSetup() {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  if (!existsSync(settingsPath)) {
    throw new Error(`Pi settings not found: ${settingsPath}`);
  }

  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const skillResult = await readShareableSkills(settings);
  return {
    settingsPath,
    setup: {
      packages: extractSupportedPackageSources(settings.packages ?? []),
      skills: skillResult.skills,
    },
    skillSummary: skillResult.summary,
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

async function readShareableSkills(settings) {
  const agentSkillsRoot = path.join(os.homedir(), ".agents", "skills");
  const piSkillsRoot = path.join(os.homedir(), ".pi", "agent", "skills");
  const lockPath = path.join(os.homedir(), ".agents", ".skill-lock.json");
  const installedSkillNames = await getInstalledSkillNames(agentSkillsRoot);
  const piSkillResult = await readPiSkillRepoSources(piSkillsRoot);
  const settingsSkillLocations = Array.isArray(settings.skills) ? settings.skills.length : 0;

  const skills = [...piSkillResult.skills];
  let missingMetadataSkills = piSkillResult.missingMetadataSkills;

  if (!existsSync(lockPath)) {
    missingMetadataSkills += installedSkillNames.size;
    const normalizedSkills = normalizeSetupSkills(skills);
    return {
      skills: normalizedSkills,
      summary: {
        includedSkills: normalizedSkills.length,
        missingMetadataSkills,
        settingsSkillLocations,
      },
    };
  }

  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const lockSkills = lock && typeof lock === "object" && lock.skills && typeof lock.skills === "object" ? lock.skills : {};

  for (const skillName of installedSkillNames) {
    const metadata = lockSkills[skillName];
    const source = metadata ? getSkillInstallSource(metadata) : "";
    if (!source) {
      missingMetadataSkills += 1;
      continue;
    }
    skills.push({ source, skill: skillName });
  }

  const normalizedSkills = normalizeSetupSkills(skills);
  return {
    skills: normalizedSkills,
    summary: {
      includedSkills: normalizedSkills.length,
      missingMetadataSkills,
      settingsSkillLocations,
    },
  };
}

function getSkillInstallSource(metadata) {
  const source = typeof metadata.source === "string" ? metadata.source.trim() : "";
  if (isSupportedSkillSource(source)) {
    return source;
  }

  const sourceUrl = typeof metadata.sourceUrl === "string" ? metadata.sourceUrl.trim() : "";
  if (isSupportedSkillSource(sourceUrl)) {
    return sourceUrl;
  }

  return "";
}

async function getInstalledSkillNames(root) {
  const names = new Set();
  if (!existsSync(root)) {
    return names;
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(path.join(root, entry.name, "SKILL.md"))) {
      names.add(entry.name);
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
      names.add(path.basename(entry.name, ".md"));
    }
  }
  return names;
}

async function readPiSkillRepoSources(root) {
  if (!existsSync(root)) {
    return { skills: [], missingMetadataSkills: 0 };
  }

  const skills = [];
  let missingMetadataSkills = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillRoot = path.join(root, entry.name);
    const repoSource = await readGitRepoSource(skillRoot);
    if (!repoSource) {
      if (existsSync(path.join(skillRoot, "SKILL.md"))) {
        missingMetadataSkills += 1;
      }
      continue;
    }

    const rootSkillPath = path.join(skillRoot, "SKILL.md");
    if (existsSync(rootSkillPath)) {
      skills.push({ source: repoSource, skill: await readSkillName(rootSkillPath, entry.name) });
    }

    const childEntries = await readdir(skillRoot, { withFileTypes: true });
    for (const childEntry of childEntries) {
      if (!childEntry.isDirectory()) {
        continue;
      }

      const childSkillPath = path.join(skillRoot, childEntry.name, "SKILL.md");
      if (existsSync(childSkillPath)) {
        skills.push({ source: repoSource, skill: await readSkillName(childSkillPath, childEntry.name) });
      }
    }
  }

  return { skills, missingMetadataSkills };
}

async function readGitRepoSource(repoRoot) {
  const configPath = path.join(repoRoot, ".git", "config");
  if (!existsSync(configPath)) {
    return "";
  }

  const config = await readFile(configPath, "utf8");
  const match = /\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*([^\n]+)/.exec(config);
  const source = match ? normalizeGithubSource(match[1].trim()) : "";
  return isSupportedSkillSource(source) ? source : "";
}

function normalizeGithubSource(source) {
  const httpsMatch = /^https:\/\/github\.com\/([^/]+\/[^/.]+(?:\.[^/.]+)*)\.git$/i.exec(source);
  if (httpsMatch) {
    return httpsMatch[1];
  }

  const httpsNoGitMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(source);
  if (httpsNoGitMatch) {
    return httpsNoGitMatch[1].replace(/\.git$/i, "");
  }

  const sshMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(source);
  if (sshMatch) {
    return sshMatch[1];
  }

  return source;
}

async function readSkillName(skillPath, fallback) {
  const content = await readFile(skillPath, "utf8");
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!frontmatter) {
    return fallback;
  }

  const nameMatch = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(frontmatter[1]);
  return nameMatch ? nameMatch[1].trim() : fallback;
}

function printSkillMetadataWarning(summary) {
  const notPortableCount = summary.missingMetadataSkills + summary.settingsSkillLocations;
  if (notPortableCount === 0) {
    return;
  }

  console.error(
    `${style("!", ANSI.yellow)} Note: ${notPortableCount} skill source${notPortableCount === 1 ? "" : "s"} could not be converted to skills installer commands and ${notPortableCount === 1 ? "was" : "were"} not included.`,
  );
  console.error(
    style(
      `  Included ${summary.includedSkills} skill${summary.includedSkills === 1 ? "" : "s"} from lock metadata or git remotes. Skills without .agents/.skill-lock.json metadata, a git origin remote, or settings.skills installer metadata are not portable yet.`,
      ANSI.dim,
    ),
  );
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

async function selectItems(inputItems, labels = {}) {
  const items = inputItems.map((item) => ({ ...item }));
  const summaryVerb = labels.summaryVerb || "Restore";
  const prompt = labels.prompt || "Select items to install";
  const enterAction = labels.enterAction || "install";
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { cancelled: false, items };
  }

  let cursor = 0;
  let finished = false;
  let scrollRowOffset = 0;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?25l");

  return await new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h\n");
    };

    const finish = (cancelled) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({ cancelled, items });
    };

    const render = () => {
      const selectedCount = items.filter((item) => item.selected).length;
      const rows = buildPickerRows(items);
      const listHeight = getPickerListHeight();
      const cursorRowIndex = Math.max(0, rows.findIndex((row) => row.itemIndex === cursor));

      if (cursorRowIndex < scrollRowOffset) {
        scrollRowOffset = cursorRowIndex;
      } else if (cursorRowIndex >= scrollRowOffset + listHeight) {
        scrollRowOffset = cursorRowIndex - listHeight + 1;
      }

      const visibleRows = rows.slice(scrollRowOffset, scrollRowOffset + listHeight);
      const firstVisible = Math.min(rows.length, scrollRowOffset + 1);
      const lastVisible = Math.min(rows.length, scrollRowOffset + visibleRows.length);

      process.stdout.write("\x1b[2J\x1b[H");
      console.log(`${style("◆", ANSI.cyan)} ${style("pi-my-setup", ANSI.bold)}`);
      console.log(
        style(
          `${summaryVerb} ${items.length} shareable item${items.length === 1 ? "" : "s"} · showing ${firstVisible}-${lastVisible} of ${rows.length}`,
          ANSI.dim,
        ),
      );
      console.log("");
      console.log(`${style(prompt, ANSI.bold)} ${style(`(${selectedCount}/${items.length} selected)`, ANSI.dim)}`);
      console.log("");

      for (const row of visibleRows) {
        console.log(formatPickerRow(row, cursor));
      }

      console.log("");
      console.log(style(`↑/↓ move · Space toggle · A all · N none · Enter ${enterAction} · Esc/q cancel`, ANSI.dim));
    };

    const onKeypress = (_str, key) => {
      if (finished) return;

      if (key.name === "up") {
        cursor = Math.max(0, cursor - 1);
      } else if (key.name === "down") {
        cursor = Math.min(Math.max(0, items.length - 1), cursor + 1);
      } else if (key.name === "space") {
        if (items[cursor]) items[cursor].selected = !items[cursor].selected;
      } else if (key.name === "a") {
        items.forEach((item) => {
          item.selected = true;
        });
      } else if (key.name === "n") {
        items.forEach((item) => {
          item.selected = false;
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

function buildPickerRows(items) {
  const rows = [];
  let previousKind = "";
  items.forEach((item, index) => {
    if (item.kind !== previousKind) {
      rows.push({ type: "heading", label: item.kind === "skill" ? "Skills" : "Packages" });
      previousKind = item.kind;
    }
    rows.push({ type: "item", item, itemIndex: index });
  });
  return rows;
}

function getPickerListHeight() {
  const fixedRows = 8;
  const terminalRows = process.stdout.rows || 24;
  return Math.max(1, terminalRows - fixedRows);
}

function formatPickerRow(row, cursor) {
  const columns = process.stdout.columns || 100;
  if (row.type === "heading") {
    return style(truncateText(row.label, columns), ANSI.bold);
  }

  const active = row.itemIndex === cursor;
  const pointer = active ? style("❯", ANSI.cyan) : " ";
  const checked = row.item.selected ? style("●", ANSI.green) : style("○", ANSI.dim);
  const content = truncateText(`${row.item.label}${row.item.description ? ` — ${row.item.description}` : ""}`, Math.max(1, columns - 4));
  const label = active ? style(content, ANSI.bold) : content;
  return `${pointer} ${checked} ${label}`;
}

function truncateText(text, width) {
  if (text.length <= width) {
    return text;
  }
  if (width <= 1) {
    return "";
  }
  return `${text.slice(0, width - 1)}…`;
}

function style(text, code) {
  return process.stdout.isTTY ? `${code}${text}${ANSI.reset}` : text;
}

function runCommandQuiet(command, args, progress) {
  const prepared = prepareCommand(command, args);
  const commandText = `${command} ${args.join(" ")}`;
  const output = [];
  const progressLine = startProgress(progress);

  return new Promise((resolve, reject) => {
    const child = spawn(prepared.command, prepared.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => appendOutput(output, chunk));
    child.stderr.on("data", (chunk) => appendOutput(output, chunk));

    child.on("error", (error) => {
      progressLine.stop(false);
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        progressLine.stop(true);
        resolve();
        return;
      }

      progressLine.stop(false);
      const details = output.join("").trim();
      if (details) {
        console.error(details);
      }
      reject(new Error(`${commandText} failed with exit code ${code}`));
    });
  });
}

function appendOutput(output, chunk) {
  output.push(chunk.toString());
  const joined = output.join("");
  if (joined.length > 20_000) {
    output.splice(0, output.length, joined.slice(-20_000));
  }
}

function startProgress({ label, index, total }) {
  if (!process.stdout.isTTY) {
    console.log(`${index}/${total} ${label}...`);
    return { stop: () => {} };
  }

  const frames = ["▰▱▱▱▱▱▱▱", "▰▰▱▱▱▱▱▱", "▰▰▰▱▱▱▱▱", "▰▰▰▰▱▱▱▱", "▰▰▰▰▰▱▱▱", "▰▰▰▰▰▰▱▱", "▰▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰▰"];
  let frame = 0;

  const render = () => {
    const bar = style(frames[frame % frames.length], ANSI.cyan);
    process.stdout.write(`\r${style("→", ANSI.cyan)} ${index}/${total} ${label} ${bar}`);
    frame += 1;
  };

  render();
  const timer = setInterval(render, 120);

  return {
    stop(success) {
      clearInterval(timer);
      clearProgressLine();
      const icon = success ? style("✓", ANSI.green) : style("✕", ANSI.red);
      console.log(`${icon} ${index}/${total} ${label}`);
    },
  };
}

function clearProgressLine() {
  process.stdout.write("\r\x1b[2K");
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
