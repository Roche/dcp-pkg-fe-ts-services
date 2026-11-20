const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const https = require('https');
const { pipeline } = require('stream/promises');
const tar = require('tar');
const { version } = require('../package.json');

const MAXIMUM_VERSIONS = 20;
const projectRoot = path.resolve(__dirname, '..');

function request(url, headers = {}, allowNotFound = false, redirects = 0) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'https:') {
            reject(new Error(`Expected an HTTPS package URL: ${url}`));
            return;
        }

        const req = https.get(parsedUrl, { headers }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                res.resume();
                if (!res.headers.location || redirects >= 5) {
                    reject(new Error(`Invalid or excessive redirects from ${url}`));
                    return;
                }
                const nextUrl = new URL(res.headers.location, parsedUrl);
                const nextHeaders = nextUrl.origin === parsedUrl.origin ? headers : {};
                resolve(request(nextUrl.href, nextHeaders, allowNotFound, redirects + 1));
                return;
            }
            if (allowNotFound && res.statusCode === 404) {
                res.resume();
                resolve(null);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Package request failed (${res.statusCode}): ${url}`));
                return;
            }
            resolve(res);
        });
        req.setTimeout(30000, () => {
            req.destroy(new Error(`Package request timed out: ${url}`));
        });
        req.on('error', reject);
    });
}

async function requestJson(url, headers, allowNotFound) {
    const response = await request(url, headers, allowNotFound);
    if (!response) {
        return null;
    }
    let data = '';
    for await (const chunk of response) {
        data += chunk;
    }
    return JSON.parse(data);
}

function findTests(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return findTests(entryPath);
        }
        return entry.isFile() && entry.name.endsWith('.test.ts') ? [entryPath] : [];
    });
}

async function downloadAndExtractTesting(url, headers, directory) {
    const response = await request(url, headers);
    await pipeline(response, tar.x({
        cwd: directory,
        filter: entryPath => entryPath.startsWith('package/src/') && entryPath.split('/').includes('__tests__')
    }));
    return findTests(directory);
}

function runTests(testPaths) {
    try {
        execFileSync(process.execPath, [
            require.resolve('jest/bin/jest'),
            '--runInBand',
            ...(testPaths ? ['--runTestsByPath', ...testPaths] : ['--testPathIgnorePatterns', '/tmp_version_testing/'])
        ], { cwd: projectRoot, stdio: 'inherit' });
        return 'compatible';
    } catch (error) {
        if (error.status === 1) {
            return 'incompatible';
        }
        throw error;
    }
}

async function runCompatibility(source) {
    const requestedVersion = process.argv[2];
    const packages = await source.listPackages(requestedVersion);
    if (requestedVersion && !packages.length) {
        throw new Error(`No published package found for version ${requestedVersion}.`);
    }

    const results = {};
    if (!requestedVersion) {
        console.log('\nChecking compatibility for the current version...');
        results[version] = runTests();
        if (results[version] !== 'compatible') {
            throw new Error('Current tests failed. Compatibility metadata will not be generated.');
        }
    }
    if (!packages.length) {
        console.log('No published versions found; checking the current version only.');
    }

    const tempRoot = path.join(projectRoot, 'tmp_version_testing');
    fs.mkdirSync(tempRoot, { recursive: true });
    for (const pkg of packages) {
        const directory = fs.mkdtempSync(path.join(tempRoot, 'testing-'));
        try {
            const url = await source.getTarballUrl(pkg);
            const tests = await downloadAndExtractTesting(url, source.headers, directory);
            if (!tests.length) {
                const message = `Version ${pkg.version} contains no historical tests: ${url}`;
                if (requestedVersion) {
                    throw new Error(message);
                }
                console.warn(`Skipping compatibility check. ${message}`);
                results[pkg.version] = 'untested';
                continue;
            }
            console.log(`\nChecking compatibility for ${pkg.version}...`);
            results[pkg.version] = runTests(tests);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }

    console.log('\nCompatibility Results:');
    console.log(JSON.stringify(results, null, 2));
    console.log(`COMPATIBILITY_RESULTS_JSON=${JSON.stringify(results)}`);
}

async function runCli(createPackageSource) {
    try {
        await runCompatibility(createPackageSource());
    } catch (error) {
        console.error('Compatibility check failed:', error);
        process.exitCode = 1;
    }
}

module.exports = { MAXIMUM_VERSIONS, requestJson, downloadAndExtractTesting, runCompatibility, runCli, runTests };
