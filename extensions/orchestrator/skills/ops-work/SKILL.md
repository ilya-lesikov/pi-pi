---
name: ops-work
description: Load BEFORE diagnosing or acting on a real machine, server, cluster or remote host, including the user's own laptop or desktop — anything over ssh, kubectl, helm, sudo, systemctl, a cloud CLI, or a package manager on a system rather than in a project ("install X on the server", "prepare my VPS", "deploy to the cluster", "test this in my kind cluster", "configure nginx", "my laptop won't charge", "wifi keeps dropping", "почини на сервере", "разверни в кластере", "ноутбук не заряжается"). Covers identifying the target, read-only diagnosis first, recoverability, confirming destructive steps, secrets, and verifying after.
---

A codebase has git, so a wrong edit costs a revert. A machine has no undo: a wrong `rm`, a firewall rule that drops your own SSH session, or a `helm upgrade` against the wrong context costs the system. Everything here exists to make each step either harmless or recoverable before you take it.

## Know exactly what you are about to touch

- Name the target before the first command: the host (`hostname`, `uname -a`, `/etc/os-release`), the user and privileges (`id`, whether `sudo` is passwordless), and for Kubernetes the context and namespace (`kubectl config current-context`, `kubectl config view --minify -o jsonpath='{..namespace}'`). Pass `--context` and `-n` explicitly on every mutating command rather than relying on the current setting.
- Distinguish disposable from shared, and production from everything else: a local kind cluster, a personal VPS, a team staging cluster, a customer's production. Say which this is. When it is unclear, it is shared production until the user says otherwise.
- Check what you are allowed to do before planning around it: `kubectl auth can-i <verb> <resource> -n <ns>`, `sudo -l`.
- Never let a command wait for input, because nobody can answer it and the session hangs. Use `ssh -o BatchMode=yes`, `sudo -n`, `kubectl patch` or `apply` rather than `kubectl edit`, `--no-pager` or `PAGER=cat`, `DEBIAN_FRONTEND=noninteractive apt-get -y`, and wrap remote and network commands in `timeout`. A command that needs a password or a host-key confirmation is a question for the user.

## Diagnose read-only first

- Read before changing: status, logs, configuration, recent events (`systemctl status`, `journalctl -u <unit> --since -1h`, `kubectl get events -n <ns> --sort-by=.lastTimestamp`, `kubectl describe`, `dmesg`). Most ops questions are answered here, without changing anything.
- For a hardware or OS question on the user's own machine (it will not charge, it overheats, the disk is full), collect the facts the system already reports before suggesting a fix: the battery and power-supply state from `upower` or `/sys/class/power_supply`, the kernel log, `sensors`.
- When the user asks for a diagnosis, the diagnosis is the deliverable. Do not change anything to "see if it helps" without saying so first.

## Make every change recoverable before you make it

- Back up what you will change: copy the configuration file with a timestamp, `kubectl get <kind> <name> -o yaml` before you edit it, note the current Helm revision (`helm history <release> -n <ns>`), snapshot the database or volume if the step touches data.
- Preview the change wherever the tool supports it: `kubectl diff`, `kubectl apply --dry-run=server`, `helm upgrade --dry-run=server` (add `--hide-secret`, Helm 3.15 or later), `helm diff` if the plugin is installed, `terraform plan`, `nginx -t`, `sshd -t`, `visudo -c`. Show the user the preview for anything not trivially reversible.
- Keep your way back in. Before changing SSH, firewall, network, or sudo configuration on a remote host, keep the current session open, test the new configuration from a second session, and know the console or recovery path if both fail. Never restart `sshd` or enable a firewall without an explicit allow rule for your own connection already in place.
- Prefer the reversible form of each step: a new file over an edited one, `helm upgrade --rollback-on-failure` (`--atomic` before Helm 4), a canary pod before a whole deployment, `systemctl reload` before `restart`.

## Ask before anything destructive

Confirm with the user, naming the exact target and the exact command, before:

- deleting anything (files outside a scratch directory, namespaces, PVCs, releases, databases, users, keys);
- restarting or draining a shared service or node;
- changing auth, network or firewall configuration on a remote host;
- installing or upgrading system packages, kernels, drivers, or anything that needs a reboot;
- any step on shared or production systems that the preview shows as more than you expected.

Approval to "set up the server" is not approval to wipe a disk that turned out not to be empty. When the preview differs from what you described, stop and describe it again.

## Secrets

- Never print a secret into the conversation: no `cat` of key files, no `kubectl get secret -o yaml` without filtering, no `env` dump on a production host. Confirm that a secret exists and check its shape (the keys, the length) without showing its value.
- Do not write credentials into files in a repository, into shell history (prefer reading them from a file or a prompt), or into command lines visible in `ps`.
- Keep keys and tokens where they already live. Copying a credential to a new host is a decision for the user.

## Verify, then clean up

- A command that exits 0 has not proved anything. Check the effect: the service answers on its port, the pod is `Ready` and its logs are clean, the endpoint returns what it should, the setting survives a reload.
- Clean up what you created for testing: scratch pods, temporary files, port-forwards, test namespaces. On a disposable cluster, say what you left behind if anything.
- Report what you changed, on which target, how to undo each change (the backup path, the Helm revision, the command), and what you verified.
