# One-time setup

Run these yourself (in Claude Code, prefix with `!`). Agents are blocked from most of them on purpose.

## 1. AWS

```bash
aws login                      # or your usual SSO/profile
export AWS_REGION=<region>     # e.g. ap-northeast-1
npx cdk bootstrap
npm run build
npx cdk deploy -a "npx tsx infra/bin/app.ts" egm-github-oidc
# If the account already has a GitHub OIDC provider:
#   add -c githubOidcProviderArn=arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com
```

Note the `DeployRoleArn` output.

## 2. GitHub environments (deploys from main only)

```bash
R=buinguyenphuongthao/google-egm-demo
for env in staging prod; do
  gh api -X PUT repos/$R/environments/$env --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
  gh api -X POST repos/$R/environments/$env/deployment-branch-policies -f name=main
  gh variable set AWS_DEPLOY_ROLE_ARN --env $env --body <DeployRoleArn>
  gh variable set AWS_REGION --env $env --body <region>
done
```

## 3. Claude token

```bash
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN      # paste when prompted; never paste it into chat
```

## 4. Audit encryption key

```bash
mkdir -p ~/.config/egm && age-keygen -o ~/.config/egm/audit-key.txt
age-keygen -y ~/.config/egm/audit-key.txt > .github/audit-recipient.txt
git add .github/audit-recipient.txt && git commit -m "chore: add audit report recipient"
```

Back up `~/.config/egm/audit-key.txt` somewhere safe. Never commit it.

To read a report: download the `security-audit-report` artifact, then
`age -d -i ~/.config/egm/audit-key.txt report.tar.gz.age | tar xz`.

## 5. Branch protection (after the first PR has run once, so the check names exist)

```bash
gh api -X PUT repos/$R/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["build", "e2e", "code-review", "security-audit"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```
