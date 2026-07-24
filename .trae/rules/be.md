---
alwaysApply: false
globs: packages/server/src/**/*
---

服务端代码在可能出现异常的链路都要加上日志，尤其是外部服务调用、数据库写入、异步任务、实时连接、生成编排、catch 分支和错误码映射边界。

日志应使用 NestJS `Logger` 或项目既有日志设施，记录可定位问题的结构化上下文，例如 requestId、userId、storylineId、操作模式、阶段、错误名、错误 message 和 stack。

不要在日志中输出敏感信息、access token、密码、完整 prompt、完整正文或其它大段用户内容。
