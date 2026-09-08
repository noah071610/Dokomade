# Conventional Commits

## Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

## Type

| type     | meaning                        |
| -------- | ------------------------------ |
| feat     | new feature                    |
| fix      | bug fix                        |
| docs     | documentation change           |
| style    | formatting (no logic change)   |
| refactor | refactoring                    |
| test     | add/update tests               |
| chore    | build, config, etc.            |
| perf     | performance improvement        |

## Examples

```
feat(auth): add OAuth2 login support
fix(api): handle null response from payment gateway
docs(readme): update installation steps
```

## Rules

- subject: lowercase start, no trailing period, imperative verb
- scope: optional (the module/area affected)
- body: explain *why* the change was made
