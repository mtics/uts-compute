---
name: confirm-usage
description: Respond to a UTS iHPC node-usage-monitoring email by running confirm_usage <token> on the named node via SSH. Use when the user forwards or pastes an iHPC "confirm you are still using <node>" email.
---

# iHPC Confirm Usage

## When to use

A user receives an automated email from the iHPC Administrator(s) with subject like "You have been logged into and using <node> over 100 hours" that asks them to execute:

```
confirm_usage <TOKEN>
```

on the named node. This skill handles that request.

## What the tool does

`access.confirm_usage` SSHes through the iHPC login gateway (derived from the selected profile) to the named compute node, and runs `confirm_usage <token>` there. It returns whether the command succeeded, plus stdout/stderr.

## Workflow

1. **Extract from email** (parse what the user shows or pastes):
   - Node name: e.g. `turing1`, `gpu001`, `cnode12`
   - Token: alphanumeric string, e.g. `nZCP8HPK`

2. **Confirm with user before acting** — this is a live SSH action:
   > "I'll run `confirm_usage nZCP8HPK` on `turing1` using your `<profileId>` profile. Proceed?"

3. **Select profile** — use `profiles.list` to find the user's iHPC profile (`platform: uts-ihpc`). If there are multiple iHPC profiles, ask the user which to use.

4. **Check connectivity if uncertain** — if the user hasn't recently used iHPC tools in this session, run `access.check` first with `checks: ["ssh-auth"]` to confirm the VPN/SSH path is live.

5. **Run the confirmation**:
   ```
   access.confirm_usage(profileId, node, token)
   ```

6. **Report result**:
   - `confirmed: true` + any stdout → "✓ Usage confirmed on turing1. The iHPC system registered your confirmation."
   - `confirmed: false` (exit_code ≠ 0) → show stderr, suggest checking VPN, retrying, or contacting iHPC support.
   - `timed_out: true` → "The SSH connection timed out. Check that UTS VPN is connected and try again."

## Safety

- Do not run this tool without explicit user confirmation.
- Do not guess the token; only use the exact token from the email.
- Do not modify, shorten, or encode the token — pass it as-is.
- The tool validates the token (alphanumeric, 4–32 chars) before SSH; if validation fails the email token may be malformed — ask the user to re-paste it.

## Stop Conditions

Stop and ask the user if:
- No iHPC profile is configured (`platform: uts-ihpc` not found in `profiles.list`)
- The token contains non-alphanumeric characters (validation will fail; the email may have been corrupted or the user copied it incorrectly)
- `access.check` shows SSH auth failure (VPN likely disconnected)
- The command exits non-zero after 2 attempts
