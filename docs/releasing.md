# Releasing chivgent

This project publishes the `chivgent` CLI to npm. The first release is published manually; later releases should use npm Trusted Publishing through GitHub Actions so the repository does not need a long-lived npm write token.

## Before every release

From a clean checkout of `main`:

```bash
npm ci
npm run release:check
```

`release:check` type-checks the project, runs the test suite, builds `dist/`, and shows the npm tarball contents with `npm pack --dry-run`.

Confirm that `package.json` and `package-lock.json` contain the intended version and that the package name is still correct:

```bash
npm view chivgent version
```

For the first release, a registry 404 means the unscoped package does not exist yet. If an unrelated package already owns the name, stop and choose a new package name before publishing.

## First npm release

The package must exist on npm before its package settings can be used to configure Trusted Publishing.

1. Sign in with an npm account that can publish the package:

   ```bash
   npm login
   npm whoami
   ```

2. Run the release checks:

   ```bash
   npm run release:check
   ```

3. Publish the package:

   ```bash
   npm publish
   ```

   `publishConfig.access` keeps the package public. The `prepublishOnly` and `prepack` lifecycle scripts re-run validation and build the CLI before npm creates the package tarball.

4. Verify the published version:

   ```bash
   npm view chivgent version
   npm install -g chivgent
   chivgent --version
   ```

5. Create the matching GitHub tag and release, for example `v0.6.0`.

## Configure Trusted Publishing

After the first npm version exists, open the package settings on npm and configure a GitHub Actions Trusted Publisher with:

- GitHub organization/user: `chivopic`
- Repository: `chivgent`
- Workflow filename: `publish.yml`
- Environment: none
- Allowed action: `npm publish`

The workflow lives at `.github/workflows/publish.yml`. It uses a GitHub-hosted runner, Node.js 24, and `id-token: write` for OIDC. It deliberately does not use `NPM_TOKEN`.

Trusted Publishing requires npm CLI 11.5.1 or newer and Node.js 22.14.0 or newer in the publishing environment. The workflow uses Node.js 24 to satisfy those requirements. This does not change chivgent's runtime requirement of Node.js 20 or newer for users.

When Trusted Publishing is used from this public GitHub repository, npm automatically generates provenance attestations for the published public package.

Reference: https://docs.npmjs.com/trusted-publishers/

## Later releases

1. Update the version in `package.json` and `package-lock.json`, for example:

   ```bash
   npm version patch --no-git-tag-version
   ```

2. Run:

   ```bash
   npm run release:check
   ```

3. Commit the version bump through the normal PR flow and merge it to `main`.

4. In GitHub Actions, run **Publish npm package** from `main`.

5. Verify the version on npm, then create the matching GitHub tag and release (`vX.Y.Z`).

A package version cannot be overwritten on npm. If publishing fails after a version has already been released, bump to a new version rather than trying to reuse it.
