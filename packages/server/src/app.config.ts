import type { INestApplication } from "@nestjs/common";

const CORS_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS";

export function configureApp(app: INestApplication): void {
  app.enableCors({
    methods: CORS_METHODS,
    origin: true,
  });
}
