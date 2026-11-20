const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const https = require('https');

function mockRequests(t, responses) {
    const calls = [];
    t.mock.method(https, 'get', (url, options, callback) => {
        const next = responses.shift();
        assert.ok(next, `Unexpected request: ${url}`);
        calls.push({ url: String(url), headers: options.headers });
        const req = new EventEmitter();
        req.setTimeout = () => req;
        req.destroy = error => req.emit('error', error);
        process.nextTick(() => {
            const body = Buffer.isBuffer(next.body) ? next.body : JSON.stringify(next.body);
            const res = Readable.from([body]);
            res.statusCode = next.status || 200;
            res.headers = next.headers || {};
            callback(res);
        });
        return req;
    });
    t.after(() => assert.equal(responses.length, 0, 'Unused mock responses'));
    return calls;
}

module.exports = { mockRequests };
