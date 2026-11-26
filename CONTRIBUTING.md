# Contributing to PaceUp

Thanks for helping build PaceUp.

## Before you start

1. Read the [product definition](docs/PRODUCT.md) and [architecture](docs/ARCHITECTURE.md).
2. Search existing issues before opening a new one.
3. For substantial changes, open an issue first so the proposed direction can be discussed.

## Development workflow

1. Fork the repository and create a focused branch from `main`.
2. Keep each pull request limited to one logical change.
3. Include a clear description of the problem and the chosen solution.
4. Add or update tests when behaviour changes.
5. Update documentation when product behaviour, configuration, or architecture changes.
6. Open a pull request against `main`.
7. Add a `Changelog:` line to the description: one plain-English sentence on what users will notice. It goes into [CHANGELOG.md](CHANGELOG.md) automatically when the PR is merged (the PR title is used if the line is missing; `Changelog: none` skips it).

## Pull request checklist

- [ ] The change has a clear purpose and scope.
- [ ] Existing behaviour is preserved unless the change intentionally updates it.
- [ ] Tests have been added or updated where appropriate.
- [ ] Documentation has been updated where needed.
- [ ] No secrets, credentials, personal data, or generated build artefacts are included.

## Issues

Use GitHub Issues for bugs, feature proposals, and questions. Include reproducible steps for bugs and explain the user problem behind feature requests.

## Community

Be respectful, constructive, and welcoming. Critique ideas and code, never people.
