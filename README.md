# pi-my-setup

Save and restore your Pi packages and portable skills with one copy-paste command.

## The 10-second version

On the machine that already has your Pi setup:

```bash
npx --yes pi-my-setup@latest save
```

That command:

1. Reads your shareable Pi packages and portable skills.
2. Shows a checkbox list with everything selected by default.
3. Lets you uncheck anything you do not want in the restore command.
4. Prints one restore command for only the selected items.
5. Copies that restore command to your clipboard when clipboard access is available.

On the new machine, paste the copied command and run it.

It will look like this:

```bash
npx pi-my-setup restore pisetup:v2:eNqV...
```

## Recommended usage

Use `npx` if you only need the tool occasionally:

```bash
npx --yes pi-my-setup@latest save
```

In that command, the first `--yes` belongs to `npx`; it only skips the npm download prompt. You will still get the `pi-my-setup` checkbox picker.

Use a global install if you want a permanent `pi-my-setup` command:

```bash
npm install -g pi-my-setup@latest
pi-my-setup save
```

Check the installed global version:

```bash
pi-my-setup --version
# or
pi-my-setup -v
```

## Important: local install vs global install

This does **not** update the `pi-my-setup` command on your PATH:

```bash
npm install pi-my-setup
```

That installs the package into the current project only.

If `pi-my-setup --version` still shows an old version, update the global install:

```bash
npm install -g pi-my-setup@latest
```

Or bypass global installs entirely:

```bash
npx --yes pi-my-setup@latest --version
npx --yes pi-my-setup@latest save
```

## What gets saved

`pi-my-setup save` includes only portable, reinstallable sources:

- Pi packages from `~/.pi/agent/settings.json` with npm/git/URL sources
- global skills with installer metadata in `~/.agents/.skill-lock.json`
- git-backed skill repos under `~/.pi/agent/skills` that have an `origin` remote

## What does not get saved

It never saves machine-specific or secret data:

- API keys
- auth tokens
- npm credentials
- Pi preferences/settings unrelated to package installation
- local-only skills with no installer metadata
- local file paths
- machine-specific config

If a skill is just a local folder, `pi-my-setup` cannot recreate it on another machine. Install that skill through the Skills CLI, put it in a git repo with an `origin` remote, or package it as a Pi package first.

## Skill warning explained

During `save`, you may see something like:

```text
! Note: 1 skill source could not be converted to skills installer commands and was not included.
```

That means at least one skill exists locally but has no portable install source. The restore command still works; it just will not include that local-only skill.

## Commands

```bash
npx --yes pi-my-setup@latest save          # choose what to save, then print and copy one restore command
npx --yes pi-my-setup@latest restore CODE  # install packages and skills from a setup code
npx --yes pi-my-setup@latest decode CODE   # show what is inside a setup code
npx --yes pi-my-setup@latest --version     # show latest package version
```

With a global install:

```bash
pi-my-setup save
pi-my-setup restore CODE
pi-my-setup decode CODE
pi-my-setup --version
pi-my-setup -v
```

Options:

```bash
--yes, -y      Skip checkbox UI and use every decoded/discovered item
--dry-run      Print restore commands without running them
--version, -v  Print pi-my-setup version
--help, -h     Show help
```

## Save flow

When you run `pi-my-setup save`, `pi-my-setup`:

1. Finds portable packages and skills.
2. Shows the same checkbox UI used by restore.
3. Starts with every item checked.
4. Lets you press Space to exclude selected items.
5. Generates the restore command from only the checked items.
6. Copies the generated command to the clipboard when possible.

Use `pi-my-setup`'s `--yes` flag after `save` to skip the checkbox picker and save everything:

```bash
npx --yes pi-my-setup@latest save --yes
```

The two `--yes` flags are different:

- first `--yes`: tells `npx` not to ask before downloading the package
- second `--yes`: tells `pi-my-setup` to select every package and skill

## Restore flow

When you run a restore command, `pi-my-setup`:

1. Decodes the setup code.
2. Shows the package and skill list.
3. Lets you select what to install.
4. Runs `pi install <source>` for selected Pi packages.
5. Runs grouped `npx --yes skills add ...` commands for selected skills.

Use `--yes` to skip selection and install everything:

```bash
npx pi-my-setup restore pisetup:v2:eNqV... --yes
```

Use `--dry-run` to preview commands without installing:

```bash
npx pi-my-setup restore pisetup:v2:eNqV... --dry-run
```
