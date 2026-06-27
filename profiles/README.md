# Profiles

Profiles describe accounts and platform access. Real profiles are local configuration and must not be committed.

Use `profiles.example.yaml` as a template, then create an ignored local file such as:

```text
profiles/profiles.local.yaml
```

Each profile represents exactly one account on exactly one platform.

Do not store passwords, private keys, tokens, or MFA secrets here. Reference SSH config aliases, SSH agent usage, keychain references, or environment variable names instead.
