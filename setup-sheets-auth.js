/**
 * One-time setup script to authorize Google Sheets + Gmail access via OAuth 2.0.
 * Run: node setup-sheets-auth.js
 * It opens a browser, you approve, and it saves your refresh token to .env.
 *
 * Scopes:
 *   - spreadsheets (read/write): lead/case roster + weekly sentiment log
 *   - gmail.send: daily/weekly/monthly report emails (Gmail API over HTTPS)
 *
 * Re-run after scope changes and replace GOOGLE_REFRESH_TOKEN (revoke old access at
 * https://myaccount.google.com/permissions if Google returns no new refresh_token).
 */
require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const fs = require('fs');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT          = 3000;
const REDIRECT_URI  = `http://localhost:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.send',
];
const ENV_FILE      = '.env';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌  Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env first.\n');
  console.error('Steps:');
  console.error('  1. Go to https://console.cloud.google.com');
  console.error('  2. APIs & Services → Credentials → Create Credentials → OAuth client ID');
  console.error('  3. Application type: Desktop app  (NOT "Web application")');
  console.error('  4. Copy the Client ID and Client Secret into .env\n');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',      // forces refresh_token to always be returned
  scope: SCOPES,
});

console.log('\n══════════════════════════════════════════════════');
console.log('  Google Sheets — One-Time Authorization');
console.log('══════════════════════════════════════════════════');
console.log('\n1. Open this URL in your browser:\n');
console.log('   ' + authUrl);
console.log('\n2. Sign in and click Allow.');
console.log('3. You\'ll be redirected back here automatically.\n');

// Spin up a temporary local server to catch the OAuth callback
const server = http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);

  if (pathname !== '/callback') {
    res.writeHead(404);
    res.end();
    return;
  }

  if (query.error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h2>❌ Authorization failed: ${query.error}</h2><p>You can close this tab.</p>`);
    server.close();
    console.error('Authorization denied:', query.error);
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(query.code);

    if (!tokens.refresh_token) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h2>⚠️  No refresh token returned.</h2>
        <p>Go to <a href="https://myaccount.google.com/permissions">Google Account Permissions</a>,
        revoke access for this app, then run this script again.</p>`);
      server.close();
      console.error('\n⚠️  No refresh token returned. Revoke access at https://myaccount.google.com/permissions and try again.');
      process.exit(1);
    }

    // Write the refresh token into .env
    let envContent = fs.readFileSync(ENV_FILE, 'utf8');
    if (envContent.includes('GOOGLE_REFRESH_TOKEN=')) {
      envContent = envContent.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    } else {
      envContent += `\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
    }
    fs.writeFileSync(ENV_FILE, envContent, 'utf8');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h2 style="font-family:sans-serif;color:green">✅ Authorization complete!</h2>
      <p style="font-family:sans-serif">Refresh token saved to <strong>.env</strong>. You can close this tab.</p>`);

    console.log('\n✅  Refresh token saved to .env');
    console.log('    You can now run: node report.js\n');

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h2>❌ Error: ${err.message}</h2>`);
    console.error('Token exchange failed:', err.message);
  }

  server.close();
});

server.listen(PORT, () => {
  console.log(`Waiting for browser callback on http://localhost:${PORT} ...\n`);
});
