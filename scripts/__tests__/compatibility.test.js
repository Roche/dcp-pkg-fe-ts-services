const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const tar = require('tar');
const { name, version } = require('../../package.json');
const { createPackageSource } = require('../check-compatibility');
const { downloadAndExtractTesting } = require('../compatibility');
const { parseCompatibilityResults } = require('../generate-version');
const { mockRequests } = require('./helpers');

async function createArchive(t, withTests = true) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'services-compatibility-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const testsDirectory = path.join(directory, 'package/src/store/__tests__');
    fs.mkdirSync(testsDirectory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package/src/store/store.ts'), 'implementation');
    if (withTests) {
        fs.writeFileSync(path.join(testsDirectory, 'store.test.ts'), 'test');
        fs.writeFileSync(path.join(testsDirectory, 'fixture.json'), '{}');
    }
    const chunks = [];
    for await (const chunk of tar.c({ cwd: directory, gzip: true }, ['package'])) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function loadRunnerWithMockedJest(t, implementation) {
    t.mock.method(childProcess, 'execFileSync', implementation);
    delete require.cache[require.resolve('../compatibility')];
    t.after(() => delete require.cache[require.resolve('../compatibility')]);
    return require('../compatibility');
}

function captureLogsAndArgs(t, requestedVersion) {
    const previousArgv = process.argv;
    process.argv = [process.execPath, 'check-compatibility.js', ...(requestedVersion ? [requestedVersion] : [])];
    t.after(() => {
        process.argv = previousArgv;
    });
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    return logs;
}

test('npm selects the 20 most recently published versions, including prereleases', async t => {
    const versions = {};
    const time = {};
    for (let index = 0; index < 23; index++) {
        const value = `1.0.0-alpha.${index}`;
        versions[value] = { dist: { tarball: `https://registry.npmjs.org/services-${index}.tgz` } };
        time[value] = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
    }
    const calls = mockRequests(t, [{ body: { versions, time } }, { body: { versions, time } }]);
    const source = createPackageSource();
    const packages = await source.listPackages();
    assert.equal(packages.length, 20);
    assert.equal(packages[0].version, '1.0.0-alpha.22');
    assert.equal(packages[19].version, '1.0.0-alpha.3');
    assert.equal(await source.getTarballUrl(packages[0]), versions[packages[0].version].dist.tarball);
    assert.deepEqual(await source.listPackages('1.0.0-alpha.0'), [{
        version: '1.0.0-alpha.0',
        tarballUrl: versions['1.0.0-alpha.0'].dist.tarball
    }]);
    assert.equal(calls[0].url, `https://registry.npmjs.org/${encodeURIComponent(name)}`);
    assert.deepEqual(calls[0].headers, {});
});

test('only an npm metadata 404 is treated as no published history', async t => {
    mockRequests(t, [
        { status: 404, body: { error: 'Not found' } },
        { status: 503, body: { error: 'Unavailable' } },
        { body: {} }
    ]);
    const source = createPackageSource();
    assert.deepEqual(await source.listPackages(), []);
    await assert.rejects(source.listPackages(), /503/);
    await assert.rejects(source.listPackages(), /invalid package metadata/);
});

test('extracts historical tests and fixtures, but not the old implementation', async t => {
    const archive = await createArchive(t);
    mockRequests(t, [{ body: archive }]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'services-extraction-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const tests = await downloadAndExtractTesting('https://registry.npmjs.org/package.tgz', {}, directory);
    assert.deepEqual(tests, [path.join(directory, 'package/src/store/__tests__/store.test.ts')]);
    assert.ok(fs.existsSync(path.join(directory, 'package/src/store/__tests__/fixture.json')));
    assert.equal(fs.existsSync(path.join(directory, 'package/src/store/store.ts')), false);
});

test('empty historical test sets are distinct from failed downloads and corrupt archives', async t => {
    const archive = await createArchive(t, false);
    mockRequests(t, [{ body: archive }, { status: 404, body: {} }, { body: Buffer.from('not a tarball') }]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'services-extraction-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    assert.deepEqual(await downloadAndExtractTesting('https://registry.npmjs.org/package.tgz', {}, directory), []);
    await assert.rejects(
        downloadAndExtractTesting('https://registry.npmjs.org/package.tgz', {}, directory),
        /404/
    );
    await assert.rejects(downloadAndExtractTesting('https://registry.npmjs.org/package.tgz', {}, directory));
});

test('historical Jest invocations select only the extracted version, without shell interpolation', t => {
    const calls = [];
    const runner = loadRunnerWithMockedJest(t, (...args) => calls.push(args));
    const testPaths = ['/tmp/example/package/src/__tests__/store.test.ts'];
    assert.equal(runner.runTests(testPaths), 'compatible');
    assert.deepEqual(calls[0][1].slice(1), ['--runInBand', '--runTestsByPath', ...testPaths]);
    runner.runTests();
    assert.deepEqual(calls[1][1].slice(1), ['--runInBand', '--testPathIgnorePatterns', '/tmp_version_testing/']);
});

test('Jest test failures mean incompatible, while process errors propagate', t => {
    let status = 1;
    const runner = loadRunnerWithMockedJest(t, () => {
        throw Object.assign(new Error('Jest failed'), { status });
    });
    assert.equal(runner.runTests(['/tmp/store.test.ts']), 'incompatible');
    status = null;
    assert.throws(() => runner.runTests(), /Jest failed/);
});

test('first public release runs current tests and emits current-version compatibility', async t => {
    const logs = captureLogsAndArgs(t);
    mockRequests(t, [{ status: 404, body: {} }]);
    let invocations = 0;
    const runner = loadRunnerWithMockedJest(t, () => { invocations++; });
    await runner.runCompatibility(createPackageSource());
    assert.equal(invocations, 1);
    assert.ok(logs.includes(`COMPATIBILITY_RESULTS_JSON=${JSON.stringify({ [version]: 'compatible' })}`));
});

test('historical checks warn and skip missing tests, continue testing, and clean up extracted tests', async t => {
    const logs = captureLogsAndArgs(t);
    const warnings = [];
    t.mock.method(console, 'warn', message => warnings.push(message));
    const archive = await createArchive(t);
    const emptyArchive = await createArchive(t, false);
    mockRequests(t, [
        { body: {
            versions: {
                '1.0.0': { dist: { tarball: 'https://registry.npmjs.org/old.tgz' } },
                '1.1.0': { dist: { tarball: 'https://registry.npmjs.org/new.tgz' } },
                '0.0.1': { dist: { tarball: 'https://registry.npmjs.org/untested.tgz' } }
            },
            time: { '1.0.0': '2026-01-01', '1.1.0': '2026-02-01', '0.0.1': '2026-01-15' }
        } },
        { body: archive },
        { body: emptyArchive },
        { body: archive }
    ]);
    const paths = [];
    const runner = loadRunnerWithMockedJest(t, (command, args) => {
        const index = args.indexOf('--runTestsByPath');
        if (index !== -1) {
            const [testPath] = args.slice(index + 1);
            assert.ok(fs.existsSync(testPath));
            paths.push(testPath);
            if (paths.length === 2) {
                throw Object.assign(new Error('Historical tests failed'), { status: 1 });
            }
        }
    });
    await runner.runCompatibility(createPackageSource());
    assert.equal(paths.length, 2);
    assert.notEqual(paths[0], paths[1]);
    assert.ok(paths.every(testPath => !fs.existsSync(testPath)));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Skipping compatibility check.*0\.0\.1 contains no historical tests/);
    assert.ok(logs.includes(`COMPATIBILITY_RESULTS_JSON=${JSON.stringify({
        [version]: 'compatible', '1.1.0': 'compatible', '0.0.1': 'untested', '1.0.0': 'incompatible'
    })}`));
});

test('explicitly requesting a release without historical tests fails without a success payload', async t => {
    const logs = captureLogsAndArgs(t, '0.0.1');
    const archive = await createArchive(t, false);
    mockRequests(t, [{ body: archive }]);
    const runner = loadRunnerWithMockedJest(t, () => assert.fail('Jest must not run without historical tests'));
    await assert.rejects(runner.runCompatibility({
        headers: {},
        async listPackages() { return [{ version: '0.0.1' }]; },
        async getTarballUrl() { return 'https://registry.npmjs.org/untested.tgz'; }
    }), /Version 0\.0\.1 contains no historical tests/);
    assert.equal(logs.some(line => line.startsWith('COMPATIBILITY_RESULTS_JSON=')), false);
});

test('current failures and missing requested versions abort without a success payload', async t => {
    const logs = captureLogsAndArgs(t);
    mockRequests(t, [{ status: 404, body: {} }, { status: 404, body: {} }]);
    const runner = loadRunnerWithMockedJest(t, () => {
        throw Object.assign(new Error('Current tests failed'), { status: 1 });
    });
    await assert.rejects(runner.runCompatibility(createPackageSource()), /Current tests failed/);
    process.argv.push('9.9.9');
    await assert.rejects(runner.runCompatibility(createPackageSource()), /No published package found/);
    assert.equal(logs.some(line => line.startsWith('COMPATIBILITY_RESULTS_JSON=')), false);
});

test('version generation accepts untested historical results but rejects stale/error-shaped output', () => {
    const output = results => `logs\nCOMPATIBILITY_RESULTS_JSON=${JSON.stringify(results)}\n`;
    const results = { [version]: 'compatible', '1.0.0': 'incompatible', '0.0.1': 'untested' };
    assert.deepEqual(parseCompatibilityResults(output(results)), results);
    for (const invalid of [{}, [], null, { [version]: 'error' }, { [version]: 'incompatible' }, { [version]: 'untested' }, { '1.0.0': 'compatible' }]) {
        assert.throws(() => parseCompatibilityResults(output(invalid)));
    }
    assert.throws(() => parseCompatibilityResults('no marker'), /did not emit results/);
});

test('failed checks leave the existing version file untouched', t => {
    const versionFile = path.resolve(__dirname, '../../src/version.ts');
    const original = fs.readFileSync(versionFile, 'utf8');
    t.mock.method(childProcess, 'execFileSync', () => { throw new Error('Registry unavailable'); });
    delete require.cache[require.resolve('../generate-version')];
    t.after(() => delete require.cache[require.resolve('../generate-version')]);
    const generator = require('../generate-version');
    assert.throws(() => generator.main(), /Registry unavailable/);
    assert.equal(fs.readFileSync(versionFile, 'utf8'), original);
});

test('successful generation writes only verified compatible versions', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'services-generation-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.mkdirSync(path.join(directory, 'src'));
    fs.copyFileSync(path.resolve(__dirname, '../generate-version.js'), path.join(directory, 'scripts/generate-version.js'));
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '2.0.0' }));
    fs.writeFileSync(path.join(directory, 'scripts/check-compatibility.js'),
        'console.log(\'COMPATIBILITY_RESULTS_JSON={"2.0.0":"compatible","v1.0.0":"compatible","1.1.0":"incompatible","0.0.1":"untested"}\');');
    childProcess.execFileSync(process.execPath, [path.join(directory, 'scripts/generate-version.js')], {
        env: { ...process.env, COMPATIBILITY_SCRIPT: '' }
    });
    assert.equal(fs.readFileSync(path.join(directory, 'src/version.ts'), 'utf8'),
        'export const VERSION = \'2.0.0\';\nexport const COMPATIBILITY = [\n  "2.0.0",\n  "1.0.0"\n];\n');
    fs.writeFileSync(path.join(directory, 'scripts/custom-checker.js'),
        'console.log(\'COMPATIBILITY_RESULTS_JSON={"2.0.0":"compatible"}\');');
    childProcess.execFileSync(process.execPath, [path.join(directory, 'scripts/generate-version.js')], {
        env: { ...process.env, COMPATIBILITY_SCRIPT: 'scripts/custom-checker.js' }
    });
    const customContent = fs.readFileSync(path.join(directory, 'src/version.ts'), 'utf8');
    assert.equal(customContent, 'export const VERSION = \'2.0.0\';\nexport const COMPATIBILITY = [\n  "2.0.0"\n];\n');
    assert.throws(() => childProcess.execFileSync(process.execPath, [path.join(directory, 'scripts/generate-version.js')], {
        env: { ...process.env, COMPATIBILITY_SCRIPT: 'scripts/missing-checker.js' },
        stdio: 'pipe'
    }));
    assert.equal(fs.readFileSync(path.join(directory, 'src/version.ts'), 'utf8'), customContent);
});
