# Morphe CLI Builder

Automated CI/CD pipeline for building and patching Android apps using [Morphe](https://github.com/MorpheApp/morphe-patches) patches.

## Overview

This repository automates the process of:
- Monitoring latest versions of Morphe patches and CLI
- Downloading the latest APKs from APKPure
- Applying Morphe patches to the APKs
- Signing the patched APKs with a secure keystore
- Uploading versioned artifacts

### Supported Apps

- **YouTube** (`com.google.android.youtube`)
- **YouTube Music** (`com.google.android.apps.youtube.music`)
- **Reddit** (`com.reddit.frontpage`)

## Workflow Features

### Version-Based Build Skipping

The workflow automatically tracks dependency versions (Morphe patches and CLI) in `state.json`. The build only runs if:
- Patches or CLI versions have changed
- Manual trigger via `workflow_dispatch`
- Daily schedule (05:15 UTC)

This prevents unnecessary builds and reduces CI resource usage when dependencies haven't changed.

### Versioned Artifacts

Patched APKs are named with version information:
```
morphe-{app}-{patches-version}-v{apk-version}.apk
```

Example: `morphe-youtube-v23.02.01-v19.29.34.apk`

### Secure APK Signing

The workflow signs patched APKs with your keystore stored securely in GitHub Secrets. Only you control the signing key.

## Setup Instructions

### 1. Create a Keystore (Android Signing Key)

If you don't have a keystore yet, create one:

```bash
keytool -genkey -v -keystore morphe.jks -keyalg RSA -keysize 2048 -validity 10000 -alias Key
```

You'll be prompted for:
- **Keystore password**: A strong password to protect the keystore file
- **Key password**: Can be the same or different from keystore password
- **Certificate details**: Your name, organization, country, etc.

Example:
```bash
keytool -genkey -v -keystore morphe.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias Key \
  -dname "CN=Your Name, O=Your Org, C=US"
```

### 2. Encode Keystore for GitHub Secrets

Convert your keystore to Base64 for storage in GitHub Secrets:

```bash
cat morphe.jks | base64 -w 0 > morphe.jks.b64
cat morphe.jks.b64
```

Copy the entire Base64 output.

### 3. Configure GitHub Secrets

Go to your GitHub repository **Settings → Secrets and variables → Actions** and create these secrets:

| Secret Name | Value | Required |
|---|---|---|
| `KEYSTORE_BASE64` | Base64-encoded keystore (from step 2) | ✅ Yes |
| `KEY_ALIAS` | Keystore alias (e.g., `Key`) | ❌ No (defaults to `Key`) |
| `KEYSTORE_PASSWORD` | Keystore password | ❌ No |
| `KEY_PASSWORD` | Key entry password | ❌ No |

**Security Notes:**
- GitHub Secrets are encrypted at rest and only exposed to Actions runs
- The keystore is only available within the workflow, never logged
- Passwords are optional if your keystore doesn't require them
- Delete the local `morphe.jks` file after uploading to secrets
- Never commit the keystore to version control

### 4. Configure Patches

Edit `patches.json` to customize which patches to apply:

```json
{
  "com.google.android.youtube": {
    "Hide ads": true,
    "Video ads": true,
    "Custom branding": false,
    "GmsCore support": true
  },
  "com.google.android.apps.youtube.music": {
    "Hide ads": true
  },
  "com.reddit.frontpage": {
    "Hide ads": true
  }
}
```

Use `true` to enable a patch, `false` to disable it. Commit this file to version control.

## Workflow Execution

### Automatic Triggers

1. **Daily Schedule**: 05:15 UTC every day
2. **Manual Trigger**: Click "Run workflow" in the Actions tab
3. **Version Change**: Automatically (only if patches/CLI versions changed)

### Output

The workflow produces:
- **Artifacts**: Versioned patched APKs in the build artifacts
- **state.json**: Updated with latest patch/CLI versions (committed to repo)
- **Logs**: Build details in Actions tab

### Download Artifacts

1. Go to **Actions** → Latest successful workflow run
2. Scroll to "Artifacts" section
3. Download the desired patched APK

## Use with Obtainium

You can track all 3 apps from the same GitHub repository in Obtainium. You do **not** need separate repositories.

For each app, create a separate Obtainium entry:

1. Source: **GitHub**
2. Repository URL: `https://github.com/<your-user>/<your-repo>`
3. Release tag (exact):
   - YouTube: `morphe-youtube-latest`
   - YouTube Music: `morphe-ytmusic-latest`
   - Reddit: `morphe-reddit-latest`

The workflow also creates versioned historical tags (`morphe-<app>-<patches-version>-v<apk-version>`), but Obtainium should follow the stable `-latest` tags above.

## State File

`state.json` tracks:
- Current Morphe patches version
- Current Morphe CLI version
- Last build timestamp
- Build status

Example:
```json
{
  "patches_version": "v23.02.01",
  "cli_version": "v1.2.3",
  "last_build": "2026-02-21T05:15:00Z",
  "status": "success",
  "build_history": []
}
```

## Troubleshooting

### Build Fails: "No APK downloaded"

- APKPure mirror may be down. Try re-running the workflow.
- Check your network connectivity.
- Try downloading the APK manually from [APKPure](https://apkpure.com).

### Signing Error: "Failed to sign APK"

- Verify `KEYSTORE_BASE64` secret is valid: `echo "$KEYSTORE_BASE64" | base64 -d | file -`
- Check keystore password is correct in `KEYSTORE_PASSWORD` secret
- Ensure `KEY_ALIAS` matches the alias in your keystore: `keytool -list -v -keystore morphe.jks`

### Secrets Not Working

- Verify secrets are set in **Settings → Secrets and variables → Actions**
- Secrets are case-sensitive
- Re-run the workflow after updating secrets

### Version Check Always Skips Build

If you want to force a build despite no version changes:
- Use **Actions** → Click workflow → **Run workflow** (manual dispatch)
- Manually edit `state.json` and set versions to `"none"`

## Best Practices

1. **Keystore Security**
   - Use a strong, unique password
   - Keep the keystore file safe (never commit it)
   - Rotate the keystore periodically
   - Use different keystores for test vs. production

2. **Patches Configuration**
   - Review new patches before enabling (`patches.json`)
   - Test patches locally before full rollout
   - Document your patch choices

3. **Artifact Management**
   - GitHub retains artifacts for 90 days by default
   - Consider storing important builds elsewhere
   - Name artifacts clearly for organization

4. **Monitoring**
   - Subscribe to workflow notifications
   - Check the Actions tab regularly
   - Review build logs for warnings

## Advanced Configuration

### Using Google Play Source

To download APKs directly from Google Play instead of APKPure:

1. Get a Google Play AAS token (instructions: [apkeep docs](https://github.com/EFForg/apkeep/blob/master/USAGE-google-play.md))
2. Add GitHub Secret: `GOOGLE_AAS_TOKEN`
3. Edit the download step in workflow to use:
   ```yaml
   apkeep -a "${{ matrix.appId }}" -d google-play -t "${{ secrets.GOOGLE_AAS_TOKEN }}"
   ```

### Custom Patches Directory

To use custom patches instead of official MorpheApp patches:
1. Host your patches file somewhere accessible (GitHub release, etc.)
2. Modify the workflow "Get latest Morphe patches" step to download from your source

### Disabling Apps

Remove apps from the `matrix.include` section in the workflow:

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - name: youtube
        appId: com.google.android.youtube
      # - name: ytmusic  # Commented out to skip
      #   appId: com.google.android.apps.youtube.music
```

## Environment Variables

The workflow uses these paths internally:

| Variable | Purpose |
|----------|---------|
| `TOOLS_DIR` | Where Morphe patches/CLI are stored |
| `APKS_DIR` | Where downloaded APKs are stored |
| `OUT_DIR` | Where final patched APKs are written |

## Dependencies

The workflow automatically installs:
- **Java 17** (for morphe-cli)
- **jq** (JSON processor)
- **apkeep** (APK downloader)
- **GitHub CLI** (for releases)

No local setup required!

## License

This project is provided as-is for educational purposes. Ensure you comply with:
- App store terms of service
- Local laws regarding app modification
- Morphe license terms

## Resources

- [Morphe Patches](https://github.com/MorpheApp/morphe-patches)
- [Morphe CLI](https://github.com/MorpheApp/morphe-cli)
- [apkeep](https://github.com/EFForg/apkeep)
- [Android Keystore Documentation](https://developer.android.com/studio/publish/app-signing)

## Contributing

Improvements and fixes welcome! Please:
1. Test changes in a fork first
2. Document any new secrets or variables
3. Update this README with changes

## Support

For issues with:
- **Morphe patches/CLI**: Check [MorpheApp repositories](https://github.com/MorpheApp)
- **Keystore/signing**: See Android's [app signing guide](https://developer.android.com/studio/publish/app-signing)
- **APKs**: Try [APKPure site](https://apkpure.com) directly
- **This workflow**: Check GitHub Issues or Actions logs
