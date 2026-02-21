# Setup Guide

Quick start guide to get your Morphe CLI Builder up and running.

## Step 1: Create a Keystore (One-time Setup)

```bash
keytool -genkey -v -keystore morphe.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias Key \
  -dname "CN=Your Name, O=Your Org, L=City, ST=State, C=US"
```

When prompted, set a strong password (e.g., at least 16 characters with mixed case, numbers, symbols).

## Step 2: Encode Keystore for Secrets

```bash
# Linux/macOS
cat morphe.jks | base64 -w 0 > morphe.jks.b64
cat morphe.jks.b64

# Windows (PowerShift)
[Convert]::ToBase64String([System.IO.File]::ReadAllBytes("morphe.jks"))
```

Copy the entire Base64 output (it will be very long).

## Step 3: Add GitHub Secrets

1. Go to your repository on GitHub
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret** and add:

| Name | Value |
|------|-------|
| `KEYSTORE_BASE64` | Your Base64 string from Step 2 |
| `KEYSTORE_PASSWORD` | Your keystore password |
| `KEY_PASSWORD` | Your key password (if different from keystore password) |
| `KEY_ALIAS` | `Key` (or whatever alias you created) |

## Step 4: Configure Patches (Optional)

Edit `patches.json` to customize which patches to apply:

```bash
nano patches.json
```

Set `true` to enable patches, `false` to disable them.

## Step 5: Run the Workflow

Option A: **Automatic** (runs daily at 05:15 UTC)
- No action needed! Workflow runs automatically.

Option B: **Manual Trigger**
1. Go to **Actions** tab
2. Select **Build Morphe‑patched apps**
3. Click **Run workflow**

## Step 6: Download APKs

1. Workflow completes in ~15-30 minutes
2. Go to the workflow run
3. Scroll to **Artifacts** section
4. Download your patched APK

## Troubleshooting

**Secrets not working?**
- Double-check secret names (they're case-sensitive)
- Verify you're in the right repository settings

**Keystore decode error?**
- Ensure the Base64 string is complete (long string)
- Check you copied the entire output

**APK signing fails?**
- Verify passwords are correct in GitHub Secrets
- Try re-encoding the keystore

**Need more help?**
- See [README.md](README.md) for detailed documentation
- Check Actions logs for error messages

---

**Security Reminder:** Never commit `morphe.jks` or store unencrypted passwords in code!
