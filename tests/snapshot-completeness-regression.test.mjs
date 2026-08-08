import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourceUrl = new URL('../bilibili_follower_snapshot_public.js', import.meta.url);
const source = (await readFile(sourceUrl, 'utf8')).replaceAll('\r\n', '\n');

function extractFunction(name, nextMarker) {
  const startMarker = `  function ${name}`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(nextMarker, start);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${name} end must exist`);
  return source.slice(start, end).trim();
}

const completenessSource = extractFunction(
  'evaluateSnapshotCompleteness',
  '\n\n  function validateSnapshotForComparison'
);
const evaluateSnapshotCompleteness = new Function(
  `${completenessSource}; return evaluateSnapshotCompleteness;`
)();

test('marks only stable exact counts complete', () => {
  assert.deepEqual(
    evaluateSnapshotCompleteness({
      initialReportedTotal: 963,
      listEndpointReportedTotal: 963,
      finalReportedTotal: 963,
      exportedUniqueTotal: 963
    }),
    { reportedTotalsConsistent: true, complete: true }
  );
});

test('marks the observed 1065 reported and 1000 exported snapshot incomplete', () => {
  assert.deepEqual(
    evaluateSnapshotCompleteness({
      initialReportedTotal: 1065,
      listEndpointReportedTotal: 1065,
      finalReportedTotal: 1065,
      exportedUniqueTotal: 1000
    }),
    { reportedTotalsConsistent: true, complete: false }
  );
});

test('rejects over-coverage, total drift, and a missing total', () => {
  const cases = [
    {
      name: 'over-coverage',
      input: {
        initialReportedTotal: 963,
        listEndpointReportedTotal: 963,
        finalReportedTotal: 963,
        exportedUniqueTotal: 964
      },
      totalsConsistent: true
    },
    {
      name: 'total drift',
      input: {
        initialReportedTotal: 963,
        listEndpointReportedTotal: 964,
        finalReportedTotal: 964,
        exportedUniqueTotal: 964
      },
      totalsConsistent: false
    },
    {
      name: 'missing final total',
      input: {
        initialReportedTotal: 963,
        listEndpointReportedTotal: 963,
        finalReportedTotal: null,
        exportedUniqueTotal: 963
      },
      totalsConsistent: false
    }
  ];

  for (const fixture of cases) {
    const result = evaluateSnapshotCompleteness(fixture.input);
    assert.equal(result.complete, false, fixture.name);
    assert.equal(
      result.reportedTotalsConsistent,
      fixture.totalsConsistent,
      fixture.name
    );
  }
});

test('disables baseline import until the current snapshot is complete', () => {
  const enableSource = extractFunction(
    'enableExportButtons',
    "\n\n  ui.saveJson.addEventListener('click'"
  );

  function makeFixture(report) {
    const toggles = [];
    const ui = {
      saveJson: {},
      saveCsv: {},
      loadBaseline: {},
      loadBaselineLabel: {
        classList: {
          toggle(...args) {
            toggles.push(args);
          }
        }
      },
      saveCompareJson: {},
      saveCompareCsv: {}
    };
    const state = { report, comparison: null };
    const enableExportButtons = new Function(
      'ui',
      'state',
      `${enableSource}; return enableExportButtons;`
    )(ui, state);
    enableExportButtons();
    return { ui, toggles };
  }

  for (const report of [null, { complete: false }]) {
    const fixture = makeFixture(report);
    assert.equal(fixture.ui.loadBaseline.disabled, true);
    assert.deepEqual(fixture.toggles, [['disabled', true]]);
  }

  const completeFixture = makeFixture({ complete: true });
  assert.equal(completeFixture.ui.loadBaseline.disabled, false);
  assert.deepEqual(completeFixture.toggles, [['disabled', false]]);
});

test('bumps the report schema and records comparison confidence and validity', () => {
  assert.match(source, /reportVersion: 'public-2026-08-09-v1\.2'/);
  assert.match(
    source,
    /reportVersion: 'public-comparison-2026-08-09-v1\.1'/
  );
  assert.match(source, /confidence: 'high'/);
  assert.match(source, /rule: 'both-complete-same-target-exact-counts'/);
});
