const { version } = require('../package.json');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseCompatibilityResults(output) {
    const marker = 'COMPATIBILITY_RESULTS_JSON=';
    const line = output
        .split(/\r?\n/)
        .map(value => value.trim())
        .find(value => value.startsWith(marker));

    if (!line) {
        throw new Error('Compatibility checker did not emit results.');
    }

    const results = JSON.parse(line.slice(marker.length));
    if (!results || typeof results !== 'object' || Array.isArray(results)
        || !Object.keys(results).length
        || Object.values(results).some(value => !['compatible', 'incompatible', 'untested'].includes(value))) {
        throw new Error('Compatibility checker returned invalid results.');
    }
    if (results[version] !== 'compatible') {
        throw new Error('Current version must pass its tests before generating compatibility metadata.');
    }
    return results;
}

function main() {
    console.log(`Generating version file for version: ${version}\n`);
    const checker = process.env.COMPATIBILITY_SCRIPT
        ? path.resolve(__dirname, '..', process.env.COMPATIBILITY_SCRIPT)
        : path.join(__dirname, 'check-compatibility.js');
    const output = execFileSync(process.execPath, [checker], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit'],
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env }
    });
    console.log(output);
    const results = parseCompatibilityResults(output);
    const compatibleVersions = Object.keys(results)
        .filter(key => results[key] === 'compatible')
        .map(key => key.startsWith('v') ? key.slice(1) : key);

    const versionFile = path.resolve(__dirname, '../src/version.ts');
    const content = `export const VERSION = '${version}';
export const COMPATIBILITY = ${JSON.stringify(compatibleVersions, null, 2)};
`;
    fs.writeFileSync(versionFile, content);
    console.log(`Wrote version and compatibility info to ${versionFile}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error('Version generation failed:', error);
        process.exitCode = 1;
    }
}

module.exports = { main, parseCompatibilityResults };
