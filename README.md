# pi-my-setup

Save your Pi package setup as one copy-paste restore command. No git clone, no manifest file, no repo checkout.

## Move your Pi setup to another machine

On the machine that already has your Pi packages configured:

```bash
npx pi-my-setup
```

or explicitly:

```bash
npx pi-my-setup save
```

Copy the printed command into any notes app. It looks like this:

```bash
npx pi-my-setup restore pisetup:v1:eNqV...
```

On a fresh machine, paste and run that command. `pi-my-setup` decodes the setup code, shows the package list, opens the checkbox installer, and runs `pi install <source>` for selected packages.

Setup codes include only shareable Pi package sources from `~/.pi/agent/settings.json`. They do not include secrets, npm tokens, API keys, local paths, manifest files, or machine-specific files.

## What gets restored

`pi-my-setup` does **not** carry over your full Pi settings. It only saves and restores shareable Pi package entries — the npm/git packages that Pi can install, typically packages that provide extensions, skills, tools, or providers.

It does not copy:

- Pi settings/preferences
- model/provider API keys
- auth tokens or npm credentials
- local-only skills or extensions
- local file paths
- machine-specific config

If a skill or extension is only present as a local file on one machine, package it as an npm/git Pi package before expecting `pi-my-setup` to restore it elsewhere.

## Optional global install

You can also install the tool globally if you do not want to type `npx` each time:

```bash
npm install -g pi-my-setup
pi-my-setup save
```

Then restore on another machine with the printed command:

```bash
pi-my-setup restore pisetup:v1:eNqV...
```

## Commands

```bash
npx pi-my-setup                         # print one restore command from ~/.pi/agent/settings.json
npx pi-my-setup save                    # same as default
npx pi-my-setup restore <setup-code>    # decode and install selected packages
npx pi-my-setup decode <setup-code>     # print packages without installing
```

Options:

```bash
--yes, -y      # skip checkbox UI and install every decoded package
--dry-run      # print pi install commands without running them
--help, -h     # show help
```
