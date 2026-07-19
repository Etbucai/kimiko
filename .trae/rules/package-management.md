新增或变更第三方依赖时，必须通过 `pnpm-workspace.yaml` 的 `catalog` 统一管理版本；各 workspace package 的 `package.json` 里应使用 `catalog:` 引用该依赖。仅 `workspace:*` 等本仓库内部包引用不适用此规则。
