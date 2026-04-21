Nelson Assistant is a Claude-powered teammate that lives in Slack and answers questions about Nelson. Ask it anything from your workspace — hotel availability, reservation details, booking trends, configuration lookups — and it acts as you, not as a shared service account. The first time you use it, the bot DMs you a one-time sign-in link so you can link your personal Nelson login; every subsequent API call goes through your own Cognito token, so Nelson's existing RBAC applies exactly as it would in the Management UI.

Usage:
• /nelson <question> — ask Nelson anything, anywhere in Slack
• /nelson-auth — force a fresh sign-in link (to switch accounts or refresh an expired session)
• /nelson-help — command reference

Safety:
• Your Nelson password is never entered in Slack. The sign-in link opens a local page; only your refresh token is stored, encrypted in AWS Secrets Manager.
• Destructive or high-risk requests (deletes, payment changes, production writes) are escalated to a named admin instead of executed.
• Every tool call is auditable and scoped to your Nelson permissions.

Built on Claude Agent SDK + Amazon Bedrock. Maintained by the Nelson platform team.
