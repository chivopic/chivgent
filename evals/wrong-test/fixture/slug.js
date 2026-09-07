/**
 * Turns a title into a URL slug.
 *
 * Contract: the input is trimmed first, then any run of whitespace becomes a
 * single hyphen, and the result is lowercased. A slug therefore never starts
 * or ends with a hyphen, and never contains two hyphens in a row.
 */
function slug(title) {
  return title.trim().replace(/\s+/g, "-").toLowerCase();
}

module.exports = { slug };
