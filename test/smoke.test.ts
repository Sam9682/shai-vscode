import * as assert from 'assert';
import fc from 'fast-check';

describe('test harness smoke', () => {
  it('runs a trivial passing test', () => {
    assert.strictEqual(1 + 1, 2);
  });

  it('runs a trivial fast-check property', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a),
      { numRuns: 100 }
    );
  });
});
