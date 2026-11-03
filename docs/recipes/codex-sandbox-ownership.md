# Codex sandbox can't edit existing files

**Symptom:** a Codex job (`workspace-write`, unelevated Windows sandbox) can create new files in a folder but gets
`Permission denied` / "blocked by policy" on every existing file. A probe that only creates a file passes, so the
problem shows up mid-job.

**Cause:** the files were created by an earlier Codex run and are owned by the sandbox account
(`<machine>\CodexSandboxOffline`), not by you. Each new sandbox run adds its own permission entry to the working
folder and spreads it to the files inside, but changing a file's permissions needs ownership-level rights, which
neither the new sandbox nor your own account has on files another account owns. So the new entry never reaches them.

**Check:**

```powershell
(Get-Acl <file>).Owner        # anything other than you = affected
```

`node setup.mjs --check-owner <dir>` belonged to the old agent-toolkit entry and is not in this repository. The ACL check above is the check here.

**Fix that doesn't touch permissions:** make a fresh clone (you own every file in it), run Codex there, then put it in
place of the old folder (rename the old one aside), or pull the work back. `git` rewriting files also makes them
yours. Leave `.git` alone: Codex deliberately denies the sandbox write access there.

**Prevent it:** probe by editing an existing file, not by creating one. `node setup.mjs --smoke` is not in this repository.
