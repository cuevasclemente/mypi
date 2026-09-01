---
name: secret-safe-oauth-migration
description: Migrate OAuth credentials and API tokens to new locations without reading or exposing secret values. Inventory by metadata, update configs, preserve permissions, and verify authentication—all while keeping secrets opaque.
---

# secret-safe-oauth-migration

Reusable workflow for moving OAuth credentials, API tokens, and service keys to new locations or environments without ever displaying, logging, or exposing the secret values themselves.

## Setup

**Prerequisites:**
- Access to the system/environment containing the credentials (but not necessarily the values)
- Knowledge of which services/apps use the credentials
- Target destination paths or environment variable names
- Backup strategy in place

**Safety principles:**
- Never `cat`, `less`, `head`, `tail`, `grep`, or `echo` credential file contents
- Never print environment variables containing secrets (`echo $SECRET_VAR`)
- Never read shell history files that may contain tokens
- Use metadata-only commands: `ls -l`, `stat`, `file`, `wc -l`, path/name searches
- Ask the user to manually move/set secrets when values are required
- Preserve permissions and ownership throughout

## Workflow

### 1. Inventory existing credential locations

Locate credential files and references **by path, name, and metadata only**:

```bash
# Find credential files by naming patterns (does not read contents)
find ~ -type f \( -name "*.json" -o -name ".env*" -o -name "*credentials*" -o -name "*token*" -o -name "*key" \) 2>/dev/null | head -20

# Check metadata: size, permissions, modification time
ls -lh ~/.config/gcloud/application_default_credentials.json
stat ~/.aws/credentials

# Find config files that reference credential paths (not secret values)
grep -R --include="*.{conf,config,yaml,yml,toml,json}" "credentials" ~/.config/ 2>/dev/null | grep -v ".git"

# Find environment variable references in config files (names only, not values)
grep -R --include="*.{sh,bash,env}" "export.*TOKEN\|export.*KEY\|export.*SECRET" ~/.bashrc ~/.profile ~/.zshrc 2>/dev/null
```

Document findings:
- File paths
- File permissions (mode, owner, group)
- Last modified timestamp
- Size (to verify integrity after move)
- Which configs reference them

### 2. Identify dependencies

Find which processes, services, or applications depend on these credentials:

```bash
# Search application config for credential path references (not contents)
grep -l "credentials.json" ~/.config/*/config 2>/dev/null

# Check systemd services that might reference credential files
grep -l "EnvironmentFile\|Environment.*TOKEN" ~/.config/systemd/user/*.service 2>/dev/null

# Document process environment variable names (not values)
systemctl --user show my-service.service | grep -E "^Environment="
```

Create a dependency map:
- Service/app name → credential file path or env var name
- Config file locations that need updates
- Restart commands required after migration

### 3. Plan the migration

Define:
- **Source paths:** current credential locations
- **Target paths:** new credential locations or env var names
- **Config updates:** files that reference old paths and need edits
- **Rollback plan:** how to restore if migration fails

Example plan document:
```
Source: ~/.config/old-app/credentials.json (644, 1.2KB)
Target: ~/.config/new-app/credentials.json
Configs to update:
  - ~/.config/new-app/config.yaml (line 12: credential_path)
  - ~/.bashrc (export OLD_APP_CREDS → NEW_APP_CREDS)
Restart: systemctl --user restart new-app.service
Rollback: mv ~/.config/new-app/credentials.json.backup ~/.config/new-app/credentials.json
```

### 4. Create target directory structure

Prepare destination directories with correct permissions:

```bash
# Create target directory
mkdir -p ~/.config/new-app

# Match permissions from source directory
SOURCE_MODE=$(stat -c '%a' ~/.config/old-app)
chmod "$SOURCE_MODE" ~/.config/new-app

# Verify
ls -ld ~/.config/new-app
```

### 5. Move credentials (user action)

**Agent:** Do not read, copy, or move credential files yourself. Instruct the user:

> **User action required:**
> 1. Manually move the credential file from `SOURCE` to `TARGET`
> 2. Preserve permissions: `chmod OCTAL_MODE TARGET`
> 3. Verify file size matches: `ls -lh TARGET` should show SIZE
> 4. Confirm: Reply "done" when complete

Or for environment variables:

