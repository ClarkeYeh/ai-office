# Recorded fixtures

This directory intentionally contains no recordings yet. Only record from the dedicated
public test repository and the explicitly designated run. Never record an unfiltered
Orca inbox or data from personal or unrelated repositories.

Keep raw recordings outside this repository. Sanitize JSON before copying it here:

```sh
scripts/fixtures/sanitize "$RAW_RECORDING" > "$SANITIZED_FIXTURE"
pnpm fixtures:scan
```

Set the output path to a file ending in `*.json` inside this directory.
The sanitizer accepts a filename or stdin and emits JSON to stdout. It masks emails,
provider tokens, private keys, secret fields, high-entropy strings, home usernames,
and hostnames (including URL hosts). Tool inputs/outputs, transcript text, file contents,
command output and body/content/text fields become UTF-8 byte length plus SHA-256.
For fixtures, all body fields are conservatively summarized, including GitHub bodies.
Review the result before committing: heuristics cannot prove provenance or catch every
possible secret. Single-label hosts must use a host/hostname/machine field.

The scanner uses the same rules and rejects raw body fields, malformed JSON, non-JSON
recordings, binary files, symlinks and unsafe filenames. Only README and empty placeholder
files are permitted alongside JSON. It never prints offending data into CI logs.
Redaction can change replay payloads; build adapter tests around the sanitized shape.
A clean CI run does not satisfy M0 acceptance while other root checks remain TODO stubs.
