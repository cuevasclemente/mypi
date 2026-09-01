---
name: authentik-forward-auth-deploy
description: Deploy self-hosted web apps behind Authentik forward auth with reverse-proxy routing, user/group access checks, environment configuration, and production smoke tests.
---

# Authentik Forward Auth Deploy

## Setup
- Identify the app, domain, reverse proxy (often Caddy/Nginx/Traefik), and Authentik outpost/provider.
- Know where production env/config lives, but do not read secret values.
- Confirm desired users/groups before changing access rules.

## Workflow
1. **Clarify access requirements**
   - Which users should authenticate? Are multiple household users sharing one app instance?
   - Should access be by Authentik group, email/domain, or explicit user list?
   - Should the app trust forward-auth headers for identity or only require authentication?

2. **Inspect deployment plan and current config**
   - Read project deployment docs and reverse-proxy config.
   - Find service command, port, environment variables, and health endpoint.
   - Identify Authentik provider/outpost URLs and header expectations.

3. **Configure reverse proxy**
   - Route the public hostname to the app service.
   - Add forward-auth middleware/directives for Authentik.
   - Preserve websocket and streaming headers if the app uses realtime sessions.
   - Pass identity headers only from the trusted proxy path.

4. **Configure Authentik access**
   - Add required users/groups to the application/provider policy.
   - Verify redirect/callback URLs match the deployed domain.
   - Avoid broad access changes without user confirmation.

5. **Deploy and validate**
   - Start or restart the app service.
   - Test unauthenticated redirect, authenticated load, websocket/API calls, and logout behavior.
   - Test every required user, not just the admin account.

## Validation checklist
- Public URL redirects to Authentik when unauthenticated.
- Approved users can access the same deployed app.
- Rejected users cannot access it.
- App logs show requests without leaking tokens.
- Streaming/websocket endpoints work through the proxy.

## Common pitfalls
- Forgetting websocket upgrade headers breaks agent/session UIs.
- Authentik user policy grants one user but not another (`raena` vs `ryan` style issue).
- App callback/allowed-origin settings mismatch the production hostname.
- Secret env vars are missing in the service environment but present in an interactive shell.

## Patterns from source sessions
- wayang and Saqi deployment sessions involved production setup behind Authentik.
- The user specifically asked to make another Authentik user access the same wayang instance.
- Production debugging often required reading deploy plans first, then making small config changes and smoke testing.