> **User action required:**
> 1. Read the old credential value from `OLD_PATH` or `$OLD_VAR`
> 2. Set the new environment variable: `export NEW_VAR="<value>"`
> 3. Add to profile if persistent: `echo 'export NEW_VAR="..."' >> ~/.bashrc`
> 4. Confirm: Reply "done" when complete

### 6. Update configuration references

Edit config files to point to new locations:

```bash
# Update credential path in app config (use sed or manual edit)
# BEFORE: credential_path: ~/.config/old-app/credentials.json
# AFTER:  credential_path: ~/.config/new-app/credentials.json

# Safe pattern: make backup, edit, validate syntax
cp ~/.config/new-app/config.yaml ~/.config/new-app/config.yaml.backup
sed -i 's|~/.config/old-app/credentials.json|~/.config/new-app/credentials.json|g' ~/.config/new-app/config.yaml

# Validate YAML syntax without printing secrets
yamllint ~/.config/new-app/config.yaml || echo "YAML syntax error, restoring backup"
```

For environment variables in shell configs:

```bash
# Update .bashrc, .profile, etc. (do not print values)
# BEFORE: export OLD_VAR="/old/path"
# AFTER:  export NEW_VAR="/new/path"

cp ~/.bashrc ~/.bashrc.backup
sed -i 's/export OLD_VAR=/export NEW_VAR=/g' ~/.bashrc

# Reload
source ~/.bashrc
```

### 7. Verify authentication

Test that services can authenticate with the migrated credentials **without exposing secrets**:

```bash
# Test authentication (command depends on service)
# Examples:

# Google Cloud
gcloud auth application-default print-access-token > /dev/null && echo "✓ GCloud auth works" || echo "✗ GCloud auth failed"

# AWS
aws sts get-caller-identity --query 'Account' --output text && echo "✓ AWS auth works" || echo "✗ AWS auth failed"

# Generic service
curl -f -s -o /dev/null -w "%{http_code}" https://api.example.com/v1/auth/verify && echo "✓ API auth works" || echo "✗ API auth failed"

# Systemd service
systemctl --user restart my-service.service
systemctl --user is-active my-service.service && echo "✓ Service running" || echo "✗ Service failed"
journalctl --user -u my-service.service -n 20 --no-pager | grep -i "auth\|error"
```

### 8. Clean up old credentials

Only after successful verification:

```bash
# Securely remove old credential file
shred -u ~/.config/old-app/credentials.json

# Or move to secure archive (not trash)
mkdir -p ~/.local/share/old-credentials-archive
mv ~/.config/old-app/credentials.json ~/.local/share/old-credentials-archive/credentials-$(date +%Y%m%d).json.bak
chmod 600 ~/.local/share/old-credentials-archive/*

# Remove old environment variable references from shell configs
# (Edit manually; do not use grep to search history files)
```

### 9. Update documentation

Record the migration in project/system documentation:

- New credential locations
- New environment variable names
- Date of migration
- Services affected
- Rollback instructions (if backup retained)

## Validation Checklist

- [ ] Located all credential files by path/name without reading contents
- [ ] Documented original file permissions, size, and modification time
- [ ] Identified all config files and services that reference credentials
- [ ] Created target directory structure with correct permissions
- [ ] User manually moved credential files or set environment variables
- [ ] Verified target file size/permissions match source metadata
- [ ] Updated all config file references to new paths/env var names
- [ ] Reloaded/restarted affected services
- [ ] Verified authentication works with migrated credentials
- [ ] No secrets were printed to terminal, logs, or shell history
- [ ] Old credentials securely removed or archived
- [ ] Migration documented for future reference

## Rollback

If authentication fails after migration:

```bash
# Restore config backup
cp ~/.config/new-app/config.yaml.backup ~/.config/new-app/config.yaml

# Restore credential file (if backed up)
cp ~/.config/old-app/credentials.json.backup ~/.config/old-app/credentials.json

# Restore shell config
cp ~/.bashrc.backup ~/.bashrc
source ~/.bashrc

# Restart service
systemctl --user restart my-service.service

# Re-verify
systemctl --user is-active my-service.service
```

## Examples

### Example 1: Migrate Google Cloud credentials to new project directory

