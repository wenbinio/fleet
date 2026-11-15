Real Mistral Vibe 3.1.2 headless output, captured 2026-11-16 on Windows with node child_process (stdin closed).
Command shape: vibe --prompt-file P --output streaming --workdir W --trust --output-dir D [extra]
- plain: --max-turns 1, prompt "Reply with the single word OK" -> exit 0, outcome finished.
- readonly-denied: --max-turns 6 --enabled-tools read_file --enabled-tools grep; asked to read note.txt then write out.txt -> exit 0, write_file denied (export warnings), no file written.
- turn-limit: --max-turns 1 --agent accept-edits; asked to write a file then run a shell command -> exit 3, outcome turn_limit; the edit was written (accept-edits auto-approves edits).
- bad-model: -p x --model no-such-model-xyz -> exit 1; stderr lists the account's models (no request is spent).
- missing-key.stderr.txt: the message Vibe printed when a configured provider's key env var was missing (seen with a DeepSeek provider; same shape for any provider).
<case>.export.json is the --output-dir export.json with the machine-specific "config" object removed.
The first stderr line ("Reading API keys from the system keyring ...") is printed on every run and is noise.
