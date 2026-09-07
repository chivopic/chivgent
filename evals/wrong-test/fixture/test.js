const assert = require("node:assert");
const { slug } = require("./slug.js");

assert.strictEqual(slug("Hello World"), "hello-world");
assert.strictEqual(slug("  Hello   World  "), "--hello---world--");

console.log("ok");
