# One-time setup

Run these yourself, in a normal terminal at the repo root. Agents are blocked from most of
them on purpose. Every block below is self-contained: it sets the variables it uses, so it
works in a fresh terminal.

## 0. Prerequisites

```bash
brew install age gh awscli jq
npm ci
gh auth login
# Sign in with an IAM Identity Center admin profile. Never use the root user.
aws configure sso --profile egm-admin
aws sso login --profile egm-admin
```

## 1. AWS

Run this in a normal terminal, not through Claude Code's `!` prefix: `cdk deploy` stops for
interactive approval of the IAM changes.

```bash
export AWS_PROFILE=egm-admin AWS_REGION=ap-southeast-1
aws sts get-caller-identity          # must show the SSO admin role, not root
ACCT=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap "aws://$ACCT/$AWS_REGION"
npm run build                        # the CDK app also synthesizes the app stacks, which need web/dist
npx cdk deploy -a "npx tsx infra/bin/app.ts" egm-github-oidc
# If the account already has a GitHub OIDC provider, add:
#   -c githubOidcProviderArn=arn:aws:iam::$ACCT:oidc-provider/token.actions.githubusercontent.com
```

## 2. GitHub environments (deploys from main only)

```bash
export AWS_PROFILE=egm-admin AWS_REGION=ap-southeast-1
R=buinguyenphuongthao/google-egm-demo
ROLE=$(aws cloudformation describe-stacks --stack-name egm-github-oidc \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text)
for env in staging prod; do
  gh api -X PUT repos/$R/environments/$env --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
  gh api -X POST repos/$R/environments/$env/deployment-branch-policies -f name=main
  gh variable set AWS_DEPLOY_ROLE_ARN --repo $R --env $env --body "$ROLE"
  gh variable set AWS_REGION --repo $R --env $env --body "$AWS_REGION"
done
```

## 3. Claude token

```bash
R=buinguyenphuongthao/google-egm-demo
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo $R   # paste when prompted; never paste it into chat
```

## 4. Audit encryption key

Already done for this repo: `.github/audit-recipient.txt` is committed and reaches `main`
with the first PR. To create a key pair (first setup or rotation):

```bash
mkdir -p ~/.config/egm && age-keygen -o ~/.config/egm/audit-key.txt
age-keygen -y ~/.config/egm/audit-key.txt > .github/audit-recipient.txt
git add .github/audit-recipient.txt && git commit -m "chore: add audit report recipient"
# then open a PR; the recipient takes effect once it is on main
```

Back up `~/.config/egm/audit-key.txt` somewhere safe. Never commit it.

To read a report: download the `security-audit-report` artifact, then
`age -d -i ~/.config/egm/audit-key.txt report.tar.gz.age | tar xz`.

## 5. Require approval for external contributors' workflow runs

Already applied. This keeps fork PRs from running any workflow until a maintainer approves.

```bash
R=buinguyenphuongthao/google-egm-demo
gh api -X PUT repos/$R/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_contributors
gh api repos/$R/actions/permissions/fork-pr-contributor-approval   # verify
```

## 6. Branch protection (after the first PR has run once, so the check names exist)

`enforce_admins: true` means the maintainer cannot merge around a red check either.

```bash
R=buinguyenphuongthao/google-egm-demo
gh api -X PUT repos/$R/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["build", "e2e", "code-review", "security-audit"] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

### Emergency: a gate itself is broken

If a required check cannot pass because the gate is broken (not because the change is bad),
an admin can lift admin enforcement, merge the fix, and restore it immediately:

```bash
R=buinguyenphuongthao/google-egm-demo
gh api -X DELETE repos/$R/branches/main/protection/enforce_admins
# merge the reviewed fix PR, then restore:
gh api -X POST repos/$R/branches/main/protection/enforce_admins
```

## Fork PRs

Fork PRs get no secrets, so `code-review` and `security-audit` fail closed on them. To run
the gated CI:

1. Review the whole diff yourself first, line by line for gate paths: `.github/`, `.claude/`,
   any `CLAUDE.md`, `.mcp.json`, and `docs/threat-model.md`. A PR runs its own copy of the
   gates, so a change there can make the checks lie.
2. Push it to a branch in this repo and open a PR from that branch:

```bash
R=buinguyenphuongthao/google-egm-demo
PR=123   # the fork PR number
gh pr diff $PR --repo $R
gh pr checkout $PR --repo $R --branch fork-pr-$PR
git push origin fork-pr-$PR
gh pr create --repo $R --base main --head fork-pr-$PR --title "Fork PR #$PR" --body "From #$PR"
```

## Deploy failures and rollback

If prod smoke fails, `deploy.yml` redeploys the commit at tag `prod-good`, which moves only
after a successful prod smoke run. The first prod deploy has no `prod-good` yet, so a failure
there cannot roll back: the rollback job fails at checkout. Fix forward with a new PR.

## Owner-only access

Both environments are meant to be reachable only from the owner's IP addresses, plus CI smoke
tests carrying a secret token. Each stack has a CloudFront KeyValueStore (stack output
`AccessStoreArn`) holding `ip:<address>` keys and a `smoke-token` key. `npm run access`
manages it; nothing in the repo or CI writes to it. Your IP never enters git or CI logs.

Prerequisites: AWS CLI v2, `gh` logged in with admin access to this repo, and the
`egm-admin` profile (`aws sso login --profile egm-admin`). Set `AWS_PROFILE` to use another.

```bash
npm run access -- allow-me                     # add your current public IPv4 to both environments
npm run access -- list                         # show allowed IPs; the token shows only as "(set)"
npm run access -- remove 203.0.113.7           # remove an IP from both environments
npm run access -- rotate-smoke-token staging   # new token in GitHub and the store; never printed
npm run access -- rotate-smoke-token prod
```

Run `allow-me` again whenever your IP changes (new network, router restart). Changes take
effect within seconds; no deploy needed. Only IPv4 is allowlisted.

### First-time seeding

The stores start empty. Once the edge lock is on, an empty store blocks everyone, including
the smoke tests. So after the deploy that creates the stores, and before the lock ships:

```bash
npm run access -- allow-me
npm run access -- rotate-smoke-token staging
npm run access -- rotate-smoke-token prod
npm run access -- list   # both environments: your ip:<address> and smoke-token (set)
```

### API origin secret

CloudFront sends a generated Secrets Manager value (`OriginVerifySecret`) in the
`x-origin-verify` header, and the API Lambda rejects requests without it, so the raw
`execute-api` URL is unusable. Never rotate this secret in place: the Lambda would pick up the
new value on its next deploy while CloudFront kept the old one, and every API call would
return 403. To rotate, change the construct id in `infra/lib/app-stack.ts` and deploy.
