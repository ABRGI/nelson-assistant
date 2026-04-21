import express, { type Response } from 'express';
import type { App } from '@slack/bolt';
import type { UserBindingStore } from './binding.js';
import { CognitoExchanger, NelsonLoginFailed } from './cognito.js';
import type { NonceStore, PendingAuth } from './nonce.js';
import { logger } from '../observability/logger.js';

export interface WebAuthDeps {
  nonces: NonceStore;
  bindings: UserBindingStore;
  cognito: CognitoExchanger;
  slack: App;
  displayName: string;
}

/**
 * Authority boundary: the browser supplies only a nonce (path param) and the
 * Nelson username+password (form body). Nothing else. The Slack user id is
 * bound at nonce-creation time, so even if the URL leaks, the attacker can
 * only ever affect that specific Slack user's binding — not impersonate.
 *
 * Auth is global: one Cognito pool issues JWTs trusted by every tenant's
 * Nelson API, so the login page does not know or care about tenants.
 */
export function buildAuthRouter(deps: WebAuthDeps): express.Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '8kb' }));

  router.get('/auth/login/:nonce', async (req, res) => {
    setCommonHeaders(res);
    const pending = await deps.nonces.get(req.params.nonce);
    if (!pending) {
      renderExpired(res);
      return;
    }
    renderForm(res, {
      nonce: pending.nonce,
      displayName: deps.displayName,
      attemptsRemaining: attemptsLeft(pending),
    });
  });

  router.post('/auth/login/:nonce', async (req, res) => {
    setCommonHeaders(res);
    const pending = await deps.nonces.get(req.params.nonce);
    if (!pending) {
      renderExpired(res);
      return;
    }

    const { username, password } = parseBody(req.body);
    if (!username || !password) {
      renderForm(res, {
        nonce: pending.nonce,
        displayName: deps.displayName,
        attemptsRemaining: attemptsLeft(pending),
        error: 'Username and password are required.',
      });
      return;
    }

    try {
      const tokens = await deps.cognito.loginViaNelsonApi(username, password);
      await deps.bindings.upsert({
        slackUserId: pending.slackUserId,
        nelsonUsername: username,
        nelsonSub: tokens.nelsonSub,
        refreshToken: tokens.refreshToken,
      });
      deps.cognito.invalidateCache(pending.slackUserId);
      await deps.nonces.consume(pending.nonce);
      await notifySlack(deps.slack, pending.slackUserId, deps.displayName, username);
      logger.info(
        { slackUserId: pending.slackUserId },
        'nelson-auth succeeded via web flow',
      );
      renderSuccess(res, deps.displayName, username);
      return;
    } catch (err) {
      if (err instanceof NelsonLoginFailed) {
        await deps.nonces.recordAttempt(pending.nonce);
        const after = await deps.nonces.get(pending.nonce);
        if (!after) {
          renderError(res, 'Too many failed attempts. Run `/nelson-auth` in Slack again to get a new link.');
          return;
        }
        renderForm(res, {
          nonce: after.nonce,
          displayName: deps.displayName,
          attemptsRemaining: attemptsLeft(after),
          error: 'Login failed. Check your Nelson username and password.',
        });
        return;
      }
      logger.error(
        { err, slackUserId: pending.slackUserId },
        'unexpected error during web auth',
      );
      renderError(res, 'Something went wrong. Try again in a minute or ping an admin.');
    }
  });

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  return router;
}

function parseBody(raw: unknown): { username: string; password: string } {
  if (typeof raw !== 'object' || raw === null) return { username: '', password: '' };
  const rec = raw as Record<string, unknown>;
  return {
    username: typeof rec.username === 'string' ? rec.username.trim() : '',
    password: typeof rec.password === 'string' ? rec.password : '',
  };
}

function attemptsLeft(pending: PendingAuth, max = 3): number {
  return Math.max(0, max - pending.attempts);
}

function setCommonHeaders(res: Response): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}

function renderForm(
  res: Response,
  args: {
    nonce: string;
    displayName: string;
    attemptsRemaining: number;
    error?: string;
  },
): void {
  const error = args.error ? `<p class="err">${escapeHtml(args.error)}</p>` : '';
  const attempts =
    args.attemptsRemaining < 3
      ? `<p class="meta">${args.attemptsRemaining} attempt${args.attemptsRemaining === 1 ? '' : 's'} remaining before this link is invalidated.</p>`
      : '';
  res.status(200).type('html').send(htmlShell(
    `Sign in to ${escapeHtml(args.displayName)}`,
    `
<h1>Sign in to ${escapeHtml(args.displayName)}</h1>
<p class="meta">Your credentials go directly to Nelson — this page only forwards them and is never stored in Slack.</p>
${error}
<form method="POST" action="/auth/login/${encodeURIComponent(args.nonce)}" autocomplete="on">
  <label>Nelson username<input type="text" name="username" autocomplete="username" required autofocus /></label>
  <label>Password<input type="password" name="password" autocomplete="current-password" required /></label>
  <button type="submit">Sign in &amp; link Slack</button>
</form>
${attempts}
    `,
  ));
}

function renderSuccess(res: Response, displayName: string, username: string): void {
  res.status(200).type('html').send(htmlShell(
    'Linked',
    `
<h1>You're linked</h1>
<p>Slack is now linked to <strong>${escapeHtml(username)}</strong> on <strong>${escapeHtml(displayName)}</strong>.</p>
<p>You can close this tab and return to Slack.</p>
    `,
  ));
}

function renderExpired(res: Response): void {
  res.status(410).type('html').send(htmlShell(
    'Link expired',
    `
<h1>This link has expired</h1>
<p>Run <code>/nelson</code> in Slack (or <code>/nelson-auth</code>) to get a new one.</p>
    `,
  ));
}

function renderError(res: Response, message: string): void {
  res.status(400).type('html').send(htmlShell(
    'Something went wrong',
    `
<h1>Something went wrong</h1>
<p>${escapeHtml(message)}</p>
    `,
  ));
}

function htmlShell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)} — Nelson Assistant</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
  label { display: block; margin: 0.75rem 0; font-size: 0.9rem; }
  input { display: block; width: 100%; margin-top: 0.25rem; padding: 0.55rem 0.7rem; font-size: 1rem; border-radius: 6px; border: 1px solid #8887; box-sizing: border-box; }
  button { margin-top: 0.5rem; padding: 0.6rem 1rem; font-size: 1rem; border-radius: 6px; border: 0; background: #2563eb; color: white; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .meta { color: #666; font-size: 0.85rem; }
  .err { color: #b91c1c; background: #fee2e2; padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.9rem; }
  code { background: #8882; padding: 0 0.25rem; border-radius: 3px; }
</style>
</head>
<body>${inner}</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function notifySlack(
  app: App,
  slackUserId: string,
  displayName: string,
  nelsonUsername: string,
): Promise<void> {
  try {
    const im = await app.client.conversations.open({ users: slackUserId });
    const channel = im.channel?.id;
    if (!channel) return;
    await app.client.chat.postMessage({
      channel,
      text: `:white_check_mark: Linked to *${displayName}* as *${nelsonUsername}*. If that wasn't you, run \`/nelson-auth\` to replace this binding.`,
    });
  } catch (err) {
    logger.warn({ err, slackUserId }, 'failed to DM user after successful auth');
  }
}
