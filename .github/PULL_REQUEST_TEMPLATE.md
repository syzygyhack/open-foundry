## What and why

<!-- What changes, and the problem it solves. Link any issue: Fixes #123 -->

## How it was verified

<!--
Commands run and their result. For a bug fix, the strongest signal is a test
that fails without the fix — please say if you confirmed that.
-->

- [ ] `pnpm run build`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run test`
- [ ] Integration / enforcement E2E (if the change touches auth, authz, consent, or deployment)

## Checklist

- [ ] Tests added or updated
- [ ] Docs updated in this PR if behaviour or configuration changed
- [ ] Security-relevant defaults remain **fail-closed** (no permissive fallback when config is unset)
- [ ] No hardcoded test/line counts added to docs
