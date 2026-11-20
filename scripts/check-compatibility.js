const { name } = require('../package.json');
const { MAXIMUM_VERSIONS, requestJson, runCli } = require('./compatibility');

const NPM_REGISTRY = 'https://registry.npmjs.org';

function createPackageSource() {
    return {
        headers: {},
        async listPackages(requestedVersion) {
            const metadata = await requestJson(`${NPM_REGISTRY}/${encodeURIComponent(name)}`, {}, true);
            if (!metadata) {
                return [];
            }
            if (!metadata.versions || !metadata.time) {
                throw new Error('npm registry returned invalid package metadata.');
            }
            const versions = requestedVersion
                ? Object.keys(metadata.versions).filter(value => value === requestedVersion)
                : Object.keys(metadata.versions)
                    .sort((a, b) => Date.parse(metadata.time[b]) - Date.parse(metadata.time[a]))
                    .slice(0, MAXIMUM_VERSIONS);
            return versions.map(value => ({
                version: value,
                tarballUrl: metadata.versions[value].dist.tarball
            }));
        },
        async getTarballUrl(pkg) {
            return pkg.tarballUrl;
        }
    };
}

if (require.main === module) {
    runCli(createPackageSource);
}

module.exports = { createPackageSource };
