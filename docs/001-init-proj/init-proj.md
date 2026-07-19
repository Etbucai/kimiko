# 初始化项目

包含三个包:

1. @kimiko/utils
2. @kimiko/schema
3. @kimiko/server
4. @kimiko/web

## 基础说明

- 通过 pnpm workspace 进行多包管理
- 采取激进策略使用 pnpm 中的高级依赖管理功能，如 catalog、hoist 等
- 每个包都需要 eslint, prettier, typescript，但放在根目录下全局配置还是每个包单独配置，你来决定

## @kimiko/utils

- 提供一些基础的工具函数，如日期格式化、随机数生成等
- 用于在其他包中共享的工具函数
- 依赖关系:
  - 无

## @kimiko/schema

- 提供一些基础的 JSON Schema 定义，用于验证和处理 JSON 数据
- 使用 zod 库进行 JSON 数据验证和解析
- 依赖关系:
  - 无

## @kimiko/server

- 提供一个基于 nestjs 的 HTTP 服务器，用于处理请求和响应
- 依赖关系:
  - @kimiko/utils
  - @kimiko/schema

## @kimiko/web

- 提供一个基于 React 的 Web 应用，用于展示和交互数据
- 依赖关系:
  - @kimiko/utils
  - @kimiko/schema
