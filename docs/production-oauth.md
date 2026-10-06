# Set up a production Google OAuth app

Use this guide when you want Google Tools MCP to keep working without weekly Google consent. You create and control your own Google Cloud project and OAuth client; the project does not provide a shared Google OAuth application.

## 1. Create the project and client

Follow the [Quick Start](../README.md#quick-start) to enable the required Google Workspace APIs and provide OAuth credentials. Choose **Desktop application** when creating the OAuth client. You can reuse an existing project and Desktop client.

Keep the client secret and downloaded credentials out of Git. The recommended credential directory is `~/.config/google-tools-mcp/`, or its configured profile directory.

## 2. Configure branding

Select your project in [Google Auth Platform → Branding](https://console.cloud.google.com/auth/branding). Set an app name, your own user support email and developer contact email.

For a personal, self-hosted installation whose data handling matches the [project privacy policy](../PRIVACY.md), these are the reusable links:

- **Application home page:** https://github.com/karthikcsq/google-tools-mcp
- **Application privacy policy link:** https://github.com/karthikcsq/google-tools-mcp/blob/main/PRIVACY.md
- **Authorized domain:** `github.com`. Add it if the console reports a missing domain. Save the form.

The policy covers the MCP server's basic behavior. Review your MCP client's and AI provider's handling of Google data before authorizing them. If your deployment handles data differently, publish an accurate deployment-specific policy instead. Use your own support email, not someone else's.

### Can GitHub be the homepage?

Yes, GitHub repository and policy URLs can be saved for a personal app, and publishing the app is separate from having Google verify it. Registering `github.com` as an authorized domain does **not** establish ownership of that domain or guarantee verification.

For an app that needs Google verification, host the homepage and privacy policy on a domain you own and can verify in Google Search Console. Google's [brand verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification) require the privacy policy on the same domain as the homepage. The homepage must describe the app and link to its privacy policy. A generic link to this repository is not a substitute for those verification requirements.

## 3. Publish the app

Open [Google Auth Platform → Audience](https://console.cloud.google.com/auth/audience). For a personal Google account, choose **External**. Select **Publish app**, confirm, and check that the publishing status reads **In production**.

**In production does not mean verified.** Google's [personal-use exception](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification#personal-use) covers an app used only by you or a few people you know personally. Such users may still see an unverified-app warning, and an unverified app has a user cap. Do not treat this exception as approval to distribute a public, multi-user service. If your app requires verification, declare its actual requested scopes in **Data Access** and follow Google's verification process.

## 4. Authorize after publishing

Once the app is in production, run this on the machine hosting the MCP server:

```bash
npx -y google-tools-mcp@latest auth
```

Open the printed Google authorization URL if the browser does not open automatically. Choose the intended account, review the requested access, and grant the permissions needed by the server. If you see an unverified-app warning, proceed only if this is the OAuth client you created and trust.

The flow requests offline access and saves a refresh token. Reauthorize after publishing rather than relying on a token issued while the app was in Testing. In [Testing](https://support.google.com/cloud/answer/15549945?hl=en), authorizations and refresh tokens for these Workspace scopes expire after seven days. Production removes that Testing-specific limit; tokens can still expire or be revoked for [other reasons](https://developers.google.com/identity/protocols/oauth2#expiration).

If the server and browser are on different machines, follow the [remote OAuth tunnel guide](remote-oauth-tunnel.md). Keep the callback listener private; do not publish it on the internet.

## 5. Check the connection

Start the server from your MCP client and make a read-only call, such as `getProfile` or `listCalendars`. Restart the MCP server process and repeat the call to confirm saved authorization works without browser consent. Tool discovery alone does not test Google authorization.

If access fails, check the selected Google account, enabled APIs and granted permissions. For `invalid_grant`, run the authorization command again. Keep credentials and stored Google data private, and use the revocation and deletion controls described in the [privacy policy](../PRIVACY.md).
