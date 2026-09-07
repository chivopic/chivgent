import assert from "node:assert";
import { sum } from "./sum.js";

assert.strictEqual(sum([1, 2, 3]), 6);
assert.strictEqual(sum([]), 0);
assert.strictEqual(sum([5]), 5);
console.log("all tests passed");
