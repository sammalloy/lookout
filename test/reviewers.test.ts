import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGlob, evaluateApprovals, normalizeConfig } from '@lookout/core';

test('glob matching', () => {
  assert.ok(matchGlob('design-system/Components/Button/**', 'design-system/Components/Button/Primary'));
  assert.ok(matchGlob('**/Button/*', 'checkout/Components/Button/Primary'));
  assert.ok(!matchGlob('design-system/Components/*', 'design-system/Components/Button/Primary'));
  assert.ok(matchGlob('checkout/**', 'checkout/Checkout/Summary/Default'));
});

test('per-rule approvals', () => {
  const { review } = normalizeConfig({
    reviewers: { default: ['@ds'], groups: { ds: ['alice', 'bob'] }, rules: [{ match: 'app/**', reviewers: ['carol'] }] },
  });
  const paths = ['ds/Button/Primary', 'app/Summary/Default'];
  assert.equal(evaluateApprovals(review, paths, [{ user: 'alice', verdict: 'approved' }]).approved, false);
  assert.equal(
    evaluateApprovals(review, paths, [
      { user: 'alice', verdict: 'approved' },
      { user: 'carol', verdict: 'approved' },
    ]).approved,
    true,
  );
  assert.equal(evaluateApprovals(review, [], []).approved, true);
  const blocked = evaluateApprovals(review, paths, [
    { user: 'alice', verdict: 'approved' },
    { user: 'carol', verdict: 'changes_requested' },
  ]);
  assert.equal(blocked.approved, false);
  assert.deepEqual(blocked.changesRequested, ['carol']);
});

test('modes are viewports x themes', () => {
  const { modes } = normalizeConfig({ modes: { viewports: [{ name: 'd', width: 100 }, { name: 'm', width: 50 }], themes: ['light', 'dark'] } });
  assert.deepEqual(modes.map(m => m.name), ['d-light', 'd-dark', 'm-light', 'm-dark']);
  assert.deepEqual(modes[1].globals, { theme: 'dark' });
});