```bash
# 1. Inventory
ls -lh ~/.config/gcloud/application_default_credentials.json
# Output: -rw------- 1 user user 2.3K Jan 15 10:32 ...

# 2. Find dependencies
grep -r "application_default_credentials" ~/.config/ 2>/dev/null

# 3. Create target
mkdir -p ~/projects/new-project/.gcloud
chmod 700 ~/projects/new-project/.gcloud

# 4. User action (agent instructs, does not execute)
# User runs: cp ~/.config/gcloud/application_default_credentials.json ~/projects/new-project/.gcloud/
# User runs: chmod 600 ~/projects/new-project/.gcloud/application_default_credentials.json

# 5. Update app config
sed -i 's|~/.config/gcloud/application_default_credentials.json|~/projects/new-project/.gcloud/application_default_credentials.json|g' ~/projects/new-project/config.yaml

# 6. Verify
export GOOGLE_APPLICATION_CREDENTIALS=~/projects/new-project/.gcloud/application_default_credentials.json
gcloud auth application-default print-access-token > /dev/null && echo "✓ Auth works"

# 7. Archive old credential
mkdir -p ~/.local/share/old-credentials-archive
mv ~/.config/gcloud/application_default_credentials.json ~/.local/share/old-credentials-archive/gcloud-creds-$(date +%Y%m%d).json.bak
```

### Example 2: Migrate API token from .env file to environment variable

```bash
# 1. Inventory (do not cat .env)
ls -lh ~/old-project/.env
stat ~/old-project/.env

# 2. Find references
grep -l "\.env" ~/old-project/*.{py,js,sh} 2>/dev/null

# 3. User action (agent instructs)
# User reads ~/old-project/.env manually, finds API_TOKEN value
# User sets: export NEW_PROJECT_API_TOKEN="<value from .env>"
# User adds to ~/.bashrc: echo 'export NEW_PROJECT_API_TOKEN="..."' >> ~/.bashrc

# 4. Update application code to use new env var name
# (Agent edits code to replace os.getenv("API_TOKEN") with os.getenv("NEW_PROJECT_API_TOKEN"))

# 5. Verify
source ~/.bashrc
# Test app (do not echo $NEW_PROJECT_API_TOKEN)
python ~/new-project/test_auth.py && echo "✓ Auth works"

# 6. Securely remove old .env
shred -u ~/old-project/.env
```

### Example 3: Consolidate multiple OAuth tokens into a credential manager

```bash
# 1. Inventory multiple tokens (metadata only)
find ~/projects -name "*token*" -o -name "*credentials.json" 2>/dev/null
ls -lh ~/projects/app1/token.json ~/projects/app2/.env ~/projects/app3/credentials.json

# 2. User action: migrate to credential manager
# User manually loads each token into pass/1Password/Vault:
#   pass insert projects/app1/oauth_token
#   pass insert projects/app2/api_key
#   pass insert projects/app3/service_account

# 3. Update application configs to fetch from credential manager
# BEFORE: token = open("token.json").read()
# AFTER:  token = subprocess.check_output(["pass", "show", "projects/app1/oauth_token"]).decode().strip()

# 4. Verify each application
./projects/app1/verify.sh && echo "✓ App1 auth works"
./projects/app2/verify.sh && echo "✓ App2 auth works"
./projects/app3/verify.sh && echo "✓ App3 auth works"

# 5. Securely remove old credential files
shred -u ~/projects/app1/token.json ~/projects/app2/.env ~/projects/app3/credentials.json
```

## Notes

- **Never trust shell history:** Do not `grep ~/.bash_history` for tokens; history may contain accidentally-pasted secrets
- **Never log secrets:** Ensure application logs do not print credential values during verification
- **Use secure move:** `mv` is safe (atomic on same filesystem); avoid `cp` then `rm` for secrets when possible
- **Consider credential managers:** For complex migrations, consolidating into `pass`, `1Password CLI`, or HashiCorp Vault improves long-term security
- **Audit after migration:** Use `grep -r` to verify old paths/env var names are fully removed from configs
- **Session cleanup:** If this migration happened in an agent session, ensure no secrets were written to session logs or terminal scrollback

## Related Skills

- `memoriki` — for recording credential location conventions in your knowledge base
- Security extension synchronization workflow (AGENTS.md) — for managing pi's own credential access policies